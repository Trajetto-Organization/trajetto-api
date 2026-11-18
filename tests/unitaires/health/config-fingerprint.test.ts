import { describe, expect, it } from "vitest";

import {
  FINGERPRINT_SETTINGS,
  configFingerprint,
  redisRunIdFrom,
} from "@/shared/health/config-fingerprint";

/**
 * The fingerprint of the settings every process must share (plano-escala
 * F3-03, X-04).
 *
 * Each Application of a role is created by copying the API's Environment,
 * and a copy can drift without failing any boot: another JWT key, another
 * adapter key, another database. The fingerprint in process_heartbeat lets
 * the deploy's check see two live processes disagree. What it must and must
 * not depend on:
 *
 *  - every setting of the list, and the identities of the database and the
 *    Redis the process reached;
 *  - never the URL: the same database through PgBouncer or directly, by
 *    one login or another, is the same database (wave 17 switches the
 *    Applications one at a time, and each deploy in between must pass);
 *  - never a value, in clear or recognisable.
 */

const SETTINGS = {
  JWT_SECRET: "a".repeat(48),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(48),
  SOCKET_ADAPTER_KEY: "socket.io",
  WEBHOOK_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_ENV: "staging",
  R2_BUCKET_NAME: "trajetto-staging",
  MIN_MOBILE_CONTRACT: 5,
};

const IDENTITIES = {
  database: "7350000000000000001/trajetto",
  redis: "0123456789abcdef0123456789abcdef01234567",
};

describe("the configuration fingerprint", () => {
  it("is 16 hex characters, stable for the same inputs", () => {
    const fingerprint = configFingerprint(SETTINGS, IDENTITIES);

    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(configFingerprint({ ...SETTINGS }, { ...IDENTITIES })).toBe(
      fingerprint,
    );
  });

  it("changes with each setting of the list", () => {
    const base = configFingerprint(SETTINGS, IDENTITIES);

    for (const name of FINGERPRINT_SETTINGS) {
      const changed = { ...SETTINGS, [name]: `${SETTINGS[name]}-x` };

      expect(configFingerprint(changed, IDENTITIES), name).not.toBe(base);
    }
  });

  it("tells an absent setting from an empty one's neighbour", () => {
    expect(
      configFingerprint(
        { ...SETTINGS, WEBHOOK_SECRETS_KEY: undefined },
        IDENTITIES,
      ),
    ).not.toBe(configFingerprint(SETTINGS, IDENTITIES));
  });

  it("changes with another database or another Redis", () => {
    const base = configFingerprint(SETTINGS, IDENTITIES);

    expect(
      configFingerprint(SETTINGS, {
        ...IDENTITIES,
        database: "7350000000000000002/trajetto",
      }),
    ).not.toBe(base);
    expect(
      configFingerprint(SETTINGS, {
        ...IDENTITIES,
        database: "7350000000000000001/trajetto_copy",
      }),
    ).not.toBe(base);
    expect(
      configFingerprint(SETTINGS, { ...IDENTITIES, redis: "f".repeat(40) }),
    ).not.toBe(base);
  });

  it("is the same whatever URL reached the database: direct, pooled, any login", () => {
    // The URLs are not an input at all: the database names itself.
    const direct = {
      ...SETTINGS,
      DATABASE_URL:
        "postgresql://trajetto_http:a@trajetto-postgres-staging:5432/trajetto",
    };
    const pooled = {
      ...SETTINGS,
      DATABASE_URL:
        "postgresql://trajetto_worker:b@trajetto-pgbouncer-staging:6432/trajetto?pgbouncer=true",
    };

    expect(configFingerprint(direct, IDENTITIES)).toBe(
      configFingerprint(pooled, IDENTITIES),
    );
  });

  it("never carries a value", () => {
    const fingerprint = configFingerprint(SETTINGS, IDENTITIES);

    for (const value of Object.values(SETTINGS)) {
      const text = String(value);

      if (text.length >= 4) expect(fingerprint).not.toContain(text);
    }
  });
});

describe("the Redis run_id", () => {
  it("is read from INFO server, and missing when INFO does not say", () => {
    const info = [
      "# Server",
      "redis_version:7.4.12",
      "run_id:0123456789abcdef0123456789abcdef01234567",
      "tcp_port:6379",
    ].join("\r\n");

    expect(redisRunIdFrom(info)).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(redisRunIdFrom("# Server\r\nredis_version:7.4.12")).toBeNull();
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { v7 as uuidV7 } from "uuid";

import { chatRetentionBounds } from "@/jobs/cron/purge-chat-messages-job";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * The chat's opt-in retention (plano-escala U-08, decision D12).
 *
 * Deleting a customer's conversations by default would be a destructive
 * surprise, so CHAT_MESSAGE_RETENTION_DAYS has no default: unset or empty,
 * nothing is deleted. A value under a year is refused, as the audit trail's
 * ACTIVITY_RETENTION_DAYS is: a conversation is evidence of what the base
 * told the driver, and 30 is far likelier a typo than a decision.
 *
 * The purge finds the expired messages by their uuid v7 id, which starts
 * with the millisecond the message was written: the table has no index on
 * created_at alone, and a walk of the primary key below the cutoff's id is
 * bounded. The id bound must never let through a message written at or
 * after the cutoff.
 */
const BASE = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string>) =>
  envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

const DAY_MS = 24 * 60 * 60 * 1000;

describe("CHAT_MESSAGE_RETENTION_DAYS", () => {
  it("is unset by default, empty included: nothing is ever deleted", () => {
    expect(parse({}).data?.CHAT_MESSAGE_RETENTION_DAYS).toBeUndefined();
    expect(
      parse({ CHAT_MESSAGE_RETENTION_DAYS: "" }).data
        ?.CHAT_MESSAGE_RETENTION_DAYS,
    ).toBeUndefined();
  });

  it("takes a whole number of days from a year up", () => {
    expect(
      parse({ CHAT_MESSAGE_RETENTION_DAYS: "365" }).data
        ?.CHAT_MESSAGE_RETENTION_DAYS,
    ).toBe(365);
    expect(
      parse({ CHAT_MESSAGE_RETENTION_DAYS: "3650" }).data
        ?.CHAT_MESSAGE_RETENTION_DAYS,
    ).toBe(3650);

    for (const value of ["364", "30", "0", "-1", "400.5", "abc", "3651"]) {
      expect(parse({ CHAT_MESSAGE_RETENTION_DAYS: value }).success, value).toBe(
        false,
      );
    }
  });
});

describe("the expired messages' bounds", () => {
  const now = new Date("2027-11-18T04:25:00.000Z");

  it("cuts at the retention, in days back from now", () => {
    const { cutoff } = chatRetentionBounds(365, now);

    expect(cutoff.toISOString()).toBe(
      new Date(now.getTime() - 365 * DAY_MS).toISOString(),
    );
  });

  it("lets through an id minted before the cutoff and never one at or after it", () => {
    const { cutoff, idBelow } = chatRetentionBounds(365, now);
    const at = cutoff.getTime();

    const before = uuidV7({ msecs: at - 1 });
    const atCutoff = uuidV7({ msecs: at });
    const after = uuidV7({ msecs: at + DAY_MS });

    // Text order, as Postgres compares the ids (lower-case hex, hyphens in
    // the same places: the same under the database's collation).
    expect(before < idBelow).toBe(true);
    expect(atCutoff < idBelow).toBe(false);
    expect(after < idBelow).toBe(false);
  });
});

/**
 * The id bound holds only while every message's id is a v7 minted when it
 * is written. A v4 id would sort anywhere: its message would never fall below
 * the cutoff's id and would outlive the retention without a word (the
 * created_at filter keeps a young message safe either way). So: the model
 * mints a v7, and the one place in src/ that inserts a message gives no id
 * of its own and holds no v4 maker. A second write path fails here until
 * somebody looks at its ids.
 */
describe("the ids the retention's bound relies on", () => {
  const ROOT = process.cwd();

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) return sources(path);

      return /\.ts$/.test(entry.name) ? [path] : [];
    });
  }

  it("are minted as uuid v7 by the model", () => {
    const schema = readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8");
    const model = schema.match(/^model ChatMessage \{[\s\S]*?^\}/m)?.[0];

    expect(model).toBeDefined();
    expect(model).toMatch(/^\s*id\s+String\s+@id\s+@default\(uuid\(7\)\)/m);
  });

  it("come from one write path, which never gives an id of its own", () => {
    const writers = sources(resolve(ROOT, "src"))
      .filter((file) =>
        /chatMessage\.(create|createMany|createManyAndReturn|upsert)\b|INSERT\s+INTO\s+"?chat_message"?/i.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(ROOT, file).replace(/\\/g, "/"));

    expect(writers).toEqual([
      "src/modules/chat/repositories/chat-repository.ts",
    ]);

    const repository = readFileSync(resolve(ROOT, writers[0]), "utf8");
    const create = repository.match(
      /chatMessage\.create\(\{\s*data:\s*\{([\s\S]*?)\}\s*,?\s*\}\)/,
    )?.[1];

    expect(create).toBeDefined();
    expect(create).not.toMatch(/^\s*id\s*:/m);
    expect(repository).not.toMatch(/randomUUID|uuidv4|v4 as|gen_random_uuid/);
  });
});

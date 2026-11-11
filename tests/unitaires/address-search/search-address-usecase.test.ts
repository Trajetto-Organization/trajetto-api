import { describe, expect, it } from "vitest";

import {
  SearchAddressUseCase,
  type AddressSearchSettings,
  type SearchAddressRequest,
} from "@/modules/address-search/usecases/search-address/search-address-usecase";
import {
  EXTEND_PAUSE,
  GEOCODING_CALLS_PER_MINUTE,
  TAKE_SLOT,
  createRedisGeocodingGate,
  pauseReasonOf,
  pauseValue,
} from "@/shared/delivery/geocoding/geocoding-gate";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";
import { createRedisAddressSearchStore } from "@/shared/services/address-search/address-search-limits";
import type {
  ProviderAnswer,
  ProviderSearch,
} from "@/shared/services/address-search/address-search-provider";
import { COUNT_AND_ARM_WINDOW } from "@/shared/services/fixed-window-counter";

/**
 * The panel's address search end to end, short of HTTP and of a real
 * Redis (plan pin-search; synthesis of 10/11/2026): the company's cache,
 * the platform's and the company's day, the account's pause and the
 * search's own, the provider's slot it shares with the deliveries' lookups,
 * a person who typed again, and the log line that never carries what was
 * typed. The store and the gate are the real ones, over a Redis double that
 * runs their scripts.
 */
const NOW = new Date("2026-11-10T15:00:00.000Z");
const A = "018ff000-0000-7000-8000-00000000000a";
const B = "018ff000-0000-7000-8000-00000000000b";

const FOUND: ProviderAnswer = {
  kind: "FOUND",
  places: [
    {
      place_id: "p1",
      lat: "-22.5084",
      lon: "-43.1735",
      class: "highway",
      type: "residential",
      address: {
        road: "Rua Epitácio Pessoa",
        suburb: "Centro",
        city: "Petrópolis",
        state: "Rio de Janeiro",
        postcode: "25610-000",
        country_code: "br",
      },
    },
  ],
};

function fakeRedis() {
  const values = new Map<string, { value: string; ttl: number | null }>();
  /** The provider's minute log (geocoding-gate.ts): the calls' times. */
  const logs = new Map<string, number[]>();

  const get = (key: string) => values.get(key)?.value ?? null;
  const num = (key: string) => Number(get(key) ?? 0);
  const incr = (key: string, ttl: number) => {
    const next = num(key) + 1;
    values.set(key, { value: String(next), ttl: values.get(key)?.ttl ?? ttl });
    return next;
  };

  return {
    values,
    redis: {
      async get(key: string) {
        return get(key);
      },
      async mget(...keys: string[]) {
        return keys.map(get);
      },
      async set(key: string, value: string, _ex: "EX", seconds: number) {
        values.set(key, { value, ttl: seconds * 1000 });
        return "OK";
      },
      async eval(script: string, _count: number, ...rest: unknown[]) {
        if (script === EXTEND_PAUSE) {
          const [key, value, ms] = rest as [string, string, number];
          const left = values.get(key)?.ttl ?? -2;

          if (left < Number(ms)) values.set(key, { value, ttl: Number(ms) });

          return 1;
        }

        if (script === TAKE_SLOT) {
          const [second, minute, perSecond, perMinute, , now, window] =
            rest as [string, string, number, number, number, number, number];

          if (num(second) >= Number(perSecond)) return 0;

          const log = (logs.get(minute) ?? []).filter(
            (at) => at > Number(now) - Number(window),
          );

          logs.set(minute, log);

          if (log.length >= Number(perMinute)) return 0;

          incr(second, 2_000);
          log.push(Number(now));

          return 1;
        }

        if (script === COUNT_AND_ARM_WINDOW) {
          const [key, seconds] = rest as [string, number];

          return incr(key, Number(seconds) * 1000);
        }

        throw new Error("unexpected script");
      },
    },
  };
}

const SETTINGS: AddressSearchSettings = {
  provider: {
    url: "https://api.locationiq.com/v1",
    protocol: "locationiq-autocomplete",
    key: "pk.secret-key",
    keyParam: "key",
    userAgent: "Trajetto/test",
    timeoutMs: 2_500,
  },
  dailyBudget: 1_000,
  businessDailyLimit: 150,
  cacheSeconds: 172_800,
};

interface Harness {
  useCase: SearchAddressUseCase;
  calls: Array<{ search: ProviderSearch; url: string }>;
  lines: Array<{
    level: string;
    details: Record<string, unknown>;
    message: string;
  }>;
  values: ReturnType<typeof fakeRedis>["values"];
  answers: ProviderAnswer[];
}

function harness({
  settings = SETTINGS,
  answers = [FOUND],
  redis = fakeRedis(),
  clock = () => NOW,
  slotClock,
  provider,
}: {
  settings?: Partial<AddressSearchSettings>;
  answers?: ProviderAnswer[];
  redis?: ReturnType<typeof fakeRedis>;
  clock?: () => Date;
  /** The gate's clock; by default each slot is a second later. */
  slotClock?: () => number;
  provider?: (signal: AbortSignal) => Promise<ProviderAnswer>;
} = {}): Harness {
  let ticks = 0;
  const gateClock = slotClock ?? (() => NOW.getTime() + 1_000 * ticks++);

  const calls: Harness["calls"] = [];
  const lines: Harness["lines"] = [];
  const queue = [...answers];

  const record =
    (level: string) => (details: Record<string, unknown>, message: string) =>
      lines.push({ level, details, message });

  const useCase = new SearchAddressUseCase({
    settings: () => ({ ...SETTINGS, ...settings }),
    store: createRedisAddressSearchStore(redis.redis as never),
    gate: createRedisGeocodingGate(redis.redis as never, {
      clock: gateClock,
      perMinute: GEOCODING_CALLS_PER_MINUTE,
    }),
    provider: async (config, search, signal) => {
      calls.push({ search, url: `${config.url}?key=${config.key}` });

      if (provider) return provider(signal);

      return queue.shift() ?? FOUND;
    },
    log: { info: record("info"), warn: record("warn"), error: record("error") },
    clock,
    options: { slotWaitMs: 0 },
  });

  return { useCase, calls, lines, values: redis.values, answers: queue };
}

function request(
  overrides: Partial<SearchAddressRequest> = {},
): SearchAddressRequest {
  return {
    businessId: A,
    query: "Rua Epitácio Pessoa, 120",
    hint: { city: "Petrópolis", uf: "RJ" },
    viewbox: null,
    limit: 8,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("the company's cache", () => {
  it("answers the same search again without the provider or the day", async () => {
    const { useCase, calls, values } = harness();

    const first = await useCase.execute(request());
    const second = await useCase.execute(request());

    expect(first).toMatchObject({ kind: "OK", cached: false, scope: "CITY" });
    expect(second).toMatchObject({ kind: "OK", cached: true, scope: "CITY" });
    expect(second).toMatchObject({
      results: [{ title: "Rua Epitácio Pessoa", precision: "STREET" }],
    });
    expect(calls).toHaveLength(1);
    expect(values.get(GEOCODING_KEYS.searchBusinessDay(NOW, A))?.value).toBe(
      "1",
    );
    expect(values.get(GEOCODING_KEYS.searchDay(NOW))?.value).toBe("1");
  });

  it("never serves company A's answer to company B", async () => {
    const { useCase, calls } = harness();

    await useCase.execute(request());
    const theirs = await useCase.execute(request({ businessId: B }));

    expect(theirs).toMatchObject({ kind: "OK", cached: false });
    expect(calls).toHaveLength(2);
  });

  it("keeps the text out of the key, and nothing at all with the cache off", async () => {
    const { useCase, values } = harness();

    await useCase.execute(request());

    const cacheKeys = [...values.keys()].filter((key) =>
      key.startsWith("geocoding:search:cache:"),
    );

    expect(cacheKeys).toHaveLength(1);
    expect(cacheKeys[0]).toMatch(
      new RegExp(`^geocoding:search:cache:${A}:[0-9a-f]{64}$`),
    );
    expect(cacheKeys[0]).not.toMatch(/epit|pessoa|120/i);
    expect(values.get(cacheKeys[0])?.ttl).toBe(172_800_000);

    // The suggestions are sealed: a door search's title is the address
    // typed, near enough.
    const stored = values.get(cacheKeys[0])?.value ?? "";

    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toMatch(/epit|pessoa|petr|25610/i);

    const off = harness({ settings: { cacheSeconds: 0 } });

    await off.useCase.execute(request());
    await off.useCase.execute(request());

    expect(off.calls).toHaveLength(2);
    expect([...off.values.keys()].some((key) => key.includes(":cache:"))).toBe(
      false,
    );
  });

  it("keeps 'nothing found' for 10 minutes only", async () => {
    const { useCase, values } = harness({ answers: [{ kind: "NOT_FOUND" }] });

    expect(await useCase.execute(request())).toMatchObject({
      kind: "OK",
      results: [],
      weak: false,
    });

    const key = [...values.keys()].find((name) => name.includes(":cache:"))!;

    expect(values.get(key)?.ttl).toBe(600_000);
  });

  it("asks the delivery's city in the text, and the country without it", async () => {
    const { useCase, calls } = harness();

    await useCase.execute(request());
    const country = await useCase.execute(request({ hint: null }));

    expect(calls[0].search.text).toBe(
      "Rua Epitácio Pessoa, 120, Petrópolis, Rio de Janeiro",
    );
    expect(calls[1].search.text).toBe("Rua Epitácio Pessoa, 120");
    expect(country).toMatchObject({ kind: "OK", scope: "COUNTRY" });
  });

  it("never sends the provider more than its 200 characters, the city's chip on", async () => {
    const { useCase, calls } = harness();
    const long = `Rua ${"Comprida ".repeat(22)}`.trim().slice(0, 200);

    await useCase.execute(request({ query: long }));

    expect(long).toHaveLength(200);
    expect(calls[0].search.text).toBe(long);
  });
});

describe("the day's counts", () => {
  it("answers DAILY_LIMIT for the company at its ceiling while another company searches on", async () => {
    const redis = fakeRedis();
    const { useCase, calls } = harness({
      redis,
      settings: { businessDailyLimit: 2 },
    });

    await useCase.execute(request({ query: "Rua Um" }));
    await useCase.execute(request({ query: "Rua Dois" }));

    expect(await useCase.execute(request({ query: "Rua Três" }))).toEqual({
      kind: "DAILY_LIMIT",
      scope: "BUSINESS",
      retryAfterSeconds: 9 * 3600,
    });
    expect(
      await useCase.execute(request({ query: "Rua Três", businessId: B })),
    ).toMatchObject({ kind: "OK" });
    expect(calls).toHaveLength(3);
  });

  it("answers DAILY_LIMIT for the platform once its budget is spent", async () => {
    const redis = fakeRedis();

    redis.values.set(GEOCODING_KEYS.searchDay(NOW), {
      value: "1000",
      ttl: null,
    });

    const { useCase, calls } = harness({ redis });

    expect(await useCase.execute(request())).toMatchObject({
      kind: "DAILY_LIMIT",
      scope: "PLATFORM",
    });
    expect(calls).toHaveLength(0);
  });

  it("is off without a provider or with a budget of 0", async () => {
    for (const settings of [{ provider: null }, { dailyBudget: 0 }]) {
      const { useCase, calls } = harness({ settings });

      expect(await useCase.execute(request())).toMatchObject({
        kind: "UNAVAILABLE",
        reason: "DISABLED",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("fails CLOSED when Redis does not answer", async () => {
    const redis = fakeRedis();
    const broken = {
      ...redis,
      redis: {
        ...redis.redis,
        mget: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    };

    const { useCase, calls } = harness({ redis: broken });

    expect(await useCase.execute(request())).toMatchObject({
      kind: "UNAVAILABLE",
      reason: "LIMITS_UNREADABLE",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("the pauses", () => {
  it("does not call the provider while the account's quota pause runs", async () => {
    const redis = fakeRedis();
    const midnight = new Date("2026-11-11T00:00:00.000Z");

    redis.values.set(GEOCODING_KEYS.pause, {
      value: pauseValue("QUOTA", midnight),
      ttl: 9 * 3600_000,
    });

    const { useCase, calls } = harness({ redis });

    expect(await useCase.execute(request())).toEqual({
      kind: "UNAVAILABLE",
      reason: "PAUSED",
      retryAfterSeconds: 9 * 3600,
    });
    expect(calls).toHaveLength(0);
  });

  it("answers BUSY during the account's burst pause", async () => {
    const redis = fakeRedis();

    redis.values.set(GEOCODING_KEYS.pause, {
      value: pauseValue("BURST", new Date(NOW.getTime() + 42_000)),
      ttl: 42_000,
    });

    const { useCase, calls } = harness({ redis });

    expect(await useCase.execute(request())).toEqual({
      kind: "BUSY",
      retryAfterSeconds: 42,
    });
    expect(calls).toHaveLength(0);
  });

  it("searches on while the deliveries' lookups are paused by a refusal of their own endpoint", async () => {
    const redis = fakeRedis();

    redis.values.set(GEOCODING_KEYS.pause, {
      value: pauseValue("REFUSED", new Date(NOW.getTime() + 900_000)),
      ttl: 900_000,
    });

    const { useCase, calls } = harness({ redis });

    expect(await useCase.execute(request())).toMatchObject({ kind: "OK" });
    expect(calls).toHaveLength(1);
  });

  it("pauses only itself for 15 min when the provider refuses it, never the deliveries' lookups", async () => {
    const redis = fakeRedis();
    const { useCase, calls, lines } = harness({
      redis,
      answers: [{ kind: "REFUSED", status: 401 }],
    });

    expect(await useCase.execute(request())).toEqual({
      kind: "UNAVAILABLE",
      reason: "PROVIDER",
      retryAfterSeconds: 900,
    });

    expect(redis.values.get(GEOCODING_KEYS.searchPause)).toEqual({
      value: "REFUSED 2026-11-10T15:15:00.000Z",
      ttl: 900_000,
    });
    // The minute's job reads this key: it must stay empty.
    expect(redis.values.get(GEOCODING_KEYS.pause)).toBeUndefined();

    const deliveries = createRedisGeocodingGate(redis.redis as never);

    expect(await deliveries.paused(NOW)).toBe(false);

    // The next search waits out its own pause.
    expect(
      await useCase.execute(request({ query: "Outra rua" })),
    ).toMatchObject({ kind: "UNAVAILABLE", reason: "PAUSED" });
    expect(calls).toHaveLength(1);

    expect(lines.map((line) => line.level)).toEqual(["error", "info"]);
    expect(lines[0].details).toMatchObject({
      businessId: A,
      outcome: "UNAVAILABLE_PROVIDER",
      status: 401,
    });
  });

  it("pauses every path until midnight on the day's quota, and for a minute on a burst", async () => {
    const quota = fakeRedis();
    const day = harness({
      redis: quota,
      answers: [{ kind: "RATE_LIMITED", status: 429, scope: "DAY" }],
    });

    expect(await day.useCase.execute(request())).toMatchObject({
      kind: "UNAVAILABLE",
      reason: "PAUSED",
    });
    expect(pauseReasonOf(quota.values.get(GEOCODING_KEYS.pause)?.value)).toBe(
      "QUOTA",
    );
    expect(
      await createRedisGeocodingGate(quota.redis as never).paused(NOW),
    ).toBe(true);

    const burst = fakeRedis();
    const short = harness({
      redis: burst,
      answers: [{ kind: "RATE_LIMITED", status: 429, scope: "SHORT" }],
    });

    expect(await short.useCase.execute(request())).toEqual({
      kind: "BUSY",
      retryAfterSeconds: 60,
    });
    expect(burst.values.get(GEOCODING_KEYS.pause)).toEqual({
      value: pauseValue("BURST", new Date(NOW.getTime() + 60_000)),
      ttl: 60_000,
    });
    // The search's own copy, read the same way.
    expect(burst.values.get(GEOCODING_KEYS.searchPause)).toEqual({
      value: pauseValue("BURST", new Date(NOW.getTime() + 60_000)),
      ttl: 60_000,
    });
    expect(
      pauseReasonOf(quota.values.get(GEOCODING_KEYS.searchPause)?.value),
    ).toBe("QUOTA");
    expect(short.lines[0].level).toBe("warn");
  });

  it("holds itself through a burst while the deliveries' own refusal holds the shared pause", async () => {
    const redis = fakeRedis();
    const refused = pauseValue("REFUSED", new Date(NOW.getTime() + 900_000));

    redis.values.set(GEOCODING_KEYS.pause, { value: refused, ttl: 900_000 });

    const { useCase, calls } = harness({
      redis,
      answers: [{ kind: "RATE_LIMITED", status: 429, scope: "SHORT" }, FOUND],
    });

    expect(await useCase.execute(request())).toMatchObject({ kind: "BUSY" });
    // The shared key keeps its longer pause, and the burst is not lost.
    expect(redis.values.get(GEOCODING_KEYS.pause)?.value).toBe(refused);

    expect(await useCase.execute(request({ query: "Outra rua" }))).toEqual({
      kind: "BUSY",
      retryAfterSeconds: 60,
    });
    expect(calls).toHaveLength(1);
  });

  it("answers the longer pause when a refusal and a burst both run", async () => {
    const redis = fakeRedis();

    redis.values.set(GEOCODING_KEYS.pause, {
      value: pauseValue("BURST", new Date(NOW.getTime() + 30_000)),
      ttl: 30_000,
    });
    redis.values.set(GEOCODING_KEYS.searchPause, {
      value: pauseValue("REFUSED", new Date(NOW.getTime() + 600_000)),
      ttl: 600_000,
    });

    const { useCase, calls } = harness({ redis });

    expect(await useCase.execute(request())).toEqual({
      kind: "UNAVAILABLE",
      reason: "PAUSED",
      retryAfterSeconds: 600,
    });
    expect(calls).toHaveLength(0);
  });

  it("fails only that search when the provider rejects the text (400): nothing paused, nothing cached", async () => {
    const redis = fakeRedis();
    const { useCase, calls, lines, values } = harness({
      redis,
      answers: [{ kind: "REJECTED", status: 400 }, FOUND],
    });

    expect(await useCase.execute(request())).toEqual({
      kind: "UNAVAILABLE",
      reason: "PROVIDER",
      retryAfterSeconds: 5,
    });
    expect(values.get(GEOCODING_KEYS.searchPause)).toBeUndefined();
    expect(values.get(GEOCODING_KEYS.pause)).toBeUndefined();
    expect([...values.keys()].some((key) => key.includes(":cache:"))).toBe(
      false,
    );

    // Another company's search goes on asking.
    expect(
      await useCase.execute(request({ businessId: B, query: "Outra rua" })),
    ).toMatchObject({ kind: "OK" });
    expect(calls).toHaveLength(2);

    expect(lines[0]).toMatchObject({
      level: "warn",
      details: { outcome: "UNAVAILABLE_PROVIDER", status: 400 },
    });
  });

  it("answers UNAVAILABLE without caching a provider that failed", async () => {
    const { useCase, calls } = harness({
      answers: [{ kind: "FAILED", status: 502 }, FOUND],
    });

    expect(await useCase.execute(request())).toEqual({
      kind: "UNAVAILABLE",
      reason: "PROVIDER",
      retryAfterSeconds: 5,
    });
    expect(await useCase.execute(request())).toMatchObject({
      kind: "OK",
      cached: false,
    });
    expect(calls).toHaveLength(2);
  });
});

describe("the provider's slot", () => {
  it("waits for the slot the job holds, and answers BUSY when it never frees", async () => {
    const redis = fakeRedis();
    const { useCase, calls, values } = harness({
      redis,
      slotClock: () => NOW.getTime(),
    });

    // The job took this second's call.
    const job = createRedisGeocodingGate(redis.redis as never, {
      clock: () => NOW.getTime(),
    });

    expect(await job.takeSlot()).toBe(true);

    expect(await useCase.execute(request())).toEqual({
      kind: "BUSY",
      retryAfterSeconds: 1,
    });
    expect(calls).toHaveLength(0);
    // Not spent: nothing went out.
    expect(values.get(GEOCODING_KEYS.searchDay(NOW))).toBeUndefined();
  });

  it("takes the next second's slot when it comes", async () => {
    const redis = fakeRedis();
    let now = NOW.getTime();
    const { useCase, calls } = harness({
      redis,
      // Each try for the slot is a little later.
      slotClock: () => (now += 400),
    });

    await createRedisGeocodingGate(redis.redis as never, {
      clock: () => NOW.getTime(),
    }).takeSlot();

    expect(await useCase.execute(request())).toMatchObject({ kind: "OK" });
    expect(calls).toHaveLength(1);
  });

  it("never calls nor spends for a person who typed again before the slot", async () => {
    const gone = new AbortController();

    gone.abort();

    const { useCase, calls, values } = harness();

    expect(await useCase.execute(request({ signal: gone.signal }))).toEqual({
      kind: "ABORTED",
    });
    expect(calls).toHaveLength(0);
    expect(values.get(GEOCODING_KEYS.searchDay(NOW))).toBeUndefined();
  });

  it("drops the call in flight when the person types again, without a pause or a cache", async () => {
    const gone = new AbortController();
    const { useCase, values } = harness({
      provider: async (signal) => {
        gone.abort();

        return signal.aborted ? { kind: "ABORTED" } : FOUND;
      },
    });

    expect(await useCase.execute(request({ signal: gone.signal }))).toEqual({
      kind: "ABORTED",
    });
    // The call went out: counted, as the provider counts it.
    expect(values.get(GEOCODING_KEYS.searchDay(NOW))?.value).toBe("1");
    expect([...values.keys()].some((key) => key.includes(":cache:"))).toBe(
      false,
    );
    expect(values.get(GEOCODING_KEYS.searchPause)).toBeUndefined();
  });
});

describe("the log line", () => {
  it("names the company, the outcome and the time, never what was typed nor the key", async () => {
    const { useCase, lines } = harness({
      answers: [FOUND, { kind: "REFUSED", status: 403 }],
    });

    await useCase.execute(request());
    await useCase.execute(request());
    await useCase.execute(request({ query: "Rua Joaquim Ferreira, 7" }));

    expect(lines.map((line) => line.details.outcome)).toEqual([
      "OK",
      "OK",
      "UNAVAILABLE_PROVIDER",
    ]);
    expect(lines[1].details).toMatchObject({ cached: true, businessId: A });

    const written = JSON.stringify(lines);

    expect(written).not.toMatch(/Epit[aá]cio|Joaquim|Ferreira|Petr[oó]polis/);
    expect(written).not.toContain("pk.secret-key");
    expect(written).not.toContain("locationiq.com");
  });
});

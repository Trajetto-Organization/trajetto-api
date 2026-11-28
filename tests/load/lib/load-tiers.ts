import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The seed's tiers (plano-escala LOAD-02): how many companies, deliveries,
 * events, stops, trail points and settled queue rows each rung of the
 * capacity ladder seeds, in SQL (tests/load/seed-tiers/*.sql).
 *
 * Sized from the plan's ladder (seção 5): 100k is 100 carriers, 300 thousand
 * deliveries over 180 days; 1m is 720 carriers and ~3 million; 5m is 3.600
 * carriers, ~15 million and 30 days of trail. The carriers are not equal: a
 * Zipf law of s = 1,1 gives the first one a large share and the long tail a
 * handful each, because the planner chooses different plans for a
 * businessId that matches 15% of a table and one that matches 0,003%, and a
 * seed of equal tenants measures neither. Besides them, 500 small companies
 * hold the 150 thousand open stops the anti-join plans are tested against
 * (plano-escala F2-21), and the queues hold 30 days of SETTLED rows (sent,
 * published, delivered), the steady state the queue scans run over.
 *
 * `prod-like` takes only production's COUNTS (tests/load/seed-tiers/
 * prod-counts.sql prints them as one JSON line), never a row of its data,
 * for the rehearsals of waves 10 and 11 on a disposable Database.
 *
 * Pure but for reading the counts file: the unit test
 * (tests/unitaires/lifecycle/load-tier-presets.test.ts) holds the numbers.
 */

/** Zipf's exponent: the share of rank k is k^-s over the sum. */
const ZIPF_S = 1.1;

const LOAD_TIER_NAMES = ["tiny", "100k", "1m", "5m", "prod-like"] as const;

type LoadTierName = (typeof LOAD_TIER_NAMES)[number];

interface LoadTierCounts {
  /** Carriers sized by Zipf; the primary tenant of the load is apart. */
  tenants: number;
  /** The long tail of tiny companies that hold the open stops. */
  smallTenants: number;
  /** Deliveries of the Zipf carriers, spread over `days`. */
  deliveries: number;
  days: number;
  /** Drivers of the Zipf carriers, by the same law (at least one each). */
  drivers: number;
  /** delivery_event rows, spread over the deliveries. */
  events: number;
  /** activity rows, one per delivery at most, and of them with v4 ids. */
  activities: number;
  activitiesV4: number;
  occurrences: number;
  /** PENDING stops on today's released routes of the small companies. */
  openStops: number;
  /** The last days whose deliveries ride routes, one a driver a day. */
  routeDays: number;
  /** Days of the lean trail, and points per driver per day. */
  trailDays: number;
  trailPoints: number;
  /** Settled queue rows of the last 30 days (or `days`, if fewer). */
  outboxEvents: number;
  notificationDeliveries: number;
  notifications: number;
  webhookDeliveries: number;
  /** Carriers with a webhook endpoint (the first by rank). */
  webhookTenants: number;
}

type PresetTierName = Exclude<LoadTierName, "prod-like">;

/**
 * The tiers. Per delivery: two events (the arrival and the proof), one
 * activity line, an occurrence in twenty. Per month of deliveries: three
 * outbox events each, one and a half notification deliveries per event, a
 * bell line per two events, a webhook per three. The trail has 240 points
 * per driver per day (one every 2,5 minutes of a 10-hour day), a tenth of
 * the real cadence: the rung's trail is about its partitions and its
 * archive, and the real cadence would make the 5m seed a day long.
 */
const LOAD_TIERS: Record<PresetTierName, LoadTierCounts> = {
  tiny: {
    tenants: 10,
    smallTenants: 20,
    deliveries: 5_000,
    days: 30,
    drivers: 40,
    events: 10_000,
    activities: 5_000,
    activitiesV4: 0,
    occurrences: 250,
    openStops: 2_000,
    routeDays: 3,
    trailDays: 2,
    trailPoints: 48,
    outboxEvents: 15_000,
    notificationDeliveries: 22_500,
    notifications: 7_500,
    webhookDeliveries: 5_000,
    webhookTenants: 3,
  },
  "100k": {
    tenants: 100,
    smallTenants: 500,
    deliveries: 300_000,
    days: 180,
    drivers: 400,
    events: 600_000,
    activities: 300_000,
    activitiesV4: 0,
    occurrences: 15_000,
    openStops: 150_000,
    routeDays: 7,
    trailDays: 7,
    trailPoints: 240,
    outboxEvents: 150_000,
    notificationDeliveries: 225_000,
    notifications: 75_000,
    webhookDeliveries: 50_000,
    webhookTenants: 20,
  },
  "1m": {
    tenants: 720,
    smallTenants: 500,
    deliveries: 3_000_000,
    days: 90,
    drivers: 4_000,
    events: 6_000_000,
    activities: 3_000_000,
    activitiesV4: 0,
    occurrences: 150_000,
    openStops: 150_000,
    routeDays: 7,
    trailDays: 2,
    trailPoints: 240,
    outboxEvents: 3_000_000,
    notificationDeliveries: 4_500_000,
    notifications: 1_500_000,
    webhookDeliveries: 1_000_000,
    webhookTenants: 144,
  },
  "5m": {
    tenants: 3_600,
    smallTenants: 500,
    deliveries: 15_000_000,
    days: 90,
    drivers: 20_000,
    events: 30_000_000,
    activities: 15_000_000,
    activitiesV4: 0,
    occurrences: 750_000,
    openStops: 150_000,
    routeDays: 7,
    trailDays: 30,
    trailPoints: 240,
    outboxEvents: 15_000_000,
    notificationDeliveries: 22_500_000,
    notifications: 7_500_000,
    webhookDeliveries: 5_000_000,
    webhookTenants: 720,
  },
};

/** Each rank's share of a Zipf law of exponent `s` over `n` ranks. */
function zipfShares(n: number, s: number = ZIPF_S): number[] {
  const weights = Array.from({ length: n }, (_, k) => (k + 1) ** -s);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  return weights.map((weight) => weight / total);
}

/**
 * The counts prod-counts.sql prints, by name: nothing else is accepted, so
 * a file with anything but counts (a row, a name, an address) is refused
 * before a byte is seeded.
 */
const PROD_COUNT_KEYS = [
  "business",
  "driver",
  "delivery",
  "delivery_days",
  "delivery_event",
  "delivery_occurrence",
  "activity",
  "activity_v4",
  "route_stop_open",
  "driver_position",
  "driver_position_days",
  "domain_outbox_event",
  "notification_delivery",
  "notification",
  "webhook_delivery",
  "webhook_business",
] as const;

type ProdCounts = Record<(typeof PROD_COUNT_KEYS)[number], number>;

/** The JSON prod-counts.sql printed, checked: only counts, all of them. */
function parseProdCounts(text: string): ProdCounts {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "LOAD_PROD_COUNTS não é o JSON de uma linha que o prod-counts.sql imprime.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LOAD_PROD_COUNTS precisa ser um objeto de contagens.");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const unknown = entries
    .map(([key]) => key)
    .filter((key) => !(PROD_COUNT_KEYS as readonly string[]).includes(key));

  if (unknown.length > 0) {
    throw new Error(
      `LOAD_PROD_COUNTS só aceita contagens; chaves desconhecidas: ${unknown.join(", ")}.`,
    );
  }

  const counts = {} as ProdCounts;

  for (const key of PROD_COUNT_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];

    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(
        `LOAD_PROD_COUNTS.${key} precisa ser um inteiro ≥ 0 (recebido: ${JSON.stringify(value)}).`,
      );
    }

    counts[key] = value;
  }

  return counts;
}

/**
 * Production's counts as a tier: the same tables, the same sizes. The
 * companies are all Zipf carriers (production's long tail is in its own
 * count), and the open stops then ride the carriers' routes.
 */
function prodLikeTier(counts: ProdCounts): LoadTierCounts {
  const tenants = Math.max(1, counts.business);
  const drivers = Math.max(tenants, counts.driver);
  const trailDays = Math.min(90, Math.max(1, counts.driver_position_days));

  return {
    tenants,
    smallTenants: 0,
    deliveries: counts.delivery,
    days: Math.max(1, counts.delivery_days),
    drivers,
    events: counts.delivery_event,
    activities: Math.min(counts.activity, counts.delivery),
    activitiesV4: Math.min(
      counts.activity_v4,
      Math.min(counts.activity, counts.delivery),
    ),
    occurrences: Math.min(counts.delivery_occurrence, counts.delivery),
    openStops: counts.route_stop_open,
    routeDays: 7,
    trailDays,
    trailPoints:
      counts.driver_position === 0
        ? 0
        : Math.max(
            1,
            Math.round(counts.driver_position / (drivers * trailDays)),
          ),
    outboxEvents: counts.domain_outbox_event,
    notificationDeliveries: counts.notification_delivery,
    notifications: counts.notification,
    webhookDeliveries: counts.webhook_delivery,
    webhookTenants: Math.min(tenants, counts.webhook_business),
  };
}

/** LOAD_PROD_COUNTS: the JSON line itself, or the path of a file with it. */
function readProdCounts(value: string | undefined): ProdCounts {
  if (!value?.trim()) {
    throw new Error(
      "LOAD_TIER=prod-like precisa de LOAD_PROD_COUNTS: a linha JSON que o tests/load/seed-tiers/prod-counts.sql imprime na produção, ou o caminho de um arquivo com ela.",
    );
  }

  const text = value.trim().startsWith("{")
    ? value
    : readFileSync(resolve(value.trim()), "utf8");

  return parseProdCounts(text.trim());
}

/**
 * The tier this environment asks for, or null without LOAD_TIER (the seed
 * then does what it always did: LOAD_TENANTS equal tenants through Prisma).
 */
function loadTierFromEnv(
  env: Record<string, string | undefined> = process.env,
): { name: LoadTierName; counts: LoadTierCounts } | null {
  const name = env.LOAD_TIER?.trim();

  if (!name) return null;

  if (!(LOAD_TIER_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `LOAD_TIER desconhecido: ${name}. Use ${LOAD_TIER_NAMES.join(", ")}.`,
    );
  }

  const tier = name as LoadTierName;

  return {
    name: tier,
    counts:
      tier === "prod-like"
        ? prodLikeTier(readProdCounts(env.LOAD_PROD_COUNTS))
        : LOAD_TIERS[tier],
  };
}

/** camelCase → snake_case, for the session settings the SQL reads. */
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The session settings the tier's SQL reads with
 * current_setting('load.<name>'): every count, and Zipf's exponent.
 */
function tierSettings(counts: LoadTierCounts): Record<string, string> {
  const settings: Record<string, string> = { "load.zipf_s": String(ZIPF_S) };

  for (const [name, value] of Object.entries(counts)) {
    settings[`load.${snake(name)}`] = String(value);
  }

  return settings;
}

const SEED_TIERS_DIR = resolve(__dirname, "..", "seed-tiers");

/**
 * The tier's SQL files, in the order they run: `NN-name.sql`, sorted.
 * prod-counts.sql has no number on purpose: it runs on production, by
 * hand, and never here.
 */
function seedTierFiles(dir: string = SEED_TIERS_DIR): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => /^\d{2}-[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => resolve(dir, name));
}

export {
  LOAD_TIERS,
  LOAD_TIER_NAMES,
  PROD_COUNT_KEYS,
  SEED_TIERS_DIR,
  ZIPF_S,
  loadTierFromEnv,
  parseProdCounts,
  prodLikeTier,
  readProdCounts,
  seedTierFiles,
  tierSettings,
  zipfShares,
};
export type { LoadTierCounts, LoadTierName, ProdCounts };

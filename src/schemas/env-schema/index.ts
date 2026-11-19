import { z } from "zod";

import {
  LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  LOCAL_AI_DEFAULT_TIMEOUT_MS,
} from "@/shared/ai/ai-provider-defaults";
import {
  ARCHIVE_STORAGE_CLASSES,
  missingArchiveSettings,
} from "@/shared/archive/archive-settings";
import { throughPgBouncer } from "@/shared/database/pgbouncer-url";
import { pooledUrlProblem } from "@/shared/database/pool-config";
import {
  pgBouncerStatsHostsProblem,
  pgBouncerStatsUrlProblem,
} from "@/shared/health/pgbouncer-stats-config";
import { isValidCnpj } from "@/shared/delivery/cnpj";
import {
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_BATCH_SIZE_DEFAULT,
  GEOCODING_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_CALLS_PER_SECOND_DEFAULT,
  GEOCODING_PROOF_RESERVED_PER_SECOND_DEFAULT,
  GEOCODING_RUN_BUDGET_DEFAULT_MS,
  GEOCODING_RUN_BUDGET_MAX_MS,
  GEOCODING_VERDICT_REUSE_DAYS_DEFAULT,
  PROOF_REVERSE_DAILY_BUDGET_DEFAULT,
  geocodingPlanProblems,
} from "@/shared/delivery/geocoding/geocoding-rules";
import { isPublicOsmTemplate, isTileTemplate } from "@/shared/map/map-tiles";
import {
  FEED_FLOOR_DEFAULT_MARGIN_MS,
  feedFloorMarginProblem,
} from "@/modules/integration/feed-floor";
import {
  DEFAULT_PARTIAL_RETRIES_PER_DAY,
  DEFAULT_PARTIAL_RETRY_WINDOW_UTC,
  DEFAULT_PURGE_RUN_BUDGET_MS,
  MAX_PURGE_RUN_BUDGET_MS,
  parseUtcWindow,
} from "@/shared/services/cron-limits";
import { HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT } from "@/config/http-server";
import {
  POSITIONS_FLUSH_AFTER_DEFAULT_MS,
  POSITIONS_FLUSH_AFTER_MAX_MS,
  POSITIONS_FLUSH_AFTER_MIN_MS,
} from "@/shared/health/pressure-level";
import {
  PROCESS_ROLES,
  parseWorkerQueues,
  resolveProcessRole,
} from "@/shared/lifecycle/process-role";
import {
  CPU_POOL_THREAD_DEFAULT_MAX_OLD_MB,
  MEMORY_BUDGET_MODES,
  NATIVE_RESERVE_DEFAULT_MB,
} from "@/shared/lifecycle/memory-budget";
import {
  QUEUE_CONCURRENCY_DEFAULTS,
  QUEUE_CONCURRENCY_MAX,
  type QueueConcurrencyVariable,
} from "@/shared/lifecycle/queue-config";
import {
  DEFAULT_STOP_GRACE_PERIOD_MS,
  MAX_STOP_GRACE_PERIOD_MS,
  MIN_STOP_GRACE_PERIOD_MS,
  planShutdown,
  shutdownPlanProblems,
} from "@/shared/lifecycle/shutdown-plan";

/** 32 characters of `openssl rand -base64` are ~192 bits: out of offline reach. */
const JWT_SECRET_MIN_LENGTH = 32;

/** A postgres:// or postgresql:// URL that parses. */
function isPostgresUrl(value: string): boolean {
  try {
    return /^postgres(ql)?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

const POSTGRES_URL_MESSAGE =
  "precisa ser uma URL postgresql:// (o mesmo formato da DATABASE_URL)";

/** A URL through PgBouncer that PgBouncer would refuse (pool-config.ts). */
function refusePooledUrlProblem(value: string, ctx: z.RefinementCtx): void {
  const problem = pooledUrlProblem(value);

  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
}

/** A provider's global concurrency cap (F3-15a): 0 to 256, 0 = none. */
function providerGlobalConcurrency() {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(256).default(0),
  );
}

/**
 * A provider's rate a second (F3-15c): 0 to 1000, 0 = off. The bucket's
 * interval is whole milliseconds, so 1000 is the most it can space.
 */
function providerRatePerSecond() {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(1000).default(0),
  );
}

/**
 * One queue's concurrency (plano-escala F3-05): 1 to 32, today's constant
 * when absent or empty.
 */
function queueConcurrency(name: QueueConcurrencyVariable) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number()
      .int()
      .min(1)
      .max(QUEUE_CONCURRENCY_MAX)
      .default(QUEUE_CONCURRENCY_DEFAULTS[name]),
  );
}

/** A node hostname, a slot number or node id, a service name: no spaces. */
const SWARM_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * One of the Swarm identity labels (F4-50): trimmed, absent when empty or
 * still a template, and absent (never a boot failure) when not a plain name.
 */
function swarmLabel() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;

    const trimmed = value.trim();

    return trimmed === "" || trimmed.includes("{{") ? undefined : trimmed;
  }, z.string().regex(SWARM_LABEL).optional().catch(undefined));
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Which deployment this is, apart from NODE_ENV: the image is built with
    // NODE_ENV=production inlined (tsup.config.ts), so staging runs it too and
    // needs another name. Unset, it follows NODE_ENV (see the transform
    // below), so a stack that predates it keeps booting as production.
    APP_ENV: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["development", "staging", "production"]).optional(),
    ),

    PORT: z.coerce.number().default(3333),

    // The level of the one logger the API and its workers write through
    // (shared/logging/logger.ts). `debug` adds the per-socket connect and
    // disconnect lines, which at fleet scale are most of the volume.
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // The external dead man's switch the ops heartbeat pings every minute
    // (OBS-03; healthchecks.io style: the URL when healthy, `<url>/fail` with
    // the reasons when not). HEALTHCHECK_FAIL_URL overrides the /fail
    // convention, for Uptime Kuma push monitors (`?status=down`). Unset, the
    // job only logs the reasons. Empty counts as absent. They carry the
    // check's secret: never log them.
    HEALTHCHECK_PING_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    HEALTHCHECK_FAIL_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),

    // The side pools of infra/database.ts (plano-escala F3-16): the heavy
    // reads' bulkhead and the maintenance pool, 3 connections each. Unset,
    // both use DATABASE_URL, as everything did before. They carry a
    // password: never logged (logger.ts censors them by name). The batch
    // URL must reach Postgres directly: the partition job detaches with
    // CONCURRENTLY and switches role on its session, which PgBouncer in
    // transaction mode silently breaks, so a 6432 port or pgbouncer=true
    // refuses the boot.
    DATABASE_READ_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(isPostgresUrl, POSTGRES_URL_MESSAGE)
        .superRefine(refusePooledUrlProblem)
        .optional(),
    ),

    // The standby, for the explicit reads of readDatabase() (plano-escala
    // F4-41, F4-42): a closed list of LISTS only, sent there while the
    // replica guard (shared/database/replica-guard.ts) measures it at most
    // 15 s behind, and to the primary's bulkhead the rest of the time. Its
    // own pool of 3 connections, as the bulkhead's, as trajetto_read.
    // Unset (the default), nothing goes to a standby and no heartbeat is
    // written: every read stays where it is today. Through PgBouncer, the
    // rules of DATABASE_URL. It carries a password: never logged (logger.ts
    // censors it by name). Empty counts as absent.
    DATABASE_REPLICA_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(isPostgresUrl, POSTGRES_URL_MESSAGE)
        .superRefine(refusePooledUrlProblem)
        .optional(),
    ),

    // The runtime's main URL: read by the pools of infra/database.ts at
    // connect time, checked here only for what PgBouncer would refuse
    // (plano-escala F4-31). Through PgBouncer (port 6432 or pgbouncer=true)
    // its `options` carry TimeZone alone, the ceilings coming from the
    // login's ALTER ROLE, and its connections live 60 s at most: booted
    // with ceilings in `options`, the process would fail every query, after
    // the rolling took the old task away. A direct URL is not checked, so
    // the deploys of today boot as they do. Empty counts as absent.
    DATABASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().superRefine(refusePooledUrlProblem).optional(),
    ),

    // The readiness probe's own pool in PgBouncer (plano-escala F4-37,
    // shared/health/readiness-probe.ts): the image's `<db>_probe` alias,
    // two server connections apart, so a saturated pool of the requests
    // never takes every replica out of the balancer at once. Unset, the
    // probe uses DATABASE_URL, as before. It carries the password: never
    // logged (logger.ts censors it by name). Empty counts as absent.
    READINESS_DATABASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(isPostgresUrl, POSTGRES_URL_MESSAGE)
        .superRefine(refusePooledUrlProblem)
        .optional(),
    ),
    BATCH_DATABASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(isPostgresUrl, POSTGRES_URL_MESSAGE)
        .refine(
          (value) => !throughPgBouncer(value),
          "BATCH_DATABASE_URL vai direto ao Postgres (porta 5432, sem pgbouncer=true): o job de partições usa uma sessão própria.",
        )
        .optional(),
    ),

    // PgBouncer's console, read by the process with the cron once a minute
    // for /health/metrics and the alerts (plano-escala F4-36,
    // shared/health/pgbouncer-metrics.ts). The URL is the stats login's
    // (pgbouncer_stats, SHOW only) on the console database `pgbouncer`;
    // any other login refuses the boot: the admin one (PAUSE, KILL,
    // SHUTDOWN) stays with the owner, never in an Application. It carries
    // the password: never logged (logger.ts censors it by name). The hosts
    // are `tasks.<App Name>`, so every task of the service is read; unset,
    // the URL's host. Both unset (the default), nothing is read and
    // `pgbouncer` is null. Empty counts as absent.
    PGBOUNCER_STATS_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .superRefine((value, ctx) => {
          const problem = pgBouncerStatsUrlProblem(value);

          if (problem) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
          }
        })
        .optional(),
    ),
    PGBOUNCER_STATS_HOSTS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .superRefine((value, ctx) => {
          const problem = pgBouncerStatsHostsProblem(value);

          if (problem) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
          }
        })
        .optional(),
    ),

    // The cut of the database roles (plano-escala F3-21): the boot always
    // warns when the runtime connects as a superuser or as the tables'
    // owner; `true` turns that into a refused boot, and also requires, in a
    // process that runs the cron, BATCH_DATABASE_URL and a DDL connection
    // that can SET ROLE trajetto_partitions (without them the partitions of
    // the next days stop being created, in silence). `false` until the owner
    // switched the URLs to the trajetto_* logins (docs/deploy.md). Empty
    // counts as absent.
    DATABASE_REQUIRE_RUNTIME_ROLE: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    REDIS_URL: z.string(),

    // A Redis of its own for the pub/sub (plano-escala F5-01): the Socket.IO
    // adapter's frames and the hints between processes (the wake). Unset,
    // the pub/sub stays on REDIS_URL, as always; the counters (rate limit,
    // handshakes, tickets, the geocoder's budget) stay on REDIS_URL either
    // way. Only for the trigger of the plan's section 7 (the Redis's CPU or
    // its output buffers), and the same value on every Application of an
    // environment, or the adapter splits the realtime in two. It carries the
    // password: never logged (logger.ts censors it by name). Empty counts as
    // absent.
    PUBSUB_REDIS_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(
          (value) => /^rediss?:\/\//.test(value),
          "PUBSUB_REDIS_URL precisa ser uma URL redis:// ou rediss:// (o mesmo formato da REDIS_URL)",
        )
        .optional(),
    ),

    HTTP_REQUEST: z.string(),
    API_HTTP_REQUEST: z.string().optional(),
    JWT_SECRET: z.string(),
    JWT_SECRET_REFRESH_TOKEN: z.string(),

    /**
     * How ensureAuthenticated and the socket handshake read the session
     * (plano-escala F4-05, modules/user/services/session-lookup.ts).
     * `single` (the default) asks SessionRepository.loadSession: the user
     * with its company, profile and driver, and the refresh-token family,
     * in one statement where the old path ran two to six on every
     * authenticated request. `legacy` is the old path, kept for two
     * releases as the rollback (U-10 removes it): same checks, same order,
     * same codes in both. Read on every request, so a test can flip it;
     * in a deployment, changing it is a redeploy. Empty counts as absent.
     */
    SESSION_LOOKUP_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["single", "legacy"]).default("single"),
    ),

    // Meta WhatsApp Cloud API. Optional so environments without WhatsApp
    // still boot: the provider reports itself unconfigured and sends fail
    // with a clear error instead of blocking startup.
    META_WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    META_WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

    // Neither is read any more (plan of 02/11/2026, B1/B2/B7): every message
    // names its own approved template — the 17 internal ones and the
    // customer's four, by fixed names (src/shared/notifications/
    // whatsapp-templates.ts, src/shared/delivery/customer-whatsapp-templates.ts)
    // — and the generic one-parameter template is retired. Kept declared
    // until the rollout is confirmed, since the environments and the CI still
    // set them; removed from the code afterwards.
    META_WHATSAPP_TEMPLATE_NAME: z.string().default("trajetto_notification"),
    META_WHATSAPP_CUSTOMER_TEMPLATE_NAME: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    META_WHATSAPP_API_VERSION: z.string().default("v23.0"),

    // The WhatsApp Business Account that owns the templates. Read only by
    // /health/providers, to say whether each template is APPROVED; sends do
    // not need it. Not a secret. Empty counts as absent.
    META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(
          /^\d{5,30}$/,
          "META_WHATSAPP_BUSINESS_ACCOUNT_ID é o id numérico da conta (WABA).",
        )
        .optional(),
    ),

    // Meta's status callbacks (POST /webhooks/whatsapp): the App Secret signs
    // every body (X-Hub-Signature-256) and the verify token answers the
    // subscription handshake. Unset, the receiver answers 404 and nothing is
    // reconciled — sends keep working. Empty counts as absent.
    META_WHATSAPP_APP_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    // The Expo project's access token (expo.dev > Access tokens), sent as
    // Bearer on every push and receipts query (plan of 02/11/2026, A8).
    // Required by Expo only once "enhanced push security" is turned on in the
    // project — then every call without it is refused with 401. Optional:
    // unset, nothing changes; set it in both environments BEFORE turning the
    // setting on (decision D43). A secret. Empty counts as absent.
    EXPO_ACCESS_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    RESEND_SECRET_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),

    // Resend's webhook signing secret (`whsec_...`) for POST /webhooks/resend:
    // delivered/bounced/complained events reach the receipts ledger. Unset,
    // the receiver answers 404 and e-mail keeps working unreconciled. Empty
    // counts as absent.
    RESEND_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    MASTER_USER_EMAIL: z.string(),
    MASTER_USER_INITIAL_PASSWORD: z.string(),

    // File Upload Configuration
    UPLOAD_STORAGE_TYPE: z.enum(["local", "r2"]).default("local"),
    UPLOAD_LOCAL_PATH: z.string().default("./tmp"),

    // Cloudflare R2 Configuration
    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),

    // An S3-compatible endpoint instead of the account's R2 one (path-style
    // addressing). For a local MinIO in the upload E2E; unset in production.
    R2_ENDPOINT: z.string().url().optional(),
    // No R2_PUBLIC_DOMAIN on purpose: the bucket is private and every read is
    // a short-lived signed URL (upload-service.getFileUrl); a public domain
    // would give permanent, unsigned access to the photos.
    UPLOAD_SIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900),

    /**
     * The nightly collector of stored objects no row references
     * (src/shared/services/orphan-uploads.ts), only 30 to 33 days old.
     * `dry-run` (default) counts and logs them; `delete` removes them; `off`
     * skips the job. Read a few nights of dry-run summaries before `delete`:
     * ADR 0006 keeps an object for the client's retry until its row exists.
     */
    UPLOAD_ORPHAN_GC: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["off", "dry-run", "delete"]).default("dry-run"),
    ),

    /**
     * How long the public link printed on a delivery receipt keeps opening
     * it, counted from when the document was generated (GAP1-8). The link is
     * a capability with no login — whoever holds a photo of the QR holds the
     * PDF — so it goes dark after the retention period and answers like a
     * token that never existed. Default 1825 days (five years, the fiscal
     * retention horizon of an NF-e); the final value is a product/legal call.
     */
    PROOF_VERIFICATION_TTL_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().default(1825),
    ),

    /**
     * The proof document's ICP-Brasil signature (decision 14.8, design §6.3).
     * The platform's A1 e-CNPJ, as a PFX: base64 in the variable OR a path to
     * a mounted secret file, never both. SECRETS — the PFX and its password
     * are never logged. Without them the PDFs go out unsigned and say so.
     */
    PROOF_SIGNING_PFX_BASE64: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    PROOF_SIGNING_PFX_PATH: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    PROOF_SIGNING_PFX_PASSWORD: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    /** `pades-ad-rb` (ICP-Brasil AD-RB v1.1) or `cms` (the model's plain CMS). */
    PROOF_SIGNATURE_PROFILE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["pades-ad-rb", "cms"]).default("pades-ad-rb"),
    ),
    /** Switches signing off without removing the certificate (an incident). */
    PROOF_SIGNING_DISABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),
    PROOF_SIGNER_LOCATION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().default(""),
    ),
    PROOF_SIGNER_CONTACT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().default(""),
    ),
    /** The brand in "A TRAJETTO (…) garante…". Name and CNPJ of a signed
     * document come from the certificate, never from here. */
    PROOF_SIGNER_BRAND: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().default("TRAJETTO"),
    ),
    /** Who generated an UNSIGNED document. The CNPJ is optional: absent, the
     * sentence leaves it out rather than printing one nobody configured. */
    PROOF_ISSUER_LEGAL_NAME: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().default("Trajetto Sistemas Ltda"),
    ),
    PROOF_ISSUER_CNPJ: z.preprocess(
      (value) =>
        typeof value === "string"
          ? value.replace(/\D/g, "") || undefined
          : value,
      z
        .string()
        .refine(isValidCnpj, "PROOF_ISSUER_CNPJ deve ser um CNPJ válido.")
        .optional(),
    ),

    /**
     * The proof's static map (design §5.2): an XYZ template `{z}/{x}/{y}`
     * with optional `{s}`, https. It may carry the provider's key in the
     * query, so it is a SECRET. The attribution is printed on the map and is
     * required with it. Unset: no map, and the page says nothing is missing.
     */
    PROOF_MAP_TILE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    PROOF_MAP_TILE_ATTRIBUTION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    /** Budget for ALL tiles of one map, fetched in parallel. */
    PROOF_MAP_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(200).default(3000),
    ),

    /**
     * The base map of the app's live map (wave 5), served by GET /config/map
     * (src/shared/map/map-tiles.ts): the web's four variables, with the web's
     * values. A Leaflet template, https with {z}, {x} and {y} ({s} optional;
     * http only in development) on a host the app's CSP can name as one
     * origin, and the provider's credit as plain text.
     * The dark style is optional; its credit falls back to the light one.
     * Unset: public OSM in development, no base map elsewhere. The URL may
     * carry the provider's key, which every signed-in client receives (the
     * web hands the same one to every browser): restrict it by origin at the
     * provider, and keep it out of the logs.
     */
    MAP_TILE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    MAP_TILE_ATTRIBUTION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    MAP_TILE_URL_DARK: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    MAP_TILE_ATTRIBUTION_DARK: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    /**
     * Reverse geocoding of the proof's GPS fix (design §5.1): a Nominatim-
     * compatible base URL (our own container or a commercial provider).
     * Unset: the PDF prints the delivery's registered address, labelled as
     * such. The same provider's forward search gives the deliveries'
     * addresses their point (job geocode-deliveries, plan E1): unset, the
     * geofence only judges deliveries with typed or map-pinned coordinates.
     * The key is a SECRET.
     */
    REVERSE_GEOCODER_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    REVERSE_GEOCODER_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    REVERSE_GEOCODER_KEY_PARAM: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().default("key"),
    ),
    REVERSE_GEOCODER_USER_AGENT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    REVERSE_GEOCODER_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(200).default(2500),
    ),

    /**
     * Plan of 02/11/2026 (E1; decision D15): how many delivery addresses
     * the geocode-deliveries job may look up per UTC day, across every
     * replica, on the same provider as the reverse lookup (REVERSE_GEOCODER_*,
     * which must be set for the job to run). The provider has a quota and a
     * price shared with the proof's reverse lookup (LocationIQ's free tier:
     * 5,000 a day), so the default leaves room for it. 0 switches the job off.
     */
    DELIVERY_GEOCODING_DAILY_BUDGET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(1_000_000).default(2000),
    ),

    /**
     * The provider's rate as the geocoder shares it (plano-escala F2-31):
     * the job, the lookup after a commit and the panel's search, across
     * every replica (geocoding-gate.ts). The defaults are LocationIQ's free
     * tier as it ran until 16/11/2026 (2/s and 60/min for the account): one
     * call a second, 50 in any 60 s for the search, 40 for the background
     * paths. A paid plan raises them by env instead of by a release: with
     * the constants, a spreadsheet of 20,000 rows took 8 to 17 hours.
     */
    GEOCODING_CALLS_PER_SECOND: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(1_000)
        .default(GEOCODING_CALLS_PER_SECOND_DEFAULT),
    ),
    GEOCODING_CALLS_PER_MINUTE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(60_000)
        .default(GEOCODING_CALLS_PER_MINUTE_DEFAULT),
    ),
    GEOCODING_BACKGROUND_CALLS_PER_MINUTE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(60_000)
        .default(GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT),
    ),

    /**
     * The minute's job (F2-31): the deliveries one claim takes, and how long
     * one run keeps claiming while each claim comes back full. Below the
     * minute, so a run ends before the next minute's firing; the shutdown
     * also ends it between two claims.
     */
    DELIVERY_GEOCODING_BATCH_SIZE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(GEOCODING_BATCH_SIZE_DEFAULT),
    ),
    DELIVERY_GEOCODING_RUN_BUDGET_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1_000)
        .max(GEOCODING_RUN_BUDGET_MAX_MS)
        .default(GEOCODING_RUN_BUDGET_DEFAULT_MS),
    ),

    /**
     * How many days the provider's NOT_FOUND or COARSE about a door stands
     * for the company's other deliveries at it (plano-escala F2-33): a
     * spreadsheet repeats its doors, and each bad one cost a lookup per
     * delivery. Never across companies. 0 asks the provider for each one,
     * as before.
     */
    GEOCODING_VERDICT_REUSE_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(365)
        .default(GEOCODING_VERDICT_REUSE_DAYS_DEFAULT),
    ),

    /**
     * The proof's reverse lookup on the geocoder's account (plano-escala
     * F2-32; decision D40). It counted nowhere and could lose its second to
     * a spreadsheet's job, and a 429 left the receipt without the GPS
     * address for a day:
     *
     * - RESERVED_PER_SECOND: calls a second only the proof takes (the free
     *   tier's second call, which it had to itself), beside
     *   GEOCODING_CALLS_PER_SECOND;
     * - PROOF_REVERSE_DAILY_BUDGET: its lookups a UTC day; 0 switches the
     *   lookup off (the receipt prints the delivery's address, labelled).
     *   The default keeps the free tier's day within 90%: job 2,000,
     *   search 1,000 and proofs 1,500 of 5,000.
     */
    GEOCODING_PROOF_RESERVED_PER_SECOND: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(1_000)
        .default(GEOCODING_PROOF_RESERVED_PER_SECOND_DEFAULT),
    ),
    PROOF_REVERSE_DAILY_BUDGET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .default(PROOF_REVERSE_DAILY_BUDGET_DEFAULT),
    ),

    /**
     * The LocationIQ plan the account has (decision D40), when the owner
     * writes it down: its calls a second and its lookups a UTC day. The
     * boot then checks that the rates and the budgets the geocoder may
     * spend stay within 90% of them, and the ops heartbeat alerts
     * (geocoding-quota-high) when today's lookups pass 70% of the day.
     * Unset, nothing is checked and nothing alerts (the free tier's 2/s
     * cannot keep a 10% margin with whole calls).
     */
    LOCATIONIQ_RATE_PER_SECOND: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(10_000).optional(),
    ),
    LOCATIONIQ_DAILY_QUOTA: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(100_000_000).optional(),
    ),

    /**
     * The panel's address search ("Fixar no mapa" on the route page): GET
     * /address-search/:businessId asks the provider for suggestions while
     * the dispatcher types (search-address-usecase.ts). A base URL of its
     * own, because LocationIQ serves its autocomplete on
     * https://api.locationiq.com/v1, not on the regional host of
     * REVERSE_GEOCODER_URL. Unset, the search is off: the endpoint answers
     * 503 and the map click still pins.
     *
     * - PROTOCOL: `locationiq-autocomplete` (staging and production) or
     *   `nominatim-search` (a Nominatim of our own, or development).
     * - KEY: a SECRET; unset, the reverse geocoder's (the same account and
     *   the same quota).
     * - DAILY_BUDGET: searches per UTC day for the whole platform, apart
     *   from the job's budget; 0 switches the search off.
     * - BUSINESS_DAILY_LIMIT: searches per UTC day for one company, so a
     *   carrier cannot spend everybody's day.
     * - CACHE_SECONDS: how long an answer is kept per company; LocationIQ's
     *   free tier allows 48 h at most. 0 keeps nothing.
     *
     * The free tier's 5,000 a day are shared: the job (2,000), the search
     * (1,000) and the proof's reverse lookup, which has no budget.
     */
    ADDRESS_SEARCH_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .url({ message: "ADDRESS_SEARCH_URL deve ser uma URL." })
        .optional(),
    ),
    ADDRESS_SEARCH_PROTOCOL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .enum(["locationiq-autocomplete", "nominatim-search"], {
          message:
            "ADDRESS_SEARCH_PROTOCOL aceita locationiq-autocomplete ou nominatim-search.",
        })
        .default("nominatim-search"),
    ),
    ADDRESS_SEARCH_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    ADDRESS_SEARCH_DAILY_BUDGET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(1_000_000).default(1000),
    ),
    ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(1_000_000).default(150),
    ),
    ADDRESS_SEARCH_CACHE_SECONDS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(172_800, {
          message:
            "ADDRESS_SEARCH_CACHE_SECONDS vai até 172800 (48 h), o máximo que o plano grátis do LocationIQ permite guardar.",
        })
        .default(172_800),
    ),

    // AI readings: the local OCR service trajetto-ai (ADR 0010, 05/10/2026).
    //
    // `local` reads with the service at AI_LOCAL_URL; without the URL or the
    // token it behaves as `none` (records marked skipped, nothing queued).
    // `none` switches the readings off. A leftover `anthropic` FAILS the boot
    // with the reason, instead of silently switching the AI off: the external
    // provider was removed (decision 14.1). Empty counts as absent.
    AI_PROVIDER: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .enum(["local", "none"], {
          error:
            "AI_PROVIDER aceita local ou none: o provedor anthropic foi removido (ADR 0010). Use local com AI_LOCAL_URL e AI_LOCAL_TOKEN.",
        })
        .default("local"),
    ),

    /** The trajetto-ai service: http://trajetto-ai:8080 on the stack network. */
    AI_LOCAL_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),

    /**
     * Bearer token of every call to the service (its AI_TOKEN, the same
     * value). 32+ characters: `openssl rand -hex 32`. Never logged.
     */
    AI_LOCAL_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .min(
          32,
          "AI_LOCAL_TOKEN precisa de 32+ caracteres (openssl rand -hex 32)",
        )
        .optional(),
    ),

    /**
     * One call's budget. It enters the lease invariant (photo fetch + this
     * must fit in the 300 s lease): a value that does not fit stops the boot.
     */
    AI_LOCAL_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().default(LOCAL_AI_DEFAULT_TIMEOUT_MS),
    ),

    // Reads in flight per replica: the service reads one at a time, so 1
    // while there is one trajetto-ai instance. The ceiling was 4; it follows
    // the queue's (plano-escala F3-05), because a worker in front of several
    // AI instances keeps one reading in flight per instance. The pipeline
    // takes the smaller of this and AI_CONCURRENCY.
    AI_LOCAL_MAX_CONCURRENCY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(QUEUE_CONCURRENCY_MAX)
        .default(LOCAL_AI_DEFAULT_MAX_CONCURRENCY),
    ),

    // What this process is (plano-escala F3-01, decision D15): a preset and
    // a label, with every variable below given explicitly winning over the
    // preset (shared/lifecycle/process-role.ts has the table). Unset, the
    // process is `all`, today's replica that runs everything; a legacy
    // WORKERS_ENABLED=false makes it `api`. A name outside the list fails
    // the boot: a typo must not turn a worker into a copy of the API.
    // Empty counts as absent.
    PROCESS_ROLE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(PROCESS_ROLES).optional(),
    ),

    // Whether this replica runs the background workers at all: the
    // notification and AI pipelines, the webhook dispatcher and the cron
    // (GAP2-3). The master switch: with `false`, no queue and no cron,
    // whatever WORKER_QUEUES and CRON_ENABLED say. Absent, the role's
    // preset decides (`true` for all). Empty counts as absent.
    WORKERS_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).optional(),
      )
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),

    // Whether this process runs the cron (plano-escala F3-01). The election
    // already keeps one run per firing however many processes run it; the
    // variable keeps the cron's queries off the processes that should not
    // pay for them (the API once a worker exists, the worker once a
    // scheduler exists). Absent, the role's preset decides (`true` for all,
    // as before). Empty counts as absent.
    CRON_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).optional(),
      )
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),

    // Which queues this process claims (plano-escala F3-01): a
    // comma-separated list of outbox, internal, external, webhooks, ai and
    // jobs, or `none`. Absent means every queue, as before; `none` is how a
    // scheduler says "the cron and nothing else". An unknown name fails the
    // boot: a typo would leave a queue with no process. Empty counts as
    // absent.
    WORKER_QUEUES: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z
        .string()
        .superRefine((value, ctx) => {
          const parsed = parseWorkerQueues(value);

          if ("error" in parsed) {
            ctx.addIssue({ code: "custom", message: parsed.error });
          }
        })
        .transform((value) => {
          const parsed = parseWorkerQueues(value);

          return "queues" in parsed ? parsed.queues : [];
        })
        .optional(),
    ),

    // Whether Socket.IO admits connections on this process (plano-escala
    // F3-02). With `false`, the upgrade is refused at the engine with
    // SOCKET_UNAVAILABLE, before any budget and without charging the
    // address; the server and its Redis adapter stay up, so what this
    // process emits still reaches the sockets of the others. Absent, the
    // role's preset decides (`true` for all and api, `false` for worker).
    // Empty counts as absent.
    SOCKETS_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).optional(),
      )
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),

    // The pipelines' background sweep. 30 s while every replica wakes its
    // own pipelines on publish; a dedicated worker polls faster (the worker
    // preset sets 2 s), because a publish on an HTTP replica does not wake
    // it in this process. Absent, the role's preset decides.
    PIPELINE_SWEEP_INTERVAL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(500).optional(),
    ),

    // The webhook dispatcher's sweep (plano-escala F3-01): 5 s, as it was
    // hard-coded; 2 s in the worker preset. Absent, the role's preset
    // decides. Empty counts as absent.
    WEBHOOK_SWEEP_INTERVAL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(500).max(60_000).optional(),
    ),

    // How many rows of each queue this process works on at once
    // (plano-escala F3-05; shared/lifecycle/queue-config.ts). Absent, the
    // constants of before: 5 per delivery lane, 1 outbox event at a time, 5
    // webhooks and 4 AI readings. 1 to 32; the lanes and the webhooks also
    // check, when their module loads, that a batch still fits its lease
    // with the value given (below 2 it does not, and the boot stops). Empty
    // counts as absent.
    NOTIFICATION_INTERNAL_CONCURRENCY: queueConcurrency(
      "NOTIFICATION_INTERNAL_CONCURRENCY",
    ),
    NOTIFICATION_EXTERNAL_CONCURRENCY: queueConcurrency(
      "NOTIFICATION_EXTERNAL_CONCURRENCY",
    ),
    OUTBOX_EXPANSION_CONCURRENCY: queueConcurrency(
      "OUTBOX_EXPANSION_CONCURRENCY",
    ),

    /**
     * How the outbox turns events into deliveries (plano-escala F5-33,
     * shared/notifications/notification-pipeline-service.ts). `per-event`
     * (the default): one event per expansion, as before, with
     * OUTBOX_EXPANSION_CONCURRENCY of them at once. `batch`: a claim of 50
     * events expanded together, with one preference query and one
     * push-device query for all of them, one INSERT of their deliveries
     * and one PUBLISHED mark fenced per event; one batch at a time per
     * process, and a batch whose write fails is written again event by
     * event. The same rows either way. Staging first; production only
     * after seven days of staging and the gate's ABBA. Empty counts as
     * absent.
     */
    OUTBOX_EXPANSION_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["per-event", "batch"]).default("per-event"),
    ),
    WEBHOOK_CONCURRENCY: queueConcurrency("WEBHOOK_CONCURRENCY"),
    AI_CONCURRENCY: queueConcurrency("AI_CONCURRENCY"),

    // Webhook calls in flight to ONE endpoint, per process (plano-escala
    // F3-07): 2 by default, the constant of before. A slow endpoint holds
    // this many of the process's calls and nothing else; its other rows
    // wait in the pool while other endpoints' rows go out. Each process
    // that claims the webhooks runs its own, so the endpoint receives this
    // times the dispatchers at once. Any value fits the lease. Empty
    // counts as absent.
    WEBHOOK_PER_ENDPOINT_CONCURRENCY: queueConcurrency(
      "WEBHOOK_PER_ENDPOINT_CONCURRENCY",
    ),

    // The providers' global concurrency caps (plano-escala F3-15a; decision
    // D45; shared/notifications/provider-caps.ts): sends in flight to Meta
    // (WhatsApp), to the e-mail provider and to Expo (push) across every
    // process that claims their lane. Each process takes floor(cap /
    // divisor), never below 1, where the divisor is the live processes of
    // the lane (process_heartbeat), the most seen in the last ten minutes
    // and ROLE_EXPECTED_CONSUMERS, whichever is greatest, and stays as it
    // was when the read fails: a database hiccup must not make every
    // process think it is alone and go past the provider's contract. 0
    // (the default) is no global cap: the lane's own concurrency per
    // process, as before. Empty counts as absent.
    WHATSAPP_GLOBAL_CONCURRENCY: providerGlobalConcurrency(),
    EMAIL_GLOBAL_CONCURRENCY: providerGlobalConcurrency(),
    PUSH_GLOBAL_CONCURRENCY: providerGlobalConcurrency(),

    // Each company's daily WhatsApp quota (plano-escala F3-15b; decision
    // D46; shared/notifications/whatsapp-daily-quota.ts): messages a day,
    // counted per call to Meta in provider_quota_day (scope
    // whatsapp:<businessId>) on the company's business day. Past it, the
    // message waits, without spending an attempt, for the company's next
    // business day, never falls back to e-mail, and the admins get one
    // notice in the bell that day. 0 (the default) is no quota, until the
    // conversation with Meta about the portfolio's messaging tier. Empty
    // counts as absent.
    WHATSAPP_DAILY_QUOTA_PER_TENANT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(1_000_000).default(0),
    ),

    // The owner's floor for the divisor of the providers' global caps
    // (above): how many processes are expected to claim a provider lane
    // (2 once the trajetto-worker runs two replicas). A process that has
    // not seen the others yet (the first seconds after a deploy, a
    // heartbeat table that cannot be read) divides by at least this. 0
    // (the default) leaves the floor at 1. Empty counts as absent.
    ROLE_EXPECTED_CONSUMERS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(64).default(0),
    ),

    // The providers' RATE across every process (plano-escala F3-15c;
    // decision D45; shared/notifications/provider-rate-bucket.ts): sends a
    // second to Meta (WhatsApp), requests a second to the e-mail provider,
    // and notifications a second to Expo (a push to three phones is three).
    // The global caps above bound the sends in flight, never the sends a
    // second: four slots of 100 ms sends are ~40 a second against Resend's
    // 10. A GCRA bucket in Redis spaces them; a send whose place is more
    // than a second away goes back to the queue without spending an
    // attempt, and a provider's 429 (Meta's 130429) holds every process
    // for its pause, the row waiting too, without spending an attempt.
    // Without Redis, each process keeps its share (rate / the lane's live
    // processes). 0 (the default) is off: no Redis connection, no pacing,
    // a 429 handled as before. Proposed once a 429 shows up: 60, 8 and
    // 500, under the contracts' 80, 10 and 600. Empty counts as absent.
    WHATSAPP_SENDS_PER_SECOND: providerRatePerSecond(),
    EMAIL_REQUESTS_PER_SECOND: providerRatePerSecond(),
    PUSH_NOTIFICATIONS_PER_SECOND: providerRatePerSecond(),

    // Push deliveries per call to Expo (plano-escala U-06;
    // shared/notifications/push-batch-gate.ts). Each push row used to be
    // one POST, so a slot of the internal lane carried one delivery per
    // round trip to Expo. From 2 up, a push row started while its lane has
    // a backlog (the claim that brought it came back full) claims up to
    // this many minus one other due push rows, and the group goes in calls
    // of up to 100 messages; each row keeps its own checks, its own
    // tickets (by position, never another row's) and its own fenced
    // settling, and a 5xx from Expo puts the group back without spending
    // an attempt. The group's rows take one database turn at a time
    // (push-group-turn.ts), so a group costs the pool what its slot does.
    // 1 (the default) is one call per delivery, as before.
    // Empty counts as absent.
    PUSH_BATCH_SIZE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(100).default(1),
    ),

    // Webhook calls in flight to ONE endpoint across every process that
    // claims the webhooks (plano-escala F3-13; decision D8): the claim
    // counts the endpoint's rows in flight under a live lease, under a
    // lock taken only for the claim, and takes no more than this leaves.
    // With one process per Application and the per-process cap above, a
    // second dispatcher (worker ×2, or the api replicas that still
    // dispatch) would otherwise multiply what a customer's ERP receives at
    // once. 4 by default: what production's two api replicas at 2 each
    // already send, so nothing changes until a dispatcher is added. The
    // owner confirms it with the receiver's rate (Comprovei/Fusion). 0
    // turns the cap off: the claim of before, oldest first. Empty counts
    // as absent.
    WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(64).default(4),
    ),

    // Webhook calls in flight to ONE destination host, across every
    // endpoint pointed at it and every dispatcher (plano-escala F3-14;
    // decision D8): an aggregator's ERP (Comprovei/Fusion) gets one
    // endpoint per tenant at the same host, and the cap per endpoint alone
    // would let it receive four times its tenants at once. 16 by default,
    // confirmed by the owner with the receiver's rate. Only with the cap
    // per endpoint on (above), whose claim applies it; an endpoint with no
    // host recorded yet has no host cap. 0 turns it off. Empty counts as
    // absent.
    WEBHOOK_HOST_GLOBAL_CONCURRENCY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(256).default(16),
    ),

    // The spreadsheet read off the event loop (plano-escala F3-23b;
    // modules/import/services/spreadsheet-worker.ts): how many worker
    // threads may read an upload at once in this process (0 reads on the
    // main thread, inside the main heap, as before), each thread's heap
    // ceiling in MB, and how long one read may take. A workbook past the
    // ceiling ends its thread with a sentence for the operator instead of
    // taking the process down. The memory budget of the process counts
    // reads × ceiling (U-15). Empty counts as absent.
    SPREADSHEET_READS_PER_PROCESS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(4).default(1),
    ),
    SPREADSHEET_WORKER_MAX_OLD_MB: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(64).max(768).optional(),
    ),
    SPREADSHEET_READ_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(5_000).max(600_000).default(60_000),
    ),

    // The spreadsheet import as a durable job (plano-escala F3-23a;
    // modules/import/services/spreadsheet-import-job.ts). Off, an upload is
    // processed in the memory of the replica that answered it, as before:
    // a deploy hands it back, a SIGKILL leaves it for the abandoned-import
    // sweep. On, the file goes to storage and the import to background_job,
    // where the process that consumes the `jobs` queue reads it and decides
    // the rows from a cursor that a SIGKILL resumes without doing a row
    // twice. The same value on every Application: an api with it on and a
    // worker without would enqueue jobs nobody runs (the job-overdue alert
    // says so). The in-memory path stays for two releases (U-10).
    //
    // Each company may have IMPORT_RUNNING_PER_TENANT imports running at
    // once and IMPORT_QUEUED_PER_TENANT more waiting; past that the upload
    // is refused with 429 IMPORT_BUSY and Retry-After, before anything is
    // written. Empty counts as absent.
    IMPORT_DURABLE_JOBS: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),
    IMPORT_RUNNING_PER_TENANT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(4).default(1),
    ),
    IMPORT_QUEUED_PER_TENANT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(20).default(5),
    ),

    // Rows per transaction of the durable import (plano-escala F3-23c):
    // each batch writes its deliveries, their webhook rows and the job's
    // cursor in one short transaction, far below the 4 minutes a writer of
    // delivery_event may hold one (U-16); a batch that fails is redone row
    // by row, the way of before. 1 is row by row. Only with
    // IMPORT_DURABLE_JOBS. Empty counts as absent.
    IMPORT_ROWS_PER_TRANSACTION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(500).default(100),
    ),

    // The CPU pool (plano-escala F3-29; shared/cpu-pool): the NF-e parse and
    // the Excel export's workbook run on worker threads instead of the
    // request's event loop. CPU_POOL_THREADS threads at most, started on
    // first use (0 = in process, as before), each with a heap of
    // CPU_POOL_THREAD_MAX_OLD_MB, which the memory budget counts;
    // CPU_POOL_MAX_PENDING calls waiting for a thread, past which the call
    // is refused with 503 CPU_POOL_BUSY; CPU_POOL_TIMEOUT_MS for a call to
    // get a thread and for the thread to answer (one that does not is
    // replaced). A workbook never waits for a thread: with none free for it
    // (all but one at most hold workbooks), it is built in process, as
    // before. Empty counts as absent.
    CPU_POOL_THREADS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(8).default(2),
    ),
    CPU_POOL_MAX_PENDING: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(256).default(16),
    ),
    CPU_POOL_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1_000).max(120_000).default(20_000),
    ),
    CPU_POOL_THREAD_MAX_OLD_MB: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(16)
        .max(1_024)
        .default(CPU_POOL_THREAD_DEFAULT_MAX_OLD_MB),
    ),

    // The process's memory budget, checked at boot (plano-escala U-15;
    // shared/lifecycle/memory-budget.ts): the main heap, the spreadsheet
    // threads and this reserve for what V8 and the native libraries hold
    // outside every heap, against the container's memory.max. `warn` (the
    // default of this release) logs, flags /health/metrics and alerts;
    // `enforce` refuses the boot, and becomes the default only once the
    // Environments carry the plan's values (wave 20). Empty counts as
    // absent.
    NATIVE_RESERVE_MB: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(4_096)
        .default(NATIVE_RESERVE_DEFAULT_MB),
    ),
    MEMORY_BUDGET_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(MEMORY_BUDGET_MODES).default("warn"),
    ),

    // The bytes every tenant snapshot of the process may hold together
    // (plano-escala F4-10, shared/cache/tenant-snapshot.ts; ADR 0002,
    // addendum of 19/11/2026): the per-company copies of the screens every
    // operator polls, in this process's memory only. Least recently used
    // out first, never more than an eighth of the heap whatever this says
    // (it lives inside --max-old-space-size, so the memory budget needs no
    // new term), and 0 turns the snapshots off. 64 MiB; the ceiling of
    // 1 GiB refuses a value typed in the wrong unit. Literals, not the
    // module's constants: that module reads env, and the unit test holds
    // the two equal. Empty counts as absent.
    TENANT_SNAPSHOT_MAX_BYTES: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(1024 * 1024 * 1024)
        .default(64 * 1024 * 1024),
    ),

    // How long the control tower, the operation summary and the first page
    // of /route/live are served from the company's snapshot, in ms
    // (plano-escala F4-11, decision D2 of 15/11/2026): every operator of a
    // carrier polls the same three answers, and each process reads them
    // once per interval instead of once per operator. The answer can be up
    // to this old, the same for everyone of the company; the permission
    // and the company are still checked on every request, before it. 0
    // turns the snapshot off: each request reads alone, as before, without
    // ETag nor 304. 10 s; the ceiling of 60 s keeps a typo from freezing
    // the tower for minutes. Empty counts as absent.
    TOWER_SNAPSHOT_TTL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(60_000).default(10_000),
    ),

    // Where the overview and the trends take the "Entregas" series from
    // (plano-escala F4-22, decision D52; modules/dashboard/usecases/shared/
    // delivery-rollup.ts). `shadow`, the default, serves the live count as
    // before and compares it, after the answer and one view at a time per
    // process, with the closed days the tenant-day-rollup job stores: what
    // differs is counted in /health/metrics (dashboard_rollup) and logged.
    // `on` serves the stored days plus a live count of the rest (today, a
    // day not stored or changed since): the same numbers without reading
    // months of deliveries on every view, switched on by the owner after
    // seven days of shadow with no divergence. `off` neither reads nor
    // compares (the shadow's own kill switch). Read on every view, so a
    // test can flip it; in a deployment, changing it is a redeploy. Empty
    // counts as absent.
    DASHBOARD_ROLLUP_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["off", "shadow", "on"]).default("shadow"),
    ),

    // How long a company's overview numbers and trend charts are served
    // from its snapshot, in ms (plano-escala F4-23, decision D2 of
    // 15/11/2026; modules/dashboard/usecases/shared/dashboard-snapshot.ts):
    // the heaviest reads of the panel, repeated by every manager who opens
    // it, read once per interval in each process. Keyed by the company and
    // by what the viewer's profile may see, so two viewers share a copy
    // only when they would be shown the same numbers; the recent activity,
    // which names people, is read on every view. 0 turns it off: each view
    // reads alone, as before. 60 s, which is also the ceiling decision D2
    // accepted for this screen. Empty counts as absent.
    DASHBOARD_SNAPSHOT_TTL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(60_000).default(60_000),
    ),

    // The graceful shutdown (plano-escala F1-14). STOP_GRACE_PERIOD_MS is the
    // Stop Grace Period the Swarm really gives this service, in ms: every
    // deadline of the sequence is derived from it (shared/lifecycle/
    // shutdown-plan.ts). Absent, Docker's own 10 s is assumed and the
    // sequence ends in under 9 s; set it to the service's value only once
    // `docker service inspect` shows it (verify-rollout fails the deploy when
    // the variable passes the service's grace). 40000 gives the 35 s
    // watchdog, the 12 s drain and the 15 s import grace the Application was
    // sized for.
    STOP_GRACE_PERIOD_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(MIN_STOP_GRACE_PERIOD_MS)
        .max(MAX_STOP_GRACE_PERIOD_MS)
        .default(DEFAULT_STOP_GRACE_PERIOD_MS),
    ),

    // How many requests one keep-alive connection serves before its last
    // response says `Connection: close` (plano-escala F1-15): the Swarm
    // spreads connections, not requests, and without a cap a replica added
    // by a scale-up kept almost no traffic (config/http-server.ts). 0 turns
    // it off, the rollback. Empty counts as absent.
    HTTP_MAX_REQUESTS_PER_SOCKET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .default(HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT),
    ),

    // Optional overrides of the derived figures, for an incident or a
    // measurement (a replica with no sockets can drain for less). Checked
    // with the rest of the plan below: one that would not end before the
    // SIGKILL fails the boot. Empty counts as absent.
    SHUTDOWN_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1_000)
        .max(MAX_STOP_GRACE_PERIOD_MS)
        .optional(),
    ),
    SHUTDOWN_DRAIN_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(MAX_STOP_GRACE_PERIOD_MS).optional(),
    ),
    IMPORT_DRAIN_GRACE_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(MAX_STOP_GRACE_PERIOD_MS).optional(),
    ),
    SHUTDOWN_WORKERS_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(MAX_STOP_GRACE_PERIOD_MS).optional(),
    ),

    // The scale plan's per-minute series (plano-escala F1-08): each process
    // writes one ops_sample row a minute, 0–15 s after the minute ends, and
    // a failed write never stops the process (fail-open). On by default:
    // the 14 days of series start with the deploy. `false` is the rollback,
    // and stops only the write — the minute log line stays.
    OPS_SAMPLE_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((value) => value === "true"),

    // The ops heartbeat's database rules (plano-escala F1-11).
    // PITR_EXPECTED says WAL archiving is meant to be on: with it true,
    // archive_mode other than on pages. False by default, and switched on
    // by hand once the environment's pgBackRest setup is done (F1a on
    // staging, F1b on production), so a database that never archived pages
    // nobody. An archiver that IS on is judged either way (stopped for
    // 300 s, or its latest attempt failed).
    PITR_EXPECTED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // A write transaction open this long pages: it holds the vacuum back
    // and, with the integration feed, the feed. 120 s while the import
    // reversal still runs its 60 s transaction inside HTTP; 60 once that
    // becomes a job (wave 14).
    LONG_WRITE_XACT_ALERT_SECONDS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(10).max(3_600).default(120),
    ),

    // The integration feed's floor (plano-escala U-16, F2-05): each page of
    // /integration/v1/events starts its index scan at the created_at of the
    // last event it served minus this margin. A trigger refuses an INSERT
    // into delivery_event more than 240 s into its transaction, so an event
    // not served yet was written at most 240 s before the last one; twice
    // that is the least the boot accepts (feedFloorMarginProblem), the rest
    // absorbing the clocks of the API and the database. 10 min by default.
    FEED_FLOOR_MARGIN_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .max(86_400_000)
        .default(FEED_FLOOR_DEFAULT_MARGIN_MS)
        .superRefine((value, ctx) => {
          const problem = feedFloorMarginProblem(value);

          if (problem) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
          }
        }),
    ),

    // The order of /integration/v1/events (plano-escala F2-05). "id" is
    // the walk every release before this one does, with the legacy cursor;
    // "commit" walks in commit order (delivery_event.txid, up to the oldest
    // transaction still open) and emits the v2 cursor, so no event that
    // commits late is ever skipped. "id" by default because the image
    // before this one cannot read a v2 cursor: during the rolling deploy,
    // or after a rollback to it, an integrator holding one would get empty
    // pages. Switched to "commit" by hand once this release serves alone
    // in the environment; from then on the rollback floor is this release.
    INTEGRATION_FEED_ORDER: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["id", "commit"]).default("id"),
    ),

    // /integration/v1/events on the standby (plano-escala F4-43): with
    // `true`, the commit walk (INTEGRATION_FEED_ORDER=commit) reads its
    // pages on DATABASE_REPLICA_URL while the replica guard vouches for it,
    // its horizon being the standby's own pg_current_snapshot(); the id
    // walk and every other read of the feed stay on the primary. A page the
    // standby fails is served by the primary. `false` (the default): the
    // feed reads the primary, as before, whatever the replica does. Empty
    // counts as absent.
    INTEGRATION_EVENTS_READ_REPLICA: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // How far behind the request /integration/v1/deliveries and /routes put
    // their sync_watermark (plano-escala F2-05): the updated_since to use
    // for the next sync. A row's updated_at is the moment its writer built
    // it, and the write commits later (60 s at most, the import reversal),
    // on a replica whose clock may differ; 2 min covers both. At least 60 s.
    // The standby's own delay is not in it: with DATABASE_REPLICA_URL the
    // watermark goes back up to 24 s more on its own (the replica guard's
    // bound, integration-read-controller.ts).
    SYNC_WATERMARK_MARGIN_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(60_000).max(86_400_000).default(120_000),
    ),

    // pg_wal past this many GiB pages: it lives on the disk both
    // productions share, and an archive that cannot reach R2 grows it.
    // Normal use is 1-2 GB; 12 by default, 8 on the single VPS.
    PG_WAL_ALERT_GIB: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().positive().max(1_024).default(12),
    ),

    // The ramp's gauge (plano-escala U-12): the monthly deliveries the
    // newest approved load report in docs/desempenho proved this hardware
    // takes. The ops heartbeat alerts (volume-near-gate) when the last 7
    // days, projected to a month, pass 70% of it; nothing is refused.
    // 10 000 is today's step, and it only moves with a new report.
    APPROVED_GATE_MONTHLY_DELIVERIES: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().default(10_000),
    ),

    // Deliveries in the last 24 h past this alert too (the same code):
    // a soft cap on a day's peak while the ramp is young. Empty or absent
    // is no cap. Only an alert: nothing is refused.
    PLATFORM_DAILY_DELIVERY_SOFT_CAP: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),

    // How many statements the hourly pg_stat_statements snapshot keeps
    // (plano-escala F1-12): the most expensive of the hour by execution
    // time. 200 covers the whole application's statements many times over
    // and keeps the table at about 4.800 rows a day.
    PGSS_SNAPSHOT_TOP: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(5_000).default(200),
    ),

    // How many days the scale plan's series are kept (plano-escala F1-13):
    // the nightly purge-ops-series job removes older rows of ops_sample and
    // pgss_snapshot in batches. 30 covers the 30 days the burn-rate alerts
    // and the capacity triggers look back on; under 14 is refused, because
    // no trigger is judged on fewer than 14 days of series.
    OPS_SAMPLE_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(14).max(3_650).default(30),
    ),
    PGSS_SNAPSHOT_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(14).max(3_650).default(30),
    ),

    // The GPS trail's partitions (plano-escala F2-08): how many days of
    // the trail are kept, in both of its tables (driver_position_v2 and the
    // legacy driver_position, F2-10), and how many days ahead the nightly
    // partition-maintenance job keeps partitions made. 90 days is the
    // retention the trail always had; lower it only once the trail archive
    // (F2-11) copies a day before its partition is dropped, because a
    // dropped day is gone. The lookahead can only grow: under 7 days, the
    // partition-lookahead-low alert (under 5 days ahead) would fire before
    // every nightly run.
    DRIVER_POSITION_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(3_650).default(90),
    ),
    DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(7).max(60).default(7),
    ),

    // How many days ahead the partition job keeps the four queues' daily
    // partitions (plano-escala F5-07), once the swap of F5-09 made them
    // partitioned; until then it changes nothing. A week by default, as
    // the trail: under 7 the partition-lookahead-low alert (under 5 days
    // ahead) would fire before every nightly run.
    QUEUE_PARTITION_LOOKAHEAD_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(7).max(60).default(7),
    ),

    // The trail's archive (plano-escala F2-11, decision D3): with
    // TRAIL_ARCHIVE_ENABLED=true, the partition job copies a day of the
    // trail to the ARCHIVE bucket (one gzipped CSV per company, written
    // down in archive_manifest) before dropping it, and keeps the day when
    // the copy does not add up. Off by default: the job drops as it always
    // did until the bucket exists. The archive has a bucket and a token of
    // its own (never the uploads' ones: that bucket's objects must not
    // expire), on the uploads' R2 account (R2_ACCOUNT_ID, or R2_ENDPOINT).
    // Enabled without them, the boot only warns, and the job keeps every
    // expired day instead of dropping it unarchived (the partition-stuck
    // alert follows). STANDARD_IA by default: the archive is written once
    // and read only for a dispute or a legal request.
    // TRAIL_ARCHIVE_RETENTION_DAYS is the archive bucket's Expiration rule
    // on `trail/`, set by hand in R2 to the same number; the code purges
    // the manifest rows a week after their objects expire.
    TRAIL_ARCHIVE_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),
    TRAIL_ARCHIVE_BUCKET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    ARCHIVE_R2_ACCESS_KEY_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    ARCHIVE_R2_SECRET_ACCESS_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    ARCHIVE_STORAGE_CLASS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(ARCHIVE_STORAGE_CLASSES).default("STANDARD_IA"),
    ),
    TRAIL_ARCHIVE_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(30).max(3_650).default(180),
    ),

    // The delivery history's archive (plano-escala F5-16,
    // shared/archive/history-archive.ts): with true, the partition job
    // hands every closed month of delivery_event and activity (and the
    // `_older` partition of the copy window) to a PARTITION_ARCHIVE job,
    // which copies it to the archive bucket (the trail's: the same bucket,
    // token and storage class), one gzipped CSV per company under
    // `archive/<table>/<yyyymm>/`, written down in archive_manifest with
    // its count and sha256. A copy only: nothing is deleted from the
    // database (the DROP is F5-17, off until the lawyer's opinion), and a
    // table still plain (before its copy window) is left alone. Off by
    // default; enabled without the bucket or the token, the boot only
    // warns and nothing is archived. At most two months per table a night.
    HISTORY_ARCHIVE_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // The history's DROP (plano-escala F5-17, decision D3, a legal flag):
    // with true, the partition job detaches and drops a partition of
    // delivery_event or activity HISTORY_ATTACHED_MONTHS after it ends, and
    // only when its archive (F5-16) was written again after it became due
    // and its manifest adds up to a count taken that night; otherwise the
    // month stays attached and is archived again. False, the default,
    // until the lawyer's opinion: nothing of the history is ever deleted.
    // Needs HISTORY_ARCHIVE_ENABLED: without the archive nothing is
    // verified, so nothing leaves.
    HISTORY_DROP_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),
    // Months of history kept in the database, counted from a partition's
    // end (31 days a month, so never fewer). 12 to 120.
    HISTORY_ATTACHED_MONTHS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(12).max(120).default(24),
    ),
    // Years the archive keeps the history (the legal term, decision D3):
    // the archive bucket's Expiration on `archive/`
    // (infra/r2/archive-lifecycle.json, applied only after the opinion)
    // is set to no less than this. It must outlast the months kept
    // attached, or the archive would expire before the DROP.
    HISTORY_ARCHIVE_RETENTION_YEARS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(30).default(5),
    ),

    // The trail's submission keys (plano-escala F2-14, decision D3): days
    // a row of delivery_event_submission is kept before the nightly
    // cleanup-delivery-event-submissions removes it. A key only matters
    // while the driver app could still resend it; under 30 is refused,
    // because a phone left off for weeks still flushes its outbox, and a
    // resend past the purge would become a second event once the legacy
    // unique goes (wave 11).
    DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(30).max(3_650).default(90),
    ),

    // The status lines a delivery gets by itself (plano-escala F2-06): with
    // true, its creation writes a STATUS_CHANGE from nothing to PENDING, and
    // what a route moves on its own (the departure, a stop added to a
    // running route, the return of a route cancelled or closed with
    // pending stops, the app's old batch departure) writes a SYSTEM
    // STATUS_CHANGE per delivery that moved. Off by default, because the
    // image before this release, which still serves during the rolling
    // deploy and is the target of a code rollback, reads those lines as
    // work and as a person's change: its import undo would keep every
    // delivery the import made, its /integration/v1/events would announce
    // the creation as `delivery.pending`, its tower could no longer approve
    // an occurrence the departure followed, and its tower feed would fill
    // with them. On once that image is gone for good (docs/deploy.md). The
    // departure's `delivery.in_transit` webhooks do not depend on it.
    DELIVERY_STATUS_TRAIL_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // How long the notification family is kept (plano-escala F5-11): the
    // events, their deliveries and the receipts, 30 days as the nightly
    // purge always kept them. Once the swap of F5-09 made the three
    // partitioned, a day leaves whole after this many days (DETACH and
    // DROP in the partition-maintenance job), never with a row in flight
    // and with its failures copied to the dead letters first; before the
    // swap, and for the plain tables' rows of before it, the purge in
    // batches follows the same number. Under 30 is refused: a receipt
    // nobody claims is anchored up to 30 days back (receipt-id.ts) and
    // would land in a day already dropped. Over 90 too: a FAILED event
    // leaves for its dead letter at this age, and the dead letter keeps it
    // OUTBOX_FAILED_RETENTION_DAYS from the failure, which must be longer.
    OUTBOX_PUBLISHED_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(30).max(90).default(30),
    ),

    // How long the webhook ledger keeps a row (plano-escala F5-12): the
    // nightly purge in batches deletes the settled rows older than this
    // and, once the swap of F5-09 made webhook_delivery partitioned, the
    // partition-maintenance job drops whole days past it, never one with a
    // row the dispatcher still owns. At least the replay window
    // (REPLAY_WINDOW_DAYS, 30) plus a day: a resend of anything younger
    // than 30 days is accepted, from its created_at, and the day of grace
    // keeps a row a person sees as resendable from vanishing before the
    // click. 31 is what the job always kept.
    WEBHOOK_DELIVERY_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(31).max(365).default(31),
    ),

    // The claims' floor of ids in flight (plano-escala F5-13, the plan B of
    // the 39-partition gate). A claim of a partitioned queue names no id,
    // so it plans and probes every day the retention keeps, several times
    // a second on every replica. On, each claim also asks for ids at or
    // above the start of the day of the oldest row in flight (never later
    // than yesterday), read again every 30 s, which prunes the days that
    // hold nothing to claim. Off by default: the claims stay what they
    // always were until the owner measures the plans on staging. A floor
    // that cannot be read is none, and a plain queue gets none.
    QUEUE_CLAIM_ID_FLOOR_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // The fair claim by company (plano-escala F3-10, F3-11 and F3-12;
    // shared/queue/fair-claim.ts): the delivery lanes, the outbox and the
    // AI queue (each company's receipts before its other kinds) take their
    // rows company by company from a rotating cursor, at most
    // QUEUE_FAIR_ROWS_PER_TENANT of one company and QUEUE_FAIR_MAX_TENANTS
    // companies visited per claim, the oldest due rows filling what the
    // walk did not. A carrier that fires twenty thousand notices then no
    // longer puts every other company's message behind them. Off by
    // default: the claims stay the oldest-first of before until the owner
    // turns it on in staging and reads the queues' latency. Read on every
    // claim, so the switch needs no restart of the logic, only of the
    // Environment. Empty counts as absent.
    QUEUE_FAIR_CLAIM_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),
    QUEUE_FAIR_ROWS_PER_TENANT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(20).default(2),
    ),
    QUEUE_FAIR_MAX_TENANTS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(512).default(64),
    ),

    // Days a queue's partition may stay past its retention before the
    // partition-stuck alert pages (plano-escala F5-11). A day held by a
    // row in flight is a queue that stopped, worth a look after three
    // nights, as any other stuck partition.
    QUEUE_PARTITION_STUCK_ALERT_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(30).default(3),
    ),

    // The dead letters' retention (plano-escala F5-10): days a failure is
    // kept, counted from when it gave up — a FAILED outbox event (in the
    // queue table for 30 days, then in outbox_event_dead_letter) and a
    // FAILED delivery (notification_dead_letter) — before the nightly
    // cleanup-notification-pipeline removes it. 90 is what the job always
    // kept. Over 30 only: a FAILED event leaves the queue table at 30 days,
    // and a retention of 30 or less would expire it the night it is
    // copied.
    OUTBOX_FAILED_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(31).max(3_650).default(90),
    ),

    // The durable jobs' retention (plano-escala F3-22): days a finished
    // background_job row is kept, counted from when it ended, before the
    // nightly cleanup-background-jobs removes it. A success is only the
    // trace of what ran (30); a failure is what somebody comes back to read
    // (90). The job's own record (the upload, the company) keeps its trail.
    BACKGROUND_JOB_SUCCEEDED_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(3_650).default(30),
    ),
    BACKGROUND_JOB_FAILED_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(3_650).default(90),
    ),

    // Days between a MASTER scheduling a company's purge and the purge
    // (plano-escala F3-25): the company is inactive at once, its admins are
    // told then and 7 days before, and until the day comes the MASTER can
    // reactivate it with everything in place. The purge is irreversible, so
    // never less than 8 days (the reminder goes 7 days before). Empty counts
    // as absent.
    TENANT_PURGE_AFTER_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(8).max(365).default(30),
    ),

    // Whether a company's purge (plano-escala F3-26a) deletes its GPS trail
    // now, driver by driver through the trail's primary key, instead of
    // leaving it to the DROP of its daily partitions
    // (DRIVER_POSITION_RETENTION_DAYS). Off by default: the company has
    // been inactive since the purge was scheduled, so its trail is days
    // from its DROP anyway, and the batches of the trail are the heaviest
    // of the purge. On for a legal request that cannot wait. Empty counts
    // as absent.
    TENANT_PURGE_TRAIL_NOW: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("false"),
      )
      .transform((value) => value === "true"),

    // The bell's retention (plano-escala F5-14): days a read notification
    // and an unread one are kept before the nightly cleanup-user-history
    // removes them, as the job always did (90 and 180). An env so the
    // monthly partitions of the bell (F5-15) follow: a month is dropped
    // once past the unread one, which covers both, and the bell's reads
    // look no further back (bell-id-range.ts). Under 30 is refused: a notification must outlive its
    // delivery (30 days, with its event), or a re-sent IN_APP would find
    // no row to collide with and ring twice.
    NOTIFICATION_READ_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(30).max(3_650).default(90),
    ),
    NOTIFICATION_UNREAD_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(30).max(3_650).default(180),
    ),

    // The chat's opt-in retention (plano-escala U-08, decision D12, pending
    // a lawyer's review): with a number, the nightly purge-chat-messages
    // deletes the messages older than that many days, with their
    // attachments. Unset (or empty), nothing is ever deleted: removing a
    // customer's conversations by default would be a destructive surprise.
    // Under 365 is refused, as for ACTIVITY_RETENTION_DAYS: a conversation
    // is evidence of what the base told the driver, and a shorter window is
    // far likelier a typo than a decision.
    CHAT_MESSAGE_RETENTION_DAYS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(365).max(3_650).optional(),
    ),

    // Which node, slot and service this task is (plano-escala F4-50): the
    // container's hostname is a container id that changes every deploy and
    // names no machine, and with a second node "the slow replica" has to.
    // Typed once in the Application's Environment as the Swarm's own
    // templates, which it renders per task:
    //   SWARM_NODE_HOSTNAME={{.Node.Hostname}}
    //   SWARM_TASK_SLOT={{.Task.Slot}}  (a global service: the node id)
    //   SWARM_SERVICE_NAME={{.Service.Name}}
    // They go into the log bindings and the ops_sample row. All optional:
    // unset, nothing changes. A value still holding `{{` is a template
    // nobody rendered (docker run, the dev compose) and counts as absent, as
    // does an empty one; a value that is not a plain name is dropped instead
    // of refusing the boot, because a label is never worth a process that
    // will not start.
    SWARM_NODE_HOSTNAME: swarmLabel(),
    SWARM_TASK_SLOT: swarmLabel(),
    SWARM_SERVICE_NAME: swarmLabel(),

    // The nightly purges and the partial runs (plano-escala F1-17). A purge
    // stops at its run's budget and, with rows still due, ends FAILED with
    // "[partial]" instead of SUCCEEDED; the catch-up sweep runs it again only
    // inside the partial window and at most so many times that day. The
    // budget can only be lowered: above half the run's 10-minute lease, a
    // live purge would be taken for a dead one and run beside its own re-run,
    // so the boot refuses it. The window is UTC, after the 05:00 backups and
    // before the morning; 0 retries leaves the rest for the next night.
    CRON_PURGE_RUN_BUDGET_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(
          MAX_PURGE_RUN_BUDGET_MS,
          `CRON_PURGE_RUN_BUDGET_MS vai até ${MAX_PURGE_RUN_BUDGET_MS} (metade do lease de 10 min do cron): acima disso, o catch-up tomaria um expurgo vivo por morto.`,
        )
        .default(DEFAULT_PURGE_RUN_BUDGET_MS),
    ),
    CRON_PARTIAL_RETRY_WINDOW_UTC: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(
          (value) => parseUtcWindow(value) !== null,
          "CRON_PARTIAL_RETRY_WINDOW_UTC é HH:MM-HH:MM em UTC, com o início antes do fim no mesmo dia (ex. 06:00-09:00).",
        )
        .default(DEFAULT_PARTIAL_RETRY_WINDOW_UTC),
    ),
    CRON_PARTIAL_RETRIES_PER_DAY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(24)
        .default(DEFAULT_PARTIAL_RETRIES_PER_DAY),
    ),

    // The dashboard's closed days (plano-escala F4-21, decision D52): every
    // 15 minutes, the process with the cron counts each company's closed
    // days of deliveries into tenant_day_count, on the maintenance pool and
    // within CRON_PURGE_RUN_BUDGET_MS, for the overview and the trends to
    // add days up instead of counting months (F4-22). On by default: it only
    // writes its own tables, and nothing is served from them before
    // DASHBOARD_ROLLUP_MODE=on (the default shadow only compares them with
    // the live count). false stops the job (a kill switch, should a
    // run ever weigh on the database); the stored days stop moving forward,
    // and a reader counts live whatever is not stored.
    TENANT_DAY_ROLLUP_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((value) => value === "true"),

    /**
     * The internal reference at /docs.
     *
     * That document describes EVERY endpoint of the product, including the
     * ones only a master can call, and publishing it hands an attacker the
     * map. Outside production it is open, because that is where it is useful.
     * In production it opens only when both of these are set, and then behind
     * HTTP Basic — a pair nobody sets by accident.
     *
     * The public integration reference is a different page entirely and stays
     * open: it is built by subtraction and describes only what a customer's
     * API key can reach.
     */
    DOCS_USER: z.string().optional(),
    DOCS_PASSWORD: z.string().optional(),

    /**
     * The token of GET /health/rollout (plano-escala U-11, D21): the
     * pipeline reads there whether a release step ended 'pending' and runs
     * the step again on the next deploy. Without it (empty counts as
     * absent), or with fewer than 32 characters, the route answers the same
     * 404 as a route that does not exist, to everyone, and the deploy only
     * runs the step when the release image changed (as before). A short
     * value never stops the boot: the route stays closed and the boot log
     * says why. A different value per environment (`openssl rand -hex 32`).
     */
    ROLLOUT_STATUS_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    /**
     * `/metrics` in the Prometheus format (plano-escala F5-29,
     * shared/health/prometheus.ts), for the metrics stack of F5-30: the
     * port of a second, tiny HTTP server of this process, outside Fastify
     * and outside every Domain. Empty (the default): no port is opened.
     * Set, METRICS_TOKEN is required, or the boot refuses: the
     * dokploy-network is shared by staging and production, so a scrape
     * always carries `Authorization: Bearer <METRICS_TOKEN>`. Never the
     * same as PORT. Only infrastructure numbers, never a company's or a
     * person's.
     */
    METRICS_PORT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1024).max(65_535).optional(),
    ),

    /**
     * The scrape's token, 32 characters or more (`openssl rand -hex 32`),
     * a different one per environment. Required with METRICS_PORT.
     */
    METRICS_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    /**
     * Cloudflare Turnstile, verified by the API on the public quote form
     * (src/shared/security/turnstile.ts). The same secret the web holds.
     *
     * With the secret set, a request without a token is refused and the token
     * the web forwards is verified at Cloudflare. Without it, Turnstile is off.
     */
    //
    // Empty counts as absent, like the secrets below.
    TURNSTILE_SECRET_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

    /**
     * Where the client address of anonymous routes comes from: the rate-limit
     * bucket of login, 2FA and password recovery. Chosen by whoever runs the
     * edge. `none` behind a proxy puts everybody in one bucket; a header the
     * edge does not rewrite lets an attacker pick their own. `xff` is right
     * for Traefik and nginx as the edge (both APPEND the real peer).
     */
    //
    // `cloudflare` is verified (config/rate-limit.ts): CF-Connecting-IP
    // counts only when the peer Traefik saw is a Cloudflare edge, otherwise
    // the peer is used, exactly as `xff`. It is the value for production,
    // which is behind Cloudflare — there `xff` keys every user by the edge
    // that served them. `xff` stays right only where Traefik IS the edge.
    //
    // No default: outside production absent means `none` (the reader
    // resolves it); in production its absence fails the boot (see below).
    RATE_LIMIT_TRUSTED_PROXY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["none", "xff", "cloudflare"]).optional(),
    ),

    /**
     * Secret shared with the Next.js server (at least 32 characters). The
     * anonymous routes reach this API from the web SERVER, so every browser
     * shares its address; the server relays the browser IP in
     * `x-trajetto-client-ip` next to this secret, and without the secret the
     * header is ignored. Same value as the web's RATE_LIMIT_FORWARDER_SECRET.
     */
    //
    // Empty counts as absent: a compose passing `${VAR}` with no value hands
    // over an empty string, which must not fail the boot.
    RATE_LIMIT_FORWARDER_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),

    /**
     * Secret a Transform Rule on OUR Cloudflare zones puts in
     * `x-trajetto-edge-secret` (at least 32 characters). Optional.
     */
    //
    // A Cloudflare address alone does not prove the request crossed our zone:
    // a Worker on any account leaves from the same ranges and can write
    // CF-Connecting-IP. When set, `cloudflare` mode believes that header only
    // next to this one. Unset keeps the range check alone. Empty counts as
    // absent, like the secret above.
    RATE_LIMIT_EDGE_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),

    /**
     * Load shedding (plano-escala F2-24, shared/http/load-shedding.ts): what
     * a pressed replica does with the requests it could turn away. `observe`
     * (the default) only counts them in the `shedding` section of
     * /health/metrics and of the ops_sample row; `enforce` answers them 503
     * SERVICE_BUSY with Retry-After. Observe first, for seven days: a wrong
     * class would refuse real work. Empty counts as absent.
     */
    SHED_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["observe", "enforce"]).default("observe"),
    ),

    /**
     * The GPS positions' own gate inside SHED_MODE=enforce (plano-escala
     * F2-25, shared/http/shed-classes.ts). An app build without back-off
     * answers a 503 by sending again at once, so `auto` (the default)
     * refuses positions only while 90% of the replica's POSTs of the last
     * ten minutes come from the app contract that backs off (8); `observe`
     * never refuses them; `enforce` refuses them whatever the adoption.
     * Empty counts as absent.
     */
    SHED_POSITIONS_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["auto", "observe", "enforce"]).default("auto"),
    ),

    /**
     * Each company's panel budget (plano-escala F2-28, decision D41,
     * shared/integration/panel-budget.ts): units a minute a company's panel
     * sessions may spend (a detail 1, the tower 3, a list 5 or 10, an export
     * 20), each person at most TENANT_PANEL_USER_SHARE of it, charged
     * before the session lookup. Drivers and the MASTER never pay.
     * `observe` (the default) only counts, in the `panel_budget` section of
     * /health/metrics and of the ops_sample row; `enforce` answers 429
     * TENANT_BUSY with Retry-After; `off` spends nothing. Empty counts as
     * absent.
     */
    TENANT_PANEL_BUDGET_MODE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["off", "observe", "enforce"]).default("observe"),
    ),
    TENANT_PANEL_BUDGET_PER_MINUTE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).max(1_000_000).default(6_000),
    ),
    // A share, not a count: a person's slice grows with the company's
    // budget. Above 0 and at most 1 (a person may spend all of it).
    TENANT_PANEL_USER_SHARE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().gt(0).max(1).default(0.25),
    ),

    /**
     * How deep an offset listing of the panel may page (plano-escala F2-30,
     * decision D42, shared/pagination/offset-ceiling.ts): a page starting at
     * or past this row answers 400 LIST_OFFSET_TOO_DEEP, which tells the
     * person to filter or export. Nobody reads row 50,000 by turning pages,
     * and Postgres reads and drops every row before the page. The web stops
     * its pager at 10,000 too. 0 turns the ceiling off. Empty counts as
     * absent.
     */
    LIST_MAX_OFFSET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(100_000_000).default(10_000),
    ),

    /**
     * How far before a period's first day the activity listings look by id
     * (plano-escala F2-19, src/shared/activity/activity-period.ts). From the
     * copy window of wave 11 on, activity is partitioned by month on its id,
     * and a period read only by created_at plans and reads every month; the
     * id floor keeps it on the one or two the period is in. The margin
     * covers an id minted before its row's created_at: a replica's clock,
     * and an activity of the notification pipeline, whose id is its
     * delivery's, written when the delivery ran. 0 turns the floor off (the
     * reads by created_at alone, as before). Empty counts as absent.
     */
    ACTIVITY_ID_FLOOR_MARGIN_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(31 * 24 * 60 * 60 * 1000)
        .default(2 * 24 * 60 * 60 * 1000),
    ),

    /**
     * Up to how many rows the activity table counts (plano-escala F2-19,
     * decision D42): past it the total reads "10.000+" (`totalCapped`), and
     * the count stops reading there instead of going through the whole
     * trail for a number the pager cannot reach anyway (LIST_MAX_OFFSET).
     * 0 counts every row, as before. Empty counts as absent.
     */
    ACTIVITY_COUNT_CAP: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(100_000_000).default(10_000),
    ),

    /**
     * How often each replica re-checks, in the database, the sessions of its
     * sockets (±25% jitter). The safety net of revocation: the frame that
     * drops a socket travels through Redis and is lost if Redis blinks, so
     * this is the longest a revoked session keeps receiving data.
     */
    SOCKET_REVALIDATE_MS: z.coerce.number().int().min(1_000).default(180_000),

    /**
     * How often each process with sockets reads session_revocation_log
     * (plano-escala F5-22, shared/auth/revocation-feed.ts), in ms: the
     * ceiling for a revocation written by SQL to reach a socket (F5-24)
     * and, later, the session cache (F5-23). A revocation made by the app
     * travels at once through the hint on the pub/sub; this is for the one
     * that did not. 0 turns the feed off (the sockets go back to the
     * periodic sweep alone). Between 250 and 10000 otherwise: below it the
     * reads cost more than they save. Empty counts as absent.
     */
    REVOCATION_FEED_POLL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(0)
        .max(10_000)
        .refine(
          (value) => value === 0 || value >= 250,
          "REVOCATION_FEED_POLL_MS é 0 (desligado) ou de 250 a 10000",
        )
        .default(1_000),
    ),

    /**
     * The session cache (plano-escala F5-23, shared/auth/session-cache.ts,
     * docs/adr/0015-cache-de-sessao.md), in ms: how long a session that
     * passed the whole check is reused, in this process's memory, by the
     * two routes that opt in (POST /route/positions and GET
     * /route/control-tower), never for a MASTER. A revocation drops it at
     * once on the replica that made it and within the revocation feed's
     * second on the others; with the feed not fresh (off, or the log
     * unreadable) every request reads the database. 0, the default, turns
     * it off: production keeps it at 0 until the gate's ABBA shows the
     * gain and the owner accepts in writing the one second of the other
     * replicas. At most 15000. Empty counts as absent.
     */
    SESSION_CACHE_TTL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(15_000).default(0),
    ),

    /**
     * Socket handshakes one replica runs at once (plano-escala U-01,
     * shared/socket/admission.ts): past it, the next is refused with
     * SOCKET_UNAVAILABLE and `retryAfterMs` (5 to 10 s), which the web and
     * the app wait out, and the address is not charged. Each handshake is
     * one Postgres round trip (three with SESSION_LOOKUP_MODE=legacy), and
     * a deploy moves a replica's sockets to the others within seconds. 0
     * turns the ceiling off, the rollback.
     * Empty counts as absent.
     */
    SOCKET_HANDSHAKE_MAX_INFLIGHT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(10_000).default(64),
    ),

    /**
     * Sockets one replica holds (plano-escala U-01): past it, refused the
     * same way. Nothing bounded it, and a replica that took a whole fleet
     * ran out of file descriptors for Postgres and HTTP too. The ceiling
     * applied is the smaller of this and the descriptors' (F5-31,
     * SOCKET_FD_RESERVE). 0 turns the whole ceiling off, the descriptors'
     * part included: the rollback. Empty counts as absent.
     */
    SOCKET_MAX_CONNECTIONS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(1_000_000).default(5_000),
    ),

    /**
     * File descriptors kept out of the socket ceiling (plano-escala F5-31,
     * shared/socket/socket-cap.ts): the replica holds at most the process's
     * soft descriptor limit minus this, so the sockets never take the
     * descriptors Postgres, Redis, HTTP and the uploads need (EMFILE takes
     * the whole replica down, not only realtime). On a limit so low that it
     * would leave fewer than 1,024 sockets, the reserve shrinks (1,024
     * sockets, or half the descriptors under 2,048) and the boot warns.
     * 0 leaves the descriptors out of the ceiling. Empty counts as absent.
     */
    SOCKET_FD_RESERVE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(1_000_000).default(1_024),
    ),

    /**
     * Whether a driver's position also goes to the operations room, besides
     * `positions:<businessId>` (plano-escala U-01). On by default, so a web
     * build from before the positions subscription keeps its dots; turned
     * off by U-03, a week after the web that subscribes (X-32) reached
     * production, which stops sending the fleet's GPS to every dispatch tab.
     */
    SOCKET_POSITIONS_ON_OPERATIONS_ROOM: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((value) => value === "true"),

    /**
     * Whether the shutdown closes this replica's sockets in slices over the
     * drain, 1/N a second with N the drain's seconds (plano-escala U-01,
     * shared/socket/gradual-close.ts), instead of all at once at its end,
     * when they all reconnected to the other replicas in the same second.
     * `false` is the rollback. Empty counts as absent.
     */
    SOCKET_GRADUAL_DRAIN: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((value) => value === "true"),

    /**
     * How long a login's last socket may stay gone before it counts as
     * offline (plano-escala U-05, F4.6; shared/socket/presence.ts): only
     * then is "visto por último" stamped and the SAC told. A driver's
     * signal drops for a few seconds all day, and each drop used to be an
     * "offline" and a new last_seen_at on the chat's screen, then an
     * "online" a moment later. At most 60 s: the presence row's beat is
     * read as online for 90 s, so a longer wait would show the driver
     * offline before the wait ended. 0 is the rollback (offline at once,
     * as before). Empty counts as absent.
     */
    PRESENCE_GRACE_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(0).max(60_000).default(45_000),
    ),

    /**
     * The `nextFlushAfterMs` POST /route/positions answers when the replica
     * is not pressed (plano-escala F2-26): twice it with the event loop over
     * 70%, the app's 5-minute ceiling over 90% or while shedding
     * (shared/health/pressure-level.ts). 60 s is the app's own interval, so
     * the default changes nothing for a quiet fleet. Empty counts as absent.
     */
    POSITIONS_FLUSH_AFTER_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(POSITIONS_FLUSH_AFTER_MIN_MS)
        .max(POSITIONS_FLUSH_AFTER_MAX_MS)
        .default(POSITIONS_FLUSH_AFTER_DEFAULT_MS),
    ),

    /**
     * The GPS group commit (plano-escala F5-19,
     * modules/route/services/position-write-buffer.ts). `on`: the flushes
     * of POST /route/positions that reach a process within 50 ms (or 1.000
     * points) are written in ONE transaction, and each request is answered
     * only after that COMMIT; a failed batch is redone flush by flush, and
     * after 5 failed batches in a row a breaker sends every flush down the
     * old path for a minute. `off` (the default): one transaction per
     * flush, as before. Per process, in the roles that take the route
     * (`all`, `api`, `ingest`). Staging first; production only after seven
     * days of staging without the breaker opening and the gate's ABBA.
     * Empty counts as absent.
     */
    POSITION_GROUP_COMMIT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["off", "on"]).default("off"),
    ),

    /**
     * Lowest driver-app `contract` still served (the app's CLIENT_CONTRACT,
     * raised by every release that changes what it sends). Below it: 426
     * CLIENT_UPGRADE_REQUIRED, except login, 2FA, refresh and logout
     * (shared/http/client-version.ts). Empty = off; only callers sending
     * `x-trajetto-client-version` are ever refused.
     */
    MIN_MOBILE_CONTRACT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(1).optional(),
    ),

    /**
     * The driver app's store page, sent as `storeUrl` in the 426 body; the
     * app opens it when no over-the-air update exists for its runtime. Empty:
     * the field is left out and the app builds the Play Store link itself.
     */
    //
    // https only: the app hands it to the OS to open, where another scheme
    // could start any other app and a plain http page could be swapped in
    // transit. Empty counts as absent, like the variables above.
    MOBILE_STORE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .url()
        .refine((value) => value.startsWith("https://"), {
          message: "MOBILE_STORE_URL precisa começar com https://",
        })
        .optional(),
    ),

    /**
     * Prefix of the Socket.IO adapter's Redis channels. Pub/Sub ignores the
     * database number, so this is the only separation between two stacks (or
     * a test suite and a dev API) sharing one Redis. The default stays put so
     * a rolling deploy does not split old and new replicas.
     */
    //
    // Empty counts as absent, like the secrets above. Plain characters only:
    // the adapter also PSUBSCRIBEs to `<key>#/#*`, so a glob character (`*`,
    // `?`, `[`) or the `#` separator in the key would reach into the channels
    // of the very stacks it is meant to keep apart.
    SOCKET_ADAPTER_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .default("socket.io"),
    ),

    /**
     * How long a cluster-wide question of the Socket.IO adapter
     * (`fetchSockets` for the chat's presence, a `serverSideEmit` with an
     * acknowledgement) waits for every replica (plano-escala F4-51). Two
     * seconds: the library's five held an HTTP request hostage to the
     * slowest replica, and with more replicas there are more chances of a
     * slow one. Presence falls back to the replica's own sockets when the
     * wait runs out. Empty counts as absent.
     */
    SOCKET_ADAPTER_REQUESTS_TIMEOUT_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(100).max(30_000).default(2_000),
    ),

    /**
     * Key (32 bytes base64, `openssl rand -base64 32`) that encrypts webhook
     * signing secrets and headers at rest (src/shared/integration/secret-box.ts).
     * Optional: without it production stores them in clear and the boot warns;
     * outside production a fixed dev key applies. Keep a copy OUTSIDE the
     * database backups: losing it makes every sealed secret unreadable.
     */
    //
    // Empty counts as absent, like the secrets above. Checked for exactly 32
    // bytes here, so a truncated paste fails the boot instead of every
    // webhook.
    WEBHOOK_SECRETS_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .refine(
          (value) => Buffer.from(value, "base64").length === 32,
          "WEBHOOK_SECRETS_KEY deve ser o base64 de 32 bytes (openssl rand -base64 32).",
        )
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (
      (env.APP_ENV === "staging" || env.APP_ENV === "production") &&
      env.NODE_ENV !== "production"
    ) {
      // Staging exists to run the production image under the production
      // guards below; outside NODE_ENV=production it would skip all of them
      // (local uploads, no proxy mode, /docs open) and prove nothing.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_ENV"],
        message: `APP_ENV=${env.APP_ENV} exige NODE_ENV=production: staging roda a mesma imagem e as mesmas travas da produção.`,
      });
    }

    // The shutdown's deadlines must end before the Swarm's SIGKILL (F1-14).
    // Derived alone they always do; an override that breaks it fails the
    // boot here, where the deploy's convergence check sees it, instead of
    // cutting the next deploy's in-flight work. Checked as production runs
    // it, in every environment: the same variables reach both.
    for (const message of shutdownPlanProblems(
      planShutdown(env.STOP_GRACE_PERIOD_MS, {
        timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
        drainMs: env.SHUTDOWN_DRAIN_MS,
        importGraceMs: env.IMPORT_DRAIN_GRACE_MS,
        workersMs: env.SHUTDOWN_WORKERS_MS,
      }),
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STOP_GRACE_PERIOD_MS"],
        message,
      });
    }

    // A FAILED event leaves the queue for its dead letter at the family's
    // retention (F5-11): a dead letter that kept it no longer would expire
    // it the night it is copied.
    if (
      env.OUTBOX_FAILED_RETENTION_DAYS <= env.OUTBOX_PUBLISHED_RETENTION_DAYS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OUTBOX_FAILED_RETENTION_DAYS"],
        message: `OUTBOX_FAILED_RETENTION_DAYS (${env.OUTBOX_FAILED_RETENTION_DAYS}) precisa ser maior que OUTBOX_PUBLISHED_RETENTION_DAYS (${env.OUTBOX_PUBLISHED_RETENTION_DAYS}): o evento que falhou vai para o dead letter nessa idade.`,
      });
    }

    // The background paths stop below the search on the same minute's log,
    // leaving its tail to the person typing (geocoding-gate.ts): above it,
    // a spreadsheet's job would take every call the search could have.
    if (
      env.GEOCODING_BACKGROUND_CALLS_PER_MINUTE > env.GEOCODING_CALLS_PER_MINUTE
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GEOCODING_BACKGROUND_CALLS_PER_MINUTE"],
        message:
          "GEOCODING_BACKGROUND_CALLS_PER_MINUTE não pode passar de GEOCODING_CALLS_PER_MINUTE: o fim do minuto é da busca de endereço do painel.",
      });
    }

    // The geocoder's share of the provider's plan (F2-32; decision D40):
    // within 90% of it, so a burst of the proofs or a day that ends late
    // still meets no 429. Integers on both sides: 0.9 is not exact in a
    // double, and 18 calls of a plan of 20 must pass.
    for (const problem of geocodingPlanProblems(env)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [problem.path],
        message: problem.message,
      });
    }

    if (env.PROOF_SIGNING_PFX_BASE64 && env.PROOF_SIGNING_PFX_PATH) {
      // Two sources for one certificate is a configuration nobody can read
      // without guessing which one wins.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PROOF_SIGNING_PFX_PATH"],
        message:
          "Defina PROOF_SIGNING_PFX_BASE64 ou PROOF_SIGNING_PFX_PATH, não os dois.",
      });
    }

    if (env.PROOF_MAP_TILE_URL && !env.PROOF_MAP_TILE_ATTRIBUTION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PROOF_MAP_TILE_ATTRIBUTION"],
        message:
          "PROOF_MAP_TILE_ATTRIBUTION é obrigatório com PROOF_MAP_TILE_URL: o crédito do provedor vai impresso no mapa.",
      });
    }

    // The app's base map, checked like the web's boot check: a broken
    // template fails the boot instead of quietly giving every manager a map
    // with no background. "Broken" includes what the web takes and the app
    // refuses (a wildcard or bare {s} host, credentials, quotes...): served,
    // the app would just say no base map is configured. The message names
    // the variable, never its value (it can carry the provider's key).
    const mapAppEnv =
      env.APP_ENV ??
      (env.NODE_ENV === "production" ? "production" : "development");

    for (const field of ["MAP_TILE_URL", "MAP_TILE_URL_DARK"] as const) {
      const value = env[field]?.trim();

      if (!value) continue;

      if (!isTileTemplate(value, mapAppEnv)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} inválida: modelo https com {z}, {x} e {y} ({s} opcional; http só em desenvolvimento), num host só (sem curinga, credenciais, IPv6, _ ou ponto final; {s} só como primeiro nível, com dois níveis depois), sem espaços nem aspas e com até 1024 caracteres.`,
        });
      } else if (mapAppEnv !== "development" && isPublicOsmTemplate(value)) {
        // The public OSM services forbid this use, as for the proof's map.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} não pode usar tile.openstreetmap.org fora de desenvolvimento: a política de uso do OpenStreetMap proíbe este volume.`,
        });
      }
    }

    // The signing keys of every session, checked where a real deployment
    // runs (staging or production; the load harness says APP_ENV=development).
    // Any string used to pass: a short or guessable JWT_SECRET lets anyone
    // brute-force it offline from one captured token and then mint an access
    // token for any user id, MASTER included. One key for both also made a
    // refresh token verify under the access key.
    const deployed = env.APP_ENV
      ? env.APP_ENV !== "development"
      : env.NODE_ENV === "production";

    if (deployed) {
      for (const field of ["JWT_SECRET", "JWT_SECRET_REFRESH_TOKEN"] as const) {
        const value = env[field];

        if (value.length < JWT_SECRET_MIN_LENGTH || /^GENERATE_/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} precisa de ao menos ${JWT_SECRET_MIN_LENGTH} caracteres aleatórios em staging e produção (openssl rand -base64 48).`,
          });
        }
      }

      if (env.JWT_SECRET === env.JWT_SECRET_REFRESH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["JWT_SECRET_REFRESH_TOKEN"],
          message:
            "JWT_SECRET_REFRESH_TOKEN deve ser diferente de JWT_SECRET: a mesma chave assinaria os dois tipos de token.",
        });
      }

      // Without the secret the API skips the bot check of the public quote
      // form (the one form the API checks itself; login and recovery are
      // checked by the web, and the app's login is never challenged) and only
      // logged a warning once: a variable missing in a deploy silently opened
      // it to scripts.
      if (!env.TURNSTILE_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TURNSTILE_SECRET_KEY"],
          message:
            "TURNSTILE_SECRET_KEY é obrigatório em staging e produção: sem ele o formulário público de orçamento fica sem verificação de robô.",
        });
      }
    }

    // The trail archive switched on without its bucket or token
    // (plano-escala F2-11): a warning and not an error, because a missing
    // new setting must never stop a deploy. The partition job then keeps
    // every expired day of the trail instead of dropping it unarchived,
    // and says so in its log; the partition-stuck alert follows.
    if (env.TRAIL_ARCHIVE_ENABLED) {
      const missing = missingArchiveSettings(env);

      if (missing.length > 0) {
        console.warn(
          `[env] TRAIL_ARCHIVE_ENABLED=true sem ${missing.join(", ")}: o ` +
            "job de partições guarda os dias vencidos da trilha em vez de " +
            "apagá-los sem arquivo.",
        );
      }
    }

    // `/metrics` is never open (F5-29): the network under it is shared by
    // the two environments, so its port needs its token, and never the
    // API's own port.
    if (env.METRICS_PORT !== undefined) {
      if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["METRICS_TOKEN"],
          message:
            "METRICS_TOKEN (32 caracteres ou mais, openssl rand -hex 32) é obrigatório com METRICS_PORT: a dokploy-network é dividida entre staging e produção.",
        });
      }

      if (env.METRICS_PORT === env.PORT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["METRICS_PORT"],
          message:
            "METRICS_PORT não pode ser a PORT da API: o /metrics fica numa porta própria, fora das Domains.",
        });
      }
    }

    // The months kept attached end before the archive does (F5-17).
    if (
      env.HISTORY_ATTACHED_MONTHS >=
      env.HISTORY_ARCHIVE_RETENTION_YEARS * 12
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["HISTORY_ATTACHED_MONTHS"],
        message: `HISTORY_ATTACHED_MONTHS (${env.HISTORY_ATTACHED_MONTHS}) precisa ser menor que HISTORY_ARCHIVE_RETENTION_YEARS × 12 (${env.HISTORY_ARCHIVE_RETENTION_YEARS * 12}): o arquivo do histórico tem de durar mais que os meses no banco.`,
      });
    }

    // The DROP without the archive drops nothing (F5-17): said at boot.
    if (env.HISTORY_DROP_ENABLED && !env.HISTORY_ARCHIVE_ENABLED) {
      console.warn(
        "[env] HISTORY_DROP_ENABLED=true sem HISTORY_ARCHIVE_ENABLED: " +
          "sem arquivo conferido, nenhum mês do histórico sai do banco.",
      );
    }

    // The same for the history's archive (F5-16): nothing is archived, and
    // nothing of the history is ever deleted without its archive.
    if (env.HISTORY_ARCHIVE_ENABLED) {
      const missing = missingArchiveSettings(env);

      if (missing.length > 0) {
        console.warn(
          `[env] HISTORY_ARCHIVE_ENABLED=true sem ${missing.join(", ")}: ` +
            "o histórico de entregas não é arquivado.",
        );
      }
    }

    if (env.NODE_ENV !== "production") return;

    // The public OSM services forbid this use (design §5.1 and §5.2).
    for (const [field, host] of [
      ["PROOF_MAP_TILE_URL", "tile.openstreetmap.org"],
      ["REVERSE_GEOCODER_URL", "nominatim.openstreetmap.org"],
      // Searching as you type is the one use its policy names as forbidden.
      ["ADDRESS_SEARCH_URL", "nominatim.openstreetmap.org"],
    ] as const) {
      const value = env[field];

      if (!value) continue;

      let parsed: URL | null = null;

      try {
        parsed = new URL(value.replace(/\{[a-z]\}/g, "x"));
      } catch {
        parsed = null;
      }

      if (
        parsed &&
        (parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} não pode usar ${host} em produção: a política de uso do OpenStreetMap proíbe este volume.`,
        });
      } else if (parsed && parsed.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} deve usar https em produção.`,
        });
      }
    }

    if (env.UPLOAD_STORAGE_TYPE !== "r2") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["UPLOAD_STORAGE_TYPE"],
        message:
          "Produção exige R2 privado; armazenamento local não é permitido para fotos sensíveis.",
      });
    }

    if (env.RATE_LIMIT_TRUSTED_PROXY === undefined) {
      // An error, not a warning: a silent `none` behind a proxy puts all
      // anonymous traffic in one bucket (eight logins a minute for the whole
      // platform). A failed boot costs a minute; a silently broken limit
      // costs an incident.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RATE_LIMIT_TRUSTED_PROXY"],
        message:
          "Defina RATE_LIMIT_TRUSTED_PROXY em produção: `cloudflare` atrás da Cloudflare (o cabeçalho só vale quando o par é da Cloudflare), `xff` quando o Traefik/nginx é a borda, `none` só sem proxy nenhum.",
      });
    } else if (env.RATE_LIMIT_TRUSTED_PROXY === "none") {
      // Explicit `none` is legitimate without a proxy, but the common case
      // has one, and then the anonymous limits measure the proxy's address.
      console.warn(
        "[env] RATE_LIMIT_TRUSTED_PROXY=none em produção: o limite das rotas " +
          "anônimas vai medir o endereço do proxy, não o do cliente. Atrás da " +
          "Cloudflare, use `cloudflare`; com Traefik ou nginx como borda, `xff`.",
      );
    }

    // Warnings, as the web's boot gives them: the map still works, but not
    // the way whoever set the variable meant.
    if (env.MAP_TILE_URL_DARK && !env.MAP_TILE_URL) {
      if (mapAppEnv !== "development") {
        console.warn(
          "[env] MAP_TILE_URL_DARK ignorada sem MAP_TILE_URL: o tema escuro " +
            "precisa do mapa claro como base.",
        );
      }
    } else if (env.MAP_TILE_URL && !env.MAP_TILE_ATTRIBUTION) {
      // The provider's terms (and OSM-derived data) require its own credit.
      console.warn(
        "[env] MAP_TILE_ATTRIBUTION ausente: o mapa do app mostra um crédito " +
          "genérico, e o provedor de tiles exige o dele.",
      );
    }

    if (!env.WEBHOOK_SECRETS_KEY) {
      // A warning and not an error: without the key the webhook secrets stay
      // in clear, as they always were, and nothing breaks. Refusing the boot
      // would turn a missing hardening step into an outage.
      console.warn(
        "[env] WEBHOOK_SECRETS_KEY ausente em produção: o segredo e os " +
          "cabeçalhos dos webhooks ficam gravados em claro. Gere com " +
          "`openssl rand -base64 32` e rode o seal-webhook-secrets depois.",
      );
    }

    for (const field of [
      "R2_ACCOUNT_ID",
      "R2_BUCKET_NAME",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ] as const) {
      if (!env[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} é obrigatório em produção.`,
        });
      }
    }
  })
  .transform((env) => ({
    ...env,
    APP_ENV:
      env.APP_ENV ??
      (env.NODE_ENV === "production"
        ? ("production" as const)
        : ("development" as const)),

    // The role's preset under the variables given (plano-escala F3-01):
    // every reader sees the decided values, whoever parsed the environment.
    ...resolveProcessRole(env),
  }));

export { envSchema };

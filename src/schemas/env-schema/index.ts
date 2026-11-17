import { z } from "zod";

import {
  LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  LOCAL_AI_DEFAULT_TIMEOUT_MS,
} from "@/shared/ai/ai-provider-defaults";
import { throughPgBouncer } from "@/shared/database/pgbouncer-url";
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
      z.string().refine(isPostgresUrl, POSTGRES_URL_MESSAGE).optional(),
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
    HTTP_REQUEST: z.string(),
    API_HTTP_REQUEST: z.string().optional(),
    JWT_SECRET: z.string(),
    JWT_SECRET_REFRESH_TOKEN: z.string(),

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

    /** Reads in flight per replica: the service reads one at a time. */
    AI_LOCAL_MAX_CONCURRENCY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(4)
        .default(LOCAL_AI_DEFAULT_MAX_CONCURRENCY),
    ),

    // Whether this replica runs the background workers: the notification and
    // AI pipelines, the webhook dispatcher and the cron (GAP2-3). `false` on
    // the HTTP replicas ONLY together with a worker service of the same image
    // left at `true` (docs/deploy.md (Réplicas, workers e tempo real)). Empty counts as absent.
    WORKERS_ENABLED: z
      .preprocess(
        (value) => (value === "" ? undefined : value),
        z.enum(["true", "false"]).default("true"),
      )
      .transform((value) => value === "true"),

    // The pipelines' background sweep. 30 s while every replica wakes its
    // own pipelines on publish; a dedicated worker polls faster (1-2 s),
    // because a publish on an HTTP replica no longer wakes it.
    PIPELINE_SWEEP_INTERVAL_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().min(500).default(30_000),
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

    // The bell's retention (plano-escala F5-14): days a read notification
    // and an unread one are kept before the nightly cleanup-user-history
    // removes them, as the job always did (90 and 180). An env so the
    // monthly partitions of the bell (F5-15) drop months by the same
    // numbers. Under 30 is refused: a notification must outlive its
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
     * How often each replica re-checks, in the database, the sessions of its
     * sockets (±25% jitter). The safety net of revocation: the frame that
     * drops a socket travels through Redis and is lost if Redis blinks, so
     * this is the longest a revoked session keeps receiving data.
     */
    SOCKET_REVALIDATE_MS: z.coerce.number().int().min(1_000).default(180_000),

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
  }));

export { envSchema };

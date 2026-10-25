import { z } from "zod";

import {
  LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  LOCAL_AI_DEFAULT_TIMEOUT_MS,
} from "@/shared/ai/ai-provider-defaults";
import { isValidCnpj } from "@/shared/delivery/cnpj";

/** 32 characters of `openssl rand -base64` are ~192 bits: out of offline reach. */
const JWT_SECRET_MIN_LENGTH = 32;

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
    META_WHATSAPP_TEMPLATE_NAME: z.string().default("trajetto_notification"),
    META_WHATSAPP_API_VERSION: z.string().default("v23.0"),

    // The template a carrier's message to ITS customer goes out under, apart
    // from the internal one: a customer's spam report then risks this
    // template only. Unset (or empty), those messages keep using
    // META_WHATSAPP_TEMPLATE_NAME, as before.
    META_WHATSAPP_CUSTOMER_TEMPLATE_NAME: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),

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
     * Reverse geocoding of the proof's GPS fix (design §5.1): a Nominatim-
     * compatible base URL (our own container or a commercial provider).
     * Unset: the PDF prints the delivery's registered address, labelled as
     * such. The key is a SECRET.
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
          errorMap: () => ({
            message:
              "AI_PROVIDER aceita local ou none: o provedor anthropic foi removido (ADR 0010). Use local com AI_LOCAL_URL e AI_LOCAL_TOKEN.",
          }),
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
    }

    if (env.NODE_ENV !== "production") return;

    // The public OSM services forbid this use (design §5.1 and §5.2).
    for (const [field, host] of [
      ["PROOF_MAP_TILE_URL", "tile.openstreetmap.org"],
      ["REVERSE_GEOCODER_URL", "nominatim.openstreetmap.org"],
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

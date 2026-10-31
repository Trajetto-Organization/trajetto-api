import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { container } from "tsyringe";

import { env } from "@/env";
import { RedisConnection } from "@/../infra/cache/redis-connection";
import { uploadConfig } from "@/config/upload";
import {
  SnapshotCache,
  redisSnapshotStore,
  type SnapshotStore,
} from "@/shared/cache/snapshot-cache";
import { logger } from "@/shared/logging/logger";
import { senderDomain } from "@/shared/providers/mail-provider/message-id";
import { TEMPLATE_LANGUAGE } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";
import {
  lastHeartbeatOutcome,
  type HeartbeatOutcome,
} from "./heartbeat-client";
// Side effect: registers "ProofSigningService" (@registry).
import "@/shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "@/shared/services/proof-signing/proof-signing-service";

/**
 * Provider readiness (contract §32/§33): which external providers this
 * deployment has configured and whether they answer, so "just set the env
 * vars" is something an operator can verify from the MASTER's Sistema screen
 * instead of waiting for the first failed e-mail.
 *
 * Every probe is read-only and free: a GET that lists, a HEAD, a refused
 * request that only proves the token. Nothing is sent to anybody. The answer
 * names variables and states, never a value: no key, no token, no URL of the
 * heartbeat check, no internal host.
 */

type ReadinessStatus =
  | "ok"
  | "warning"
  | "error"
  | "not_configured"
  | "disabled";

type ProviderKey =
  | "email"
  | "whatsapp"
  | "push"
  | "storage"
  | "ai_ocr"
  | "proof_certificate"
  | "heartbeat";

type DetailValue = string | number | boolean | null;

/**
 * Why a probe attempt failed, when the failure says nothing definitive about
 * the provider: it may clear by itself on the next attempt.
 */
type ProbeFailureKind =
  | "timeout"
  | "network"
  | "http_5xx"
  | "throttled"
  | "invalid_response";

interface ProviderReadiness {
  key: ProviderKey;
  label: string;
  status: ReadinessStatus;

  /** Every variable the provider needs is set. */
  configured: boolean;

  /** The probe got an answer; null when nothing was probed. */
  reachable: boolean | null;
  latency_ms: number | null;

  /** Names of the variables still missing, never their values. */
  missing_env: string[];

  /** pt-BR, what is wrong and what to do. */
  message: string;
  warnings: string[];
  details: Record<string, DetailValue>;

  /** Probe attempts made (0: nothing was probed). */
  attempts: number;

  /**
   * The verdict rests on a passing condition: an attempt failed by timeout,
   * network, 5xx, 429 or an unreadable answer, or the answer was slow. Such
   * a report is cached for seconds, not 30 s, and the next probe may differ.
   * A definitive answer (a refused key, a missing bucket or domain) is never
   * transient.
   */
  transient: boolean;

  /** What the last failed attempt hit; null when no attempt failed. */
  failure_kind: ProbeFailureKind | null;
}

interface ProviderReadinessReport {
  checked_at: string;
  providers: ProviderReadiness[];
}

interface ReadinessEnv {
  NODE_ENV: string;
  RESEND_SECRET_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_WEBHOOK_SECRET?: string;
  META_WHATSAPP_ACCESS_TOKEN?: string;
  META_WHATSAPP_PHONE_NUMBER_ID?: string;
  META_WHATSAPP_TEMPLATE_NAME: string;
  META_WHATSAPP_CUSTOMER_TEMPLATE_NAME?: string;
  META_WHATSAPP_API_VERSION: string;
  META_WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  META_WHATSAPP_APP_SECRET?: string;
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
  UPLOAD_STORAGE_TYPE: "local" | "r2";
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  AI_PROVIDER: "local" | "none";
  AI_LOCAL_URL?: string;
  AI_LOCAL_TOKEN?: string;
  HEALTHCHECK_PING_URL?: string;
  HEALTHCHECK_FAIL_URL?: string;
}

interface ProofHealthLike {
  state: "READY" | "EXPIRED" | "INVALID" | "ABSENT" | "DISABLED";
  reason: string | null;
  not_after: string | null;
  days_left: number | null;
}

/** Where the failed attempts go: structured fields, never a URL or a token. */
interface ProbeLog {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

interface ReadinessDeps {
  env: ReadinessEnv;
  fetch: typeof fetch;

  /** Resolves when the bucket answers HEAD; throws the S3 error otherwise. */
  headBucket: (signal: AbortSignal) => Promise<void>;
  proofHealth: () => ProofHealthLike;
  heartbeat: () => HeartbeatOutcome | null;
  now?: () => Date;

  /** Deadline of each attempt (PROBE_ATTEMPT_TIMEOUT_MS). */
  timeoutMs?: number;

  /** All the attempts of one provider (PROBE_BUDGET_MS). */
  budgetMs?: number;

  /** Pause before the second attempt (PROBE_RETRY_DELAY_MS). */
  retryDelayMs?: number;

  /** An answer at least this slow is degraded (PROBE_SLOW_MS). */
  slowMs?: number;
  log?: ProbeLog;
}

/**
 * Each attempt of a probe gets this long for DNS, TCP, TLS, the headers and
 * the body.
 *
 * 3.5 s, not 2.5: the API runs on Alpine, whose resolver (musl) resends a
 * lost DNS query after timeout / attempts = 5 s / 2 = 2.5 s. With 2.5 s per
 * probe, one dropped UDP packet was a guaranteed "não respondeu", the
 * "Com erro" that cleared on the next refresh. 3.5 s leaves room for that
 * resend plus a handshake, and still lets a second attempt fit the budget.
 */
const PROBE_ATTEMPT_TIMEOUT_MS = 3_500;

/**
 * Every attempt of one provider fits in this. The providers run side by
 * side, so it is also about what the Sistema screen waits for when a provider
 * is down (the web's relay gives up at 10 s).
 */
const PROBE_BUDGET_MS = 5_000;

/** A second attempt is only started with at least this much budget left. */
const PROBE_MIN_RETRY_MS = 1_000;

/** Pause before the second attempt, so a reset is not retried in the same instant. */
const PROBE_RETRY_DELAY_MS = 200;

/** One attempt and, for a failure that may clear by itself, one more. */
const PROBE_MAX_ATTEMPTS = 2;

/**
 * Answered, but this slowly: degraded. Every provider answers a healthy
 * probe in well under a second.
 */
const PROBE_SLOW_MS = 2_000;

/** A certificate this close to its end is a warning (the alert's 30 days). */
const CERTIFICATE_WARN_DAYS = 30;

/** A heartbeat older than this on the replica that answered says nothing. */
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;

const log: ProbeLog = logger.child({ component: "provider-readiness" });

/** "3,5 s", "2,4 s": the panel reads pt-BR, to a tenth of a second. */
function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}

function missing(
  env: ReadinessEnv,
  names: Array<keyof ReadinessEnv>,
): string[] {
  return names.filter((name) => !env[name]);
}

function base(
  key: ProviderKey,
  label: string,
  fields: Partial<ProviderReadiness>,
): ProviderReadiness {
  return {
    key,
    label,
    status: "ok",
    configured: true,
    reachable: null,
    latency_ms: null,
    missing_env: [],
    message: "",
    warnings: [],
    details: {},
    attempts: 0,
    transient: false,
    failure_kind: null,
    ...fields,
  };
}

/** ok with warnings reads "warning"; anything worse keeps its status. */
function settle(readiness: ProviderReadiness): ProviderReadiness {
  if (readiness.status === "ok" && readiness.warnings.length > 0) {
    return { ...readiness, status: "warning" };
  }

  return readiness;
}

function failureKind(error: unknown): "timeout" | "network" {
  const name = (error as { name?: string } | null)?.name;

  return name === "TimeoutError" || name === "AbortError"
    ? "timeout"
    : "network";
}

/**
 * The system code under fetch's "fetch failed" (ENOTFOUND, ECONNREFUSED…),
 * with the cause's own words when it has them: a bare UND_ERR_INVALID_ARG
 * does not say which argument was refused. No fetch error message carries a
 * header value, so the token never reaches the panel through this.
 */
function networkCode(error: unknown): string {
  const cause = (
    error as { cause?: { code?: unknown; message?: unknown } } | null
  )?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "erro de rede";
  const detail =
    typeof cause?.message === "string" ? cause.message.slice(0, 160) : "";

  return detail && detail !== code ? `${code}: ${detail}` : code;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Probe attempts
// ---------------------------------------------------------------------------

/**
 * Thrown inside an attempt for an answer that settles nothing yet: a 5xx, a
 * 429, a body that does not parse. A definitive answer (401, 403, 404, a
 * parsed list) is returned, never thrown.
 */
class ProbeFailure extends Error {
  constructor(
    readonly kind: ProbeFailureKind,
    readonly httpStatus: number | null = null,
  ) {
    super(kind);
    this.name = "ProbeFailure";
  }
}

/** Repeating a call the provider rate-limited only adds to its limit. */
const RETRYABLE: ReadonlySet<ProbeFailureKind> = new Set([
  "timeout",
  "network",
  "http_5xx",
  "invalid_response",
]);

/**
 * Where an attempt was when it failed: waiting for the answer (DNS, TCP,
 * TLS, headers) or reading its body.
 */
type ProbePhase = "response" | "body";

interface AttemptFailure {
  kind: ProbeFailureKind;

  /** System or SDK code (EAI_AGAIN, ECONNRESET, UND_ERR_SOCKET…). */
  code: string | null;
  http_status: number | null;
  phase: ProbePhase;
  elapsed_ms: number;

  /** The code with the cause's own words, for the panel only (never logged). */
  detail: string | null;
}

interface ProbeOutcome<T> {
  /** The attempt that got an answer; absent when every attempt failed. */
  answer?: { value: T; ms: number };
  attempts: number;
  failures: AttemptFailure[];
}

interface ProbeAttempt {
  signal: AbortSignal;

  /** The headers arrived: the latency stops here, and a failure is the body's. */
  answered(): void;
}

interface ProbePolicy {
  attemptTimeoutMs: number;
  budgetMs: number;
  retryDelayMs: number;
  minRetryMs: number;
  slowMs: number;
}

function probePolicy(deps: ReadinessDeps): ProbePolicy {
  const attemptTimeoutMs = deps.timeoutMs ?? PROBE_ATTEMPT_TIMEOUT_MS;

  return {
    attemptTimeoutMs,
    budgetMs: deps.budgetMs ?? PROBE_BUDGET_MS,
    retryDelayMs: deps.retryDelayMs ?? PROBE_RETRY_DELAY_MS,
    // Scaled down with a test's millisecond deadlines.
    minRetryMs: Math.min(PROBE_MIN_RETRY_MS, attemptTimeoutMs),
    slowMs: deps.slowMs ?? PROBE_SLOW_MS,
  };
}

/** The code under a failure: fetch puts it on the cause, node and the SDK on the error. */
function errorCode(error: unknown): string | null {
  const own = error as {
    code?: unknown;
    name?: unknown;
    cause?: { code?: unknown };
  } | null;

  if (typeof own?.cause?.code === "string") return own.cause.code;
  if (typeof own?.code === "string") return own.code;

  return typeof own?.name === "string" &&
    !["Error", "TypeError"].includes(own.name)
    ? own.name
    : null;
}

function classifyFailure(
  error: unknown,
  timedOut: boolean,
): Pick<AttemptFailure, "kind" | "code" | "http_status" | "detail"> {
  if (error instanceof ProbeFailure) {
    return {
      kind: error.kind,
      code: null,
      http_status: error.httpStatus,
      detail: null,
    };
  }

  // The SDK reports our abort as an AbortError whose cause is a TimeoutError.
  if (timedOut || failureKind(error) === "timeout") {
    return {
      kind: "timeout",
      code: "timeout",
      http_status: null,
      detail: null,
    };
  }

  return {
    kind: "network",
    code: errorCode(error),
    http_status: null,
    detail: networkCode(error),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one provider's probe: an attempt with its own deadline and, when it
 * failed in a way that may clear by itself (timeout, network, 5xx, an
 * unreadable answer), ONE more inside the provider's budget. A definitive
 * answer is never repeated. Every failed attempt is logged with its cause.
 *
 * Only for read-only probes (a GET that lists, a HEAD, a refused request):
 * never wrap a send in this, a retried send is a duplicated message.
 */
async function probeAttempts<T>(
  provider: ProviderKey,
  deps: ReadinessDeps,
  run: (attempt: ProbeAttempt) => Promise<T>,
): Promise<ProbeOutcome<T>> {
  const policy = probePolicy(deps);
  const sink = deps.log ?? log;
  const startedAt = performance.now();
  const failures: AttemptFailure[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const remaining = policy.budgetMs - (performance.now() - startedAt);
    const deadline = Math.max(1, Math.min(policy.attemptTimeoutMs, remaining));
    const controller = new AbortController();
    const state: { phase: ProbePhase; answeredAt: number | null } = {
      phase: "response",
      answeredAt: null,
    };
    const attemptStartedAt = performance.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const value = await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          const reason = new DOMException(
            `probe attempt exceeded ${deadline} ms`,
            "TimeoutError",
          );

          timedOut = true;
          controller.abort(reason);
          // The call may not honour the signal (a stalled body, an SDK
          // retrying on its own): the deadline holds anyway.
          reject(reason);
        }, deadline);

        run({
          signal: controller.signal,
          answered: () => {
            state.phase = "body";
            state.answeredAt ??= performance.now();
          },
        }).then(resolve, reject);
      });
      const ms = Math.round(
        (state.answeredAt ?? performance.now()) - attemptStartedAt,
      );

      if (failures.length > 0) {
        sink.info(
          { provider, attempts: attempt, latency_ms: ms },
          "provider probe recovered on retry",
        );
      }

      return { answer: { value, ms }, attempts: attempt, failures };
    } catch (error) {
      const failure: AttemptFailure = {
        ...classifyFailure(error, timedOut),
        phase: state.phase,
        elapsed_ms: Math.round(performance.now() - attemptStartedAt),
      };
      const left =
        policy.budgetMs - (performance.now() - startedAt) - policy.retryDelayMs;
      const retry =
        attempt < PROBE_MAX_ATTEMPTS &&
        RETRYABLE.has(failure.kind) &&
        left >= policy.minRetryMs;

      failures.push(failure);

      // Codes and timings only: no URL (R2's host carries the account id),
      // no header, no message that could quote either.
      sink.warn(
        {
          provider,
          attempt,
          kind: failure.kind,
          code: failure.code,
          http_status: failure.http_status,
          phase: failure.phase,
          elapsed_ms: failure.elapsed_ms,
          will_retry: retry,
        },
        "provider probe attempt failed",
      );

      if (!retry) return { attempts: attempt, failures };
    } finally {
      clearTimeout(timer);
    }

    await delay(policy.retryDelayMs);
  }
}

/** The body of an answer the probe needs whole: unreadable is a failure, not "empty". */
async function readStrictJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeFailure("invalid_response", response.status);
  }
}

/** Lets go of a body the probe does not read, so the connection is freed. */
function release(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** A 5xx or a 429 settles nothing about the provider: the attempt failed. */
function throwIfPassing(response: Response, except: number[] = []): void {
  if (except.includes(response.status)) return;

  if (response.status >= 500) {
    release(response);
    throw new ProbeFailure("http_5xx", response.status);
  }

  if (response.status === 429) {
    release(response);
    throw new ProbeFailure("throttled", response.status);
  }
}

const FAILURE_TEXT: Record<ProbeFailureKind, string> = {
  timeout: "tempo esgotado",
  network: "falha de rede",
  http_5xx: "erro do provedor",
  throttled: "limite de chamadas",
  invalid_response: "resposta incompleta",
};

function lastFailure(outcome: ProbeOutcome<unknown>): AttemptFailure {
  return outcome.failures[outcome.failures.length - 1];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What every attempt failing says, in pt-BR; `subject` reads "o Resend", "a Expo". */
function failureMessage(
  subject: string,
  outcome: ProbeOutcome<unknown>,
  policy: ProbePolicy,
): string {
  const failure = lastFailure(outcome);
  const tries =
    outcome.attempts === 1 ? "1 tentativa" : `${outcome.attempts} tentativas`;
  const Subject = capitalize(subject);

  switch (failure.kind) {
    case "timeout":
      return failure.phase === "body"
        ? `${Subject} começou a responder, mas não terminou (${tries} de até ${seconds(policy.attemptTimeoutMs)}).`
        : `${Subject} não respondeu (${tries} de até ${seconds(policy.attemptTimeoutMs)}).`;
    case "network":
      return `Sem rota até ${subject} (${failure.code ?? "erro de rede"}) em ${tries}: rede ou DNS.`;
    case "http_5xx":
      return `${Subject} respondeu HTTP ${failure.http_status} em ${tries}: instabilidade do lado do provedor.`;
    case "throttled":
      return `${Subject} limitou as chamadas (HTTP ${failure.http_status ?? 429}): a conferência fica para a próxima verificação.`;
    case "invalid_response":
      return `${Subject} respondeu de forma incompleta em ${tries}: a resposta não pôde ser lida.`;
  }
}

/**
 * A provider no attempt got an answer from. Two failures in a row (or one
 * with no budget left for another) is an error: transient says the next
 * probe may clear it, never that it is fine. A 429 alone is a warning: the
 * provider is there, only busy.
 */
function unanswered(
  key: ProviderKey,
  label: string,
  subject: string,
  outcome: ProbeOutcome<unknown>,
  deps: ReadinessDeps,
  fields: Partial<ProviderReadiness> = {},
): ProviderReadiness {
  const failure = lastFailure(outcome);

  return base(key, label, {
    status: failure.kind === "throttled" ? "warning" : "error",
    // A status or a started body is an answer, even an unusable one.
    reachable: failure.http_status !== null || failure.phase === "body",
    message: failureMessage(subject, outcome, probePolicy(deps)),
    ...fields,
    attempts: outcome.attempts,
    transient: true,
    failure_kind: failure.kind,
    details: {
      ...fields.details,
      ...(failure.http_status !== null
        ? { http_status: failure.http_status }
        : {}),
    },
  });
}

/**
 * A provider that answered, with how it took to get there: an answer only on
 * the second attempt, or a slow one, is degraded (transient) and says so in
 * its warnings. A definitive error stands whatever it took to get it.
 */
function answeredProbe(
  readiness: ProviderReadiness,
  outcome: ProbeOutcome<unknown>,
  deps: ReadinessDeps,
): ProviderReadiness {
  const failure = outcome.failures[outcome.failures.length - 1] ?? null;
  const ms = outcome.answer?.ms ?? null;
  const notes: string[] = [];

  if (failure) {
    notes.push(
      `A ${outcome.attempts - 1}ª tentativa falhou (${FAILURE_TEXT[failure.kind]}); a ${outcome.attempts}ª respondeu.`,
    );
  }

  if (ms !== null && ms >= probePolicy(deps).slowMs) {
    notes.push(`Respondeu em ${seconds(ms)}, bem acima do normal.`);
  }

  return settle({
    ...readiness,
    latency_ms: readiness.latency_ms ?? ms,
    attempts: outcome.attempts,
    failure_kind: failure?.kind ?? readiness.failure_kind,
    transient:
      readiness.transient || (readiness.status !== "error" && notes.length > 0),
    warnings: [...readiness.warnings, ...notes],
  });
}

// ---------------------------------------------------------------------------
// E-mail (Resend)
// ---------------------------------------------------------------------------

async function checkEmail(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const { env } = deps;
  const label = "E-mail (Resend)";
  const lacking = missing(env, ["RESEND_SECRET_KEY", "RESEND_FROM_EMAIL"]);
  const warnings = env.RESEND_WEBHOOK_SECRET
    ? []
    : [
        "RESEND_WEBHOOK_SECRET ausente: entregas, devoluções e reclamações do Resend não são reconciliadas.",
      ];

  if (env.NODE_ENV !== "production") {
    return base("email", label, {
      status: "disabled",
      configured: lacking.length === 0,
      missing_env: lacking,
      message:
        env.NODE_ENV === "test"
          ? "Em teste (NODE_ENV=test) os e-mails ficam numa caixa em memória do processo; nenhum sai, e o Resend não é usado."
          : "Em desenvolvimento os e-mails vão para a caixa de teste (Ethereal); o Resend não é usado.",
    });
  }

  if (lacking.length > 0) {
    return base("email", label, {
      status: "not_configured",
      configured: false,
      missing_env: lacking,
      message: "Nenhum e-mail sai: defina as variáveis do Resend.",
      warnings,
    });
  }

  const domain = senderDomain(env.RESEND_FROM_EMAIL);

  // The body is read inside the attempt: a list that stalls or arrives cut
  // is a failed attempt, never an empty list (which would read "your domain
  // is not in the account").
  const outcome = await probeAttempts(
    "email",
    deps,
    async ({ signal, answered }) => {
      const response = await deps.fetch("https://api.resend.com/domains", {
        method: "GET",
        headers: { Authorization: `Bearer ${env.RESEND_SECRET_KEY}` },
        signal,
      });

      throwIfPassing(response);
      answered();

      if (response.ok) {
        const body = (await readStrictJson(response)) as {
          data?: unknown;
        } | null;

        if (!Array.isArray(body?.data)) {
          throw new ProbeFailure("invalid_response", response.status);
        }

        return {
          status: response.status,
          name: null,
          domains: body.data as Array<{ name?: unknown; status?: unknown }>,
        };
      }

      if (response.status === 401) {
        // The body tells a sending-only key (valid) from a wrong one.
        const body = (await readStrictJson(response)) as {
          name?: unknown;
        } | null;

        return {
          status: response.status,
          name: typeof body?.name === "string" ? body.name : null,
          domains: null,
        };
      }

      release(response);

      return { status: response.status, name: null, domains: null };
    },
  );

  if (!outcome.answer) {
    return unanswered("email", label, "o Resend", outcome, deps, {
      warnings,
      details: { sender_domain: domain },
    });
  }

  const { status, name, domains } = outcome.answer.value;

  if (domains) {
    const entry = domains.find((item) => item?.name === domain);

    if (!entry) {
      return answeredProbe(
        base("email", label, {
          status: "error",
          reachable: true,
          message: `O domínio do remetente (${domain}) não está na conta do Resend: os envios serão recusados.`,
          warnings,
          details: { sender_domain: domain, domain_status: null },
        }),
        outcome,
        deps,
      );
    }

    const domainStatus = typeof entry.status === "string" ? entry.status : null;
    const verified = domainStatus === "verified";

    return answeredProbe(
      base("email", label, {
        status: verified ? "ok" : "error",
        reachable: true,
        message: verified
          ? `Chave aceita e domínio ${domain} verificado.`
          : `Domínio ${domain} com status "${domainStatus ?? "desconhecido"}" no Resend: verifique o DNS (SPF/DKIM).`,
        warnings,
        details: { sender_domain: domain, domain_status: domainStatus },
      }),
      outcome,
      deps,
    );
  }

  // A sending-only key cannot list domains, and that is the recommended
  // key: valid, just not able to say more.
  if (status === 401 && name === "restricted_api_key") {
    return answeredProbe(
      base("email", label, {
        reachable: true,
        message:
          "Chave aceita (restrita a envio): a verificação do domínio não pode ser lida com ela.",
        warnings,
        details: { sender_domain: domain, domain_status: null },
      }),
      outcome,
      deps,
    );
  }

  if (status === 401 || status === 403) {
    return answeredProbe(
      base("email", label, {
        status: "error",
        reachable: true,
        message: `O Resend recusou a chave (HTTP ${status}): gere outra e troque RESEND_SECRET_KEY.`,
        warnings,
        details: { sender_domain: domain, http_status: status },
      }),
      outcome,
      deps,
    );
  }

  return answeredProbe(
    base("email", label, {
      status: "warning",
      reachable: true,
      message: `O Resend respondeu HTTP ${status}; a chave não pôde ser conferida agora.`,
      warnings,
      details: { sender_domain: domain, http_status: status },
    }),
    outcome,
    deps,
  );
}

// ---------------------------------------------------------------------------
// WhatsApp (Meta Cloud API)
// ---------------------------------------------------------------------------

interface MetaError {
  error?: { code?: number; message?: string };
}

async function checkTemplates(
  deps: ReadinessDeps,
  names: string[],
): Promise<{
  details: Record<string, DetailValue>;
  problems: string[];
  warnings: string[];
}> {
  const { env } = deps;
  const details: Record<string, DetailValue> = {};

  if (!env.META_WHATSAPP_BUSINESS_ACCOUNT_ID) {
    for (const name of names) details[`template:${name}`] = "UNKNOWN";

    return {
      details,
      problems: [],
      warnings: [
        "Defina META_WHATSAPP_BUSINESS_ACCOUNT_ID para conferir se os templates estão aprovados.",
      ],
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  /**
   * One probe per template, side by side: each is a GET of its own, and in a
   * loop the page waited for the sum of their timeouts. The verdicts are
   * collected in the templates' order, so the messages read the same.
   */
  const verdicts = await Promise.all(
    names.map((name) => checkTemplate(deps, name)),
  );

  for (const verdict of verdicts) {
    Object.assign(details, verdict.details);
    problems.push(...verdict.problems);
    warnings.push(...verdict.warnings);
  }

  return { details, problems, warnings };
}

/** One template's approval, as one GET of the account's template list. */
async function checkTemplate(
  deps: ReadinessDeps,
  name: string,
): Promise<{
  details: Record<string, DetailValue>;
  problems: string[];
  warnings: string[];
}> {
  const { env } = deps;
  const key = `template:${name}`;

  try {
    const url =
      `https://graph.facebook.com/${env.META_WHATSAPP_API_VERSION}/` +
      `${env.META_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates` +
      `?name=${encodeURIComponent(name)}&fields=name,status,language&limit=100`;

    const response = await deps.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(probePolicy(deps).attemptTimeoutMs),
    });
    const body = (await readJson(response)) as
      | ({
          data?: Array<{ name?: string; status?: string; language?: string }>;
        } & MetaError)
      | null;

    if (!response.ok) {
      return {
        details: { [key]: "UNKNOWN" },
        problems: [],
        warnings: [
          `A lista de templates não pôde ser lida (HTTP ${response.status}${
            body?.error?.code ? `, código ${body.error.code}` : ""
          }): confira META_WHATSAPP_BUSINESS_ACCOUNT_ID e a permissão whatsapp_business_management do token.`,
        ],
      };
    }

    // A list that stalled, arrived cut or came without `data` says nothing
    // about the template: never "does not exist" (an error) from it.
    if (!Array.isArray(body?.data)) {
      return {
        details: { [key]: "UNKNOWN" },
        problems: [],
        warnings: [
          `A lista de templates veio incompleta e o template ${name} não pôde ser conferido agora.`,
        ],
      };
    }

    const matches = body.data.filter((item) => item.name === name);
    const entry =
      matches.find((item) => item.language === TEMPLATE_LANGUAGE) ?? matches[0];

    if (!entry) {
      return {
        details: { [key]: "MISSING" },
        problems: [`O template ${name} não existe na conta.`],
        warnings: [],
      };
    }

    const status = entry.status ?? "UNKNOWN";

    if (status !== "APPROVED") {
      return {
        details: { [key]: status },
        problems: [
          `O template ${name} está ${status}, não APPROVED: os envios com ele falham.`,
        ],
        warnings: [],
      };
    }

    return {
      details: { [key]: status },
      problems: [],
      warnings:
        entry.language && entry.language !== TEMPLATE_LANGUAGE
          ? [
              `O template ${name} está aprovado em ${entry.language}, mas os envios pedem ${TEMPLATE_LANGUAGE}.`,
            ]
          : [],
    };
  } catch (error) {
    return {
      details: { [key]: "UNKNOWN" },
      problems: [],
      warnings: [
        failureKind(error) === "timeout"
          ? `A Meta não respondeu sobre o template ${name}.`
          : `Sem rota até a Meta ao conferir o template ${name}.`,
      ],
    };
  }
}

async function checkWhatsApp(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const { env } = deps;
  const label = "WhatsApp (Meta)";
  const lacking = missing(env, [
    "META_WHATSAPP_ACCESS_TOKEN",
    "META_WHATSAPP_PHONE_NUMBER_ID",
  ]);
  const webhookWarnings =
    env.META_WHATSAPP_APP_SECRET && env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN
      ? []
      : [
          "META_WHATSAPP_APP_SECRET e META_WHATSAPP_WEBHOOK_VERIFY_TOKEN ausentes: os status de entrega da Meta não são reconciliados.",
        ];

  if (lacking.length > 0) {
    return base("whatsapp", label, {
      status: "not_configured",
      configured: false,
      missing_env: lacking,
      message:
        "Nenhum WhatsApp sai: os envios falham com erro claro até as variáveis existirem.",
      warnings: webhookWarnings,
    });
  }

  const templates = [
    ...new Set(
      [
        env.META_WHATSAPP_TEMPLATE_NAME,
        env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME,
      ].filter((name): name is string => Boolean(name)),
    ),
  ];

  // The templates are read side by side with the number, not after it: the
  // page waited for the number's probe plus each template's. Their verdict
  // is only used when the number answered; checkTemplates never throws.
  const templatesCheck = checkTemplates(deps, templates);

  const outcome = await probeAttempts(
    "whatsapp",
    deps,
    async ({ signal, answered }) => {
      const response = await deps.fetch(
        `https://graph.facebook.com/${env.META_WHATSAPP_API_VERSION}/${env.META_WHATSAPP_PHONE_NUMBER_ID}` +
          "?fields=display_phone_number,verified_name,quality_rating",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`,
          },
          signal,
        },
      );

      throwIfPassing(response);
      answered();

      const body = (await readJson(response)) as
        | ({
            display_phone_number?: string;
            verified_name?: string;
            quality_rating?: string;
          } & MetaError)
        | null;

      return { ok: response.ok, status: response.status, body };
    },
  );

  if (!outcome.answer) {
    return unanswered("whatsapp", label, "a Meta", outcome, deps, {
      warnings: webhookWarnings,
    });
  }

  const { ok, status, body } = outcome.answer.value;

  if (!ok) {
    const code = body?.error?.code ?? null;
    const credential = status === 401 || code === 190;

    return answeredProbe(
      base("whatsapp", label, {
        status: "error",
        reachable: true,
        message: credential
          ? "A Meta recusou o token (código 190): gere um token de usuário do sistema e troque META_WHATSAPP_ACCESS_TOKEN."
          : `A Meta respondeu HTTP ${status}${code ? ` (código ${code})` : ""} ao ler o número: confira META_WHATSAPP_PHONE_NUMBER_ID.`,
        warnings: webhookWarnings,
        details: { http_status: status, meta_code: code },
      }),
      outcome,
      deps,
    );
  }

  const checked = await templatesCheck;
  const quality = body?.quality_rating ?? null;
  const warnings = [...checked.warnings, ...webhookWarnings];

  if (quality === "RED") {
    warnings.push(
      "Qualidade do número em RED na Meta: risco de limite de envio.",
    );
  }

  return answeredProbe(
    base("whatsapp", label, {
      status: checked.problems.length > 0 ? "error" : "ok",
      reachable: true,
      message:
        checked.problems.length > 0
          ? checked.problems.join(" ")
          : "Token aceito e número encontrado na Meta.",
      warnings,
      details: {
        display_phone_number: body?.display_phone_number ?? null,
        verified_name: body?.verified_name ?? null,
        quality_rating: quality,
        ...checked.details,
      },
    }),
    outcome,
    deps,
  );
}

// ---------------------------------------------------------------------------
// Push (Expo → FCM)
// ---------------------------------------------------------------------------

async function checkPush(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const label = "Push (Expo → FCM)";

  // The FCM service account lives in the EAS project, not here: the API
  // only reaches Expo. A receipts query for an id that does not exist proves
  // the route without sending anything, so it is safe to repeat.
  const outcome = await probeAttempts(
    "push",
    deps,
    async ({ signal, answered }) => {
      const response = await deps.fetch(
        "https://exp.host/--/api/v2/push/getReceipts",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            ids: ["00000000-0000-0000-0000-000000000000"],
          }),
          signal,
        },
      );

      throwIfPassing(response);
      answered();
      release(response);

      return { ok: response.ok, status: response.status };
    },
  );

  if (!outcome.answer) {
    return unanswered("push", label, "a Expo", outcome, deps, {
      details: { fcm_credentials: "eas" },
    });
  }

  const { ok, status } = outcome.answer.value;

  return answeredProbe(
    base("push", label, {
      status: ok ? "ok" : "error",
      reachable: true,
      message: ok
        ? "Serviço de push da Expo acessível. A credencial do FCM fica no projeto EAS: um erro nela aparece nos recibos (InvalidCredentials)."
        : `A Expo respondeu HTTP ${status}.`,
      details: { fcm_credentials: "eas" },
    }),
    outcome,
    deps,
  );
}

// ---------------------------------------------------------------------------
// Storage (Cloudflare R2)
// ---------------------------------------------------------------------------

async function checkStorage(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const { env } = deps;
  const label = "Armazenamento (R2)";

  if (env.UPLOAD_STORAGE_TYPE !== "r2") {
    return base("storage", label, {
      status: env.NODE_ENV === "production" ? "error" : "disabled",
      configured: false,
      missing_env: ["UPLOAD_STORAGE_TYPE"],
      message:
        env.NODE_ENV === "production"
          ? "Armazenamento local em produção: as fotos ficam no contêiner e somem no próximo deploy. Use UPLOAD_STORAGE_TYPE=r2."
          : "Fora de produção as fotos ficam na pasta local (UPLOAD_LOCAL_PATH).",
      details: { storage: "local" },
    });
  }

  const lacking = missing(env, [
    ...(env.R2_ENDPOINT ? [] : (["R2_ACCOUNT_ID"] as const)),
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]);

  if (lacking.length > 0) {
    return base("storage", label, {
      status: "not_configured",
      configured: false,
      missing_env: lacking,
      message: "Uploads e fotos falham até as variáveis do R2 existirem.",
      details: { storage: "r2" },
    });
  }

  const bucket = { storage: "r2", bucket: env.R2_BUCKET_NAME ?? null };

  const outcome = await probeAttempts("storage", deps, async ({ signal }) => {
    try {
      await deps.headBucket(signal);

      return { httpStatus: null as number | null };
    } catch (error) {
      const status = (
        error as { $metadata?: { httpStatusCode?: unknown } } | null
      )?.$metadata?.httpStatusCode;

      // No status (DNS, reset, our own deadline): the attempt classifies it.
      if (typeof status !== "number" || signal.aborted) throw error;

      // A 5xx is the R2 answering that it cannot answer now: the route is
      // fine, and the next attempt may get the bucket.
      if (status >= 500) throw new ProbeFailure("http_5xx", status);
      if (status === 429) throw new ProbeFailure("throttled", status);

      // Any other status is the bucket's definitive answer.
      return { httpStatus: status };
    }
  });

  if (!outcome.answer) {
    return unanswered("storage", label, "o R2", outcome, deps, {
      details: bucket,
    });
  }

  const status = outcome.answer.value.httpStatus;

  if (status === null) {
    return answeredProbe(
      base("storage", label, {
        reachable: true,
        message: "Bucket acessível com a credencial configurada.",
        details: bucket,
      }),
      outcome,
      deps,
    );
  }

  return answeredProbe(
    base("storage", label, {
      status: "error",
      reachable: true,
      message:
        status === 401 || status === 403
          ? `O R2 recusou a credencial (HTTP ${status}): confira R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY e a permissão no bucket.`
          : status === 404
            ? "O bucket não existe nesta conta: confira R2_BUCKET_NAME e R2_ACCOUNT_ID."
            : `O R2 respondeu HTTP ${status} ao consultar o bucket: confira R2_ENDPOINT e R2_BUCKET_NAME.`,
      details: { ...bucket, http_status: status },
    }),
    outcome,
    deps,
  );
}

// ---------------------------------------------------------------------------
// AI OCR (trajetto-ai)
// ---------------------------------------------------------------------------

async function checkAiOcr(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const { env } = deps;
  const label = "Leitura de fotos (trajetto-ai)";

  if (env.AI_PROVIDER === "none") {
    return base("ai_ocr", label, {
      status: "disabled",
      configured: false,
      message:
        "AI_PROVIDER=none: as leituras de odômetro, checklist e comprovante estão desligadas.",
    });
  }

  const lacking = missing(env, ["AI_LOCAL_URL", "AI_LOCAL_TOKEN"]);

  if (lacking.length > 0) {
    return base("ai_ocr", label, {
      status: "not_configured",
      configured: false,
      missing_env: lacking,
      message:
        "Sem URL ou token o serviço é tratado como desligado: os registros são marcados como não analisados.",
    });
  }

  const url = env.AI_LOCAL_URL!.replace(/\/+$/, "");
  const timeoutMs = probePolicy(deps).attemptTimeoutMs;

  // Host and port only (the URL never carries credentials, but a typo could):
  // which name the API tried is what tells a wrong App Name from a down service.
  let host = url;

  try {
    host = new URL(url).host;
  } catch {
    // Left as typed; the schema already requires a URL.
  }

  /**
   * The token check starts with /health instead of after it: the two are
   * independent requests, and in sequence the page waited for both timeouts
   * when the service was slow. Its outcome is only read once /health
   * answered; probeAttempts never rejects, so a failure never goes
   * unhandled.
   *
   * The service checks the token before anything else, so an empty request
   * with an unknown profile answers 401 for a wrong token and 400 for a
   * right one, without reading a photo or taking the slot. No hand-written
   * Content-Length: fetch sets it for the empty body, as it does for the
   * readings (local-ocr-reader.ts), which work.
   *
   * The same retry rule as every probe: a timeout, a reset or a 5xx gets one
   * more attempt inside the budget, and the 401 or the 400 is taken as it
   * came. A single attempt here left OCR red on the DNS blip /health had
   * just recovered from. Repeating it is safe: it is refused before
   * anything is read, never a reading.
   */
  const tokenProbe = probeAttempts(
    "ai_ocr",
    deps,
    async ({ signal, answered }) => {
      const response = await deps.fetch(
        `${url}/v1/read?profile=readiness-probe`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.AI_LOCAL_TOKEN}` },
          signal,
        },
      );

      // A 5xx in front of the service said nothing about the token, and
      // used to read as "token aceito".
      throwIfPassing(response);
      answered();

      // Only the status answers; the body is let go.
      release(response);

      return response.status;
    },
  );

  // 503 is the service saying it is warming its models: an answer, not a
  // failure to retry.
  const outcome = await probeAttempts(
    "ai_ocr",
    deps,
    async ({ signal, answered }) => {
      const response = await deps.fetch(`${url}/health`, {
        method: "GET",
        signal,
      });

      throwIfPassing(response, [503]);
      answered();

      const body = (await readJson(response)) as {
        ok?: boolean;
        engine?: string;
        engineVersion?: string;
        error?: string;
      } | null;

      return { ok: response.ok, status: response.status, body };
    },
  );

  if (!outcome.answer) {
    const failure = lastFailure(outcome);

    return unanswered("ai_ocr", label, `o serviço em ${host}`, outcome, deps, {
      ...(failure.kind === "network"
        ? {
            message: `Sem rota até ${host} (${failure.detail ?? failure.code ?? "erro de rede"}): confira se a Application trajetto-ai está de pé e se AI_LOCAL_URL usa o App Name dela (http://<App Name>:8080), não o Name.`,
          }
        : {}),
    });
  }

  const { ok, status, body } = outcome.answer.value;

  if (status === 503) {
    return answeredProbe(
      base("ai_ocr", label, {
        status: "warning",
        reachable: true,
        // Warming up passes by itself: the report is re-read in seconds.
        transient: true,
        message:
          "O serviço está aquecendo os modelos; as leituras esperam na fila.",
      }),
      outcome,
      deps,
    );
  }

  if (!ok) {
    return answeredProbe(
      base("ai_ocr", label, {
        status: "error",
        reachable: true,
        message: `O serviço respondeu HTTP ${status} em /health.`,
      }),
      outcome,
      deps,
    );
  }

  const details = {
    engine: body?.engine ?? null,
    engine_version: body?.engineVersion ?? null,
  };
  const token = await tokenProbe;

  if (!token.answer) {
    // /health answered, so the route exists: what failed is the token
    // check, every attempt of its own. A 429 alone is a warning, as
    // everywhere: the service is there, only busy.
    const failure = lastFailure(token);
    const tries =
      token.attempts === 1 ? "1 tentativa" : `${token.attempts} tentativas`;
    const answeredHealth = `O serviço em ${host} respondeu /health, mas a conferência do token`;

    return answeredProbe(
      base("ai_ocr", label, {
        status: failure.kind === "throttled" ? "warning" : "error",
        reachable: true,
        transient: true,
        failure_kind: failure.kind,
        message:
          failure.kind === "timeout"
            ? `${answeredHealth} não respondeu (${tries} de até ${seconds(timeoutMs)}).`
            : failure.kind === "throttled"
              ? `${answeredHealth} foi limitada (HTTP ${failure.http_status ?? 429}): fica para a próxima verificação.`
              : failure.kind === "http_5xx"
                ? `${answeredHealth} recebeu HTTP ${failure.http_status} em ${tries}.`
                : `${answeredHealth} falhou em ${tries} (${failure.detail ?? failure.code ?? "erro de rede"}).`,
        details: {
          ...(failure.http_status !== null
            ? { http_status: failure.http_status }
            : {}),
        },
      }),
      outcome,
      deps,
    );
  }

  if (token.answer.value === 401) {
    return answeredProbe(
      base("ai_ocr", label, {
        status: "error",
        reachable: true,
        message:
          "O serviço recusou o token: AI_LOCAL_TOKEN tem de ser o mesmo AI_TOKEN do trajetto-ai.",
        details,
      }),
      outcome,
      deps,
    );
  }

  // Accepted only on a retry: unstable, like any probe that recovered.
  const tokenRetry = token.failures[token.failures.length - 1];

  return answeredProbe(
    base("ai_ocr", label, {
      reachable: true,
      message: "Serviço pronto e token aceito.",
      details,
      ...(tokenRetry && {
        transient: true,
        failure_kind: tokenRetry.kind,
        warnings: [
          `A ${token.attempts - 1}ª conferência do token falhou (${FAILURE_TEXT[tokenRetry.kind]}); a ${token.attempts}ª respondeu.`,
        ],
      }),
    }),
    outcome,
    deps,
  );
}

// ---------------------------------------------------------------------------
// Proof certificate (ICP-Brasil A1)
// ---------------------------------------------------------------------------

function checkProofCertificate(deps: ReadinessDeps): ProviderReadiness {
  const label = "Certificado do comprovante (ICP-Brasil)";
  const health = deps.proofHealth();
  const details = {
    state: health.state,
    not_after: health.not_after,
    days_left: health.days_left,
  };

  switch (health.state) {
    case "READY":
      return settle(
        base("proof_certificate", label, {
          message: "Os comprovantes saem assinados.",
          warnings:
            health.days_left !== null &&
            health.days_left <= CERTIFICATE_WARN_DAYS
              ? [
                  `O certificado vence em ${health.days_left} dia(s): renove o A1 e troque PROOF_SIGNING_PFX_*.`,
                ]
              : [],
          details,
        }),
      );
    case "ABSENT":
      return base("proof_certificate", label, {
        status: "not_configured",
        configured: false,
        missing_env: ["PROOF_SIGNING_PFX_BASE64", "PROOF_SIGNING_PFX_PASSWORD"],
        message:
          "Sem certificado: os comprovantes saem sem assinatura digital (e dizem isso).",
        details,
      });
    case "DISABLED":
      return base("proof_certificate", label, {
        status: "disabled",
        message:
          "PROOF_SIGNING_DISABLED ligado: os comprovantes saem sem assinatura digital.",
        details,
      });
    case "EXPIRED":
      return base("proof_certificate", label, {
        status: "error",
        message:
          "Certificado vencido: os comprovantes saem sem assinatura. Renove o A1.",
        details,
      });
    default:
      return base("proof_certificate", label, {
        status: "error",
        message: `Certificado inválido (${health.reason ?? "motivo desconhecido"}): senha errada, arquivo corrompido ou secret não montado.`,
        details: { ...details, reason: health.reason },
      });
  }
}

// ---------------------------------------------------------------------------
// Heartbeat (dead man's switch)
// ---------------------------------------------------------------------------

function checkHeartbeat(deps: ReadinessDeps): ProviderReadiness {
  const { env } = deps;
  const label = "Alerta externo (heartbeat)";

  if (!env.HEALTHCHECK_PING_URL) {
    return base("heartbeat", label, {
      status: "not_configured",
      configured: false,
      missing_env: ["HEALTHCHECK_PING_URL"],
      message:
        "Sem heartbeat ninguém é avisado de uma pane: as regras só vão para o log. Veja docs/deploy.md (Alertas e monitoramento).",
    });
  }

  const outcome = deps.heartbeat();
  const now = (deps.now ?? (() => new Date()))().getTime();
  const details = {
    fail_url: Boolean(env.HEALTHCHECK_FAIL_URL),
    last_ping_at: outcome?.at ?? null,
    last_ping_healthy: outcome?.healthy ?? null,
    last_ping_http_status: outcome?.http_status ?? null,
  };

  if (!outcome || now - new Date(outcome.at).getTime() > HEARTBEAT_FRESH_MS) {
    return base("heartbeat", label, {
      message:
        "Configurado. Esta réplica não pingou nos últimos minutos (a eleição do cron escolhe uma por minuto): confira o painel do serviço.",
      details,
    });
  }

  if (!outcome.delivered) {
    return base("heartbeat", label, {
      status: "error",
      reachable: outcome.http_status !== null,
      message:
        outcome.http_status === null
          ? "O último ping não chegou ao serviço de monitoramento (rede ou DNS)."
          : `O serviço de monitoramento respondeu HTTP ${outcome.http_status} ao último ping: confira a URL.`,
      details,
    });
  }

  // Delivered: the check works; a failing verdict means the alert is firing.
  return settle(
    base("heartbeat", label, {
      reachable: true,
      message: outcome.healthy
        ? "Último ping entregue com a operação saudável."
        : "Último ping entregue como falha: o alerta está disparado (veja os motivos no log).",
      warnings: outcome.healthy ? [] : ["Há regra de operação quebrada agora."],
      details,
    }),
  );
}

// ---------------------------------------------------------------------------

/** Every provider, probed side by side; one failing never hides another. */
async function checkProviders(
  deps: ReadinessDeps,
): Promise<ProviderReadinessReport> {
  const now = deps.now ?? (() => new Date());

  const providers = await Promise.all([
    checkEmail(deps),
    checkWhatsApp(deps),
    checkPush(deps),
    checkStorage(deps),
    checkAiOcr(deps),
    Promise.resolve(checkProofCertificate(deps)),
    Promise.resolve(checkHeartbeat(deps)),
  ]);

  return { checked_at: now().toISOString(), providers };
}

let storageClient: S3Client | null = null;

function productionDeps(): ReadinessDeps {
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    headBucket: async (signal) => {
      // One HEAD per attempt: the probe owns the retry policy. With the
      // SDK's default (3 attempts) a 5xx cost three HEADs, and a request we
      // had already aborted was retried twice more (its cause is a
      // TimeoutError, which the SDK counts as transient).
      storageClient ??= new S3Client({
        credentials: {
          accessKeyId: uploadConfig.r2.accessKeyId,
          secretAccessKey: uploadConfig.r2.secretAccessKey,
        },
        endpoint: uploadConfig.r2.endpoint,
        forcePathStyle: uploadConfig.r2.forcePathStyle,
        region: "auto",
        maxAttempts: 1,
      });

      await storageClient.send(
        new HeadBucketCommand({ Bucket: uploadConfig.r2.bucket }),
        {
          abortSignal: signal,
        },
      );
    },
    proofHealth: () =>
      container.resolve<ProofSigningService>("ProofSigningService").health(),
    heartbeat: lastHeartbeatOutcome,
  };
}

/**
 * Probes are cached for this long, and concurrent readers share one probe:
 * refreshing the screen must not turn into calls to Meta. The report is
 * platform configuration only (variable names, states, latencies), so the
 * copy is shared by the replicas through Redis (snapshot-cache.ts): the
 * replica the next request lands on serves it instead of probing again.
 */
const READINESS_CACHE_MS = 30 * 1000;

/**
 * A report in which some provider is transient (a failed or slow attempt)
 * is served this long instead: a blip is not pinned on every replica's
 * screen for 30 s, and the next read probes again. Single-flight per replica
 * keeps that to one round of probes per interval.
 */
const READINESS_TRANSIENT_CACHE_MS = 5 * 1000;

/**
 * `refresh=true` probes again only once the report is this old: the button
 * pressed in a loop is one round of probes per interval, not one per click.
 */
const READINESS_REFRESH_MIN_MS = 5 * 1000;

/** How long a report is served, decided by what it says. */
function readinessTtl(report: ProviderReadinessReport): number {
  return report.providers.some((provider) => provider.transient === true)
    ? READINESS_TRANSIENT_CACHE_MS
    : READINESS_CACHE_MS;
}

function readinessCache(
  deps: () => ReadinessDeps,
  store: SnapshotStore | null,
): SnapshotCache<ProviderReadinessReport> {
  return new SnapshotCache({
    name: "provider-readiness",
    ttlMs: readinessTtl,
    minRefreshMs: READINESS_REFRESH_MIN_MS,
    compute: () => checkProviders(deps()),
    store,
  });
}

let cache: SnapshotCache<ProviderReadinessReport> | null = null;

async function readProviderReadiness({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<
  ProviderReadinessReport & { cached: boolean }
> {
  cache ??= readinessCache(
    productionDeps,
    redisSnapshotStore(() => RedisConnection.getInstance().getClient()),
  );

  const { value, cached } = await cache.read({ refresh });

  return { ...value, cached };
}

/** For tests: forget this replica's cached report. */
function resetProviderReadinessCache(): void {
  cache?.reset();
}

export {
  PROBE_ATTEMPT_TIMEOUT_MS,
  PROBE_BUDGET_MS,
  PROBE_MAX_ATTEMPTS,
  PROBE_RETRY_DELAY_MS,
  PROBE_SLOW_MS,
  READINESS_CACHE_MS,
  READINESS_REFRESH_MIN_MS,
  READINESS_TRANSIENT_CACHE_MS,
  readinessCache,
  readinessTtl,
  checkAiOcr,
  checkEmail,
  checkHeartbeat,
  checkProofCertificate,
  checkProviders,
  checkPush,
  checkStorage,
  checkWhatsApp,
  readProviderReadiness,
  resetProviderReadinessCache,
};
export type {
  ProbeFailureKind,
  ProbeLog,
  ProviderKey,
  ProviderReadiness,
  ProviderReadinessReport,
  ReadinessDeps,
  ReadinessEnv,
  ReadinessStatus,
};

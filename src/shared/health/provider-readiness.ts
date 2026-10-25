import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { container } from "tsyringe";

import { env } from "@/env";
import { uploadConfig } from "@/config/upload";
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

interface ReadinessDeps {
  env: ReadinessEnv;
  fetch: typeof fetch;

  /** Resolves when the bucket answers HEAD; throws the S3 error otherwise. */
  headBucket: (signal: AbortSignal) => Promise<void>;
  proofHealth: () => ProofHealthLike;
  heartbeat: () => HeartbeatOutcome | null;
  now?: () => Date;
  timeoutMs?: number;
}

/** A probe slower than this counts as unreachable; the page waits for all. */
const PROBE_TIMEOUT_MS = 5_000;

/** A certificate this close to its end is a warning (the alert's 30 days). */
const CERTIFICATE_WARN_DAYS = 30;

/** A heartbeat older than this on the replica that answered says nothing. */
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;

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

/** The system code under fetch's "fetch failed" (ENOTFOUND, ECONNREFUSED…). */
function networkCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;

  return typeof cause?.code === "string" ? cause.code : "erro de rede";
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  const value = await run();

  return { value, ms: Math.round(performance.now() - startedAt) };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
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
        "Fora de produção os e-mails vão para a caixa de teste (Ethereal); o Resend não é usado.",
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
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const { value: response, ms } = await timed(() =>
      deps.fetch("https://api.resend.com/domains", {
        method: "GET",
        headers: { Authorization: `Bearer ${env.RESEND_SECRET_KEY}` },
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    const body = (await readJson(response)) as {
      name?: string;
      data?: Array<{ name?: string; status?: string }>;
    } | null;

    if (response.ok) {
      const entry = body?.data?.find((item) => item.name === domain);

      if (!entry) {
        return settle(
          base("email", label, {
            status: "error",
            reachable: true,
            latency_ms: ms,
            message: `O domínio do remetente (${domain}) não está na conta do Resend: os envios serão recusados.`,
            warnings,
            details: { sender_domain: domain, domain_status: null },
          }),
        );
      }

      const verified = entry.status === "verified";

      return settle(
        base("email", label, {
          status: verified ? "ok" : "error",
          reachable: true,
          latency_ms: ms,
          message: verified
            ? `Chave aceita e domínio ${domain} verificado.`
            : `Domínio ${domain} com status "${entry.status ?? "desconhecido"}" no Resend: verifique o DNS (SPF/DKIM).`,
          warnings,
          details: {
            sender_domain: domain,
            domain_status: entry.status ?? null,
          },
        }),
      );
    }

    // A sending-only key cannot list domains, and that is the recommended
    // key: valid, just not able to say more.
    if (response.status === 401 && body?.name === "restricted_api_key") {
      return settle(
        base("email", label, {
          reachable: true,
          latency_ms: ms,
          message:
            "Chave aceita (restrita a envio): a verificação do domínio não pode ser lida com ela.",
          warnings,
          details: { sender_domain: domain, domain_status: null },
        }),
      );
    }

    if (response.status === 401 || response.status === 403) {
      return settle(
        base("email", label, {
          status: "error",
          reachable: true,
          latency_ms: ms,
          message: `O Resend recusou a chave (HTTP ${response.status}): gere outra e troque RESEND_SECRET_KEY.`,
          warnings,
          details: { sender_domain: domain, http_status: response.status },
        }),
      );
    }

    return settle(
      base("email", label, {
        status: "warning",
        reachable: true,
        latency_ms: ms,
        message: `O Resend respondeu HTTP ${response.status}; a chave não pôde ser conferida agora.`,
        warnings,
        details: { sender_domain: domain, http_status: response.status },
      }),
    );
  } catch (error) {
    return base("email", label, {
      status: "error",
      reachable: false,
      message:
        failureKind(error) === "timeout"
          ? `O Resend não respondeu em ${timeoutMs / 1000}s.`
          : "Sem rota até o Resend (rede ou DNS).",
      warnings,
      details: { sender_domain: domain },
    });
  }
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

  for (const name of names) {
    try {
      const url =
        `https://graph.facebook.com/${env.META_WHATSAPP_API_VERSION}/` +
        `${env.META_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates` +
        `?name=${encodeURIComponent(name)}&fields=name,status,language&limit=100`;

      const response = await deps.fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
      });
      const body = (await readJson(response)) as
        | ({
            data?: Array<{ name?: string; status?: string; language?: string }>;
          } & MetaError)
        | null;

      if (!response.ok) {
        details[`template:${name}`] = "UNKNOWN";
        warnings.push(
          `A lista de templates não pôde ser lida (HTTP ${response.status}${
            body?.error?.code ? `, código ${body.error.code}` : ""
          }): confira META_WHATSAPP_BUSINESS_ACCOUNT_ID e a permissão whatsapp_business_management do token.`,
        );
        continue;
      }

      const matches = (body?.data ?? []).filter((item) => item.name === name);
      const entry =
        matches.find((item) => item.language === TEMPLATE_LANGUAGE) ??
        matches[0];

      if (!entry) {
        details[`template:${name}`] = "MISSING";
        problems.push(`O template ${name} não existe na conta.`);
        continue;
      }

      const status = entry.status ?? "UNKNOWN";
      details[`template:${name}`] = status;

      if (status !== "APPROVED") {
        problems.push(
          `O template ${name} está ${status}, não APPROVED: os envios com ele falham.`,
        );
      } else if (entry.language && entry.language !== TEMPLATE_LANGUAGE) {
        warnings.push(
          `O template ${name} está aprovado em ${entry.language}, mas os envios pedem ${TEMPLATE_LANGUAGE}.`,
        );
      }
    } catch (error) {
      details[`template:${name}`] = "UNKNOWN";
      warnings.push(
        failureKind(error) === "timeout"
          ? `A Meta não respondeu sobre o template ${name}.`
          : `Sem rota até a Meta ao conferir o template ${name}.`,
      );
    }
  }

  return { details, problems, warnings };
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

  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const templates = [
    ...new Set(
      [
        env.META_WHATSAPP_TEMPLATE_NAME,
        env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME,
      ].filter((name): name is string => Boolean(name)),
    ),
  ];

  try {
    const { value: response, ms } = await timed(() =>
      deps.fetch(
        `https://graph.facebook.com/${env.META_WHATSAPP_API_VERSION}/${env.META_WHATSAPP_PHONE_NUMBER_ID}` +
          "?fields=display_phone_number,verified_name,quality_rating",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      ),
    );
    const body = (await readJson(response)) as
      | ({
          display_phone_number?: string;
          verified_name?: string;
          quality_rating?: string;
        } & MetaError)
      | null;

    if (!response.ok) {
      const code = body?.error?.code ?? null;
      const credential = response.status === 401 || code === 190;

      return base("whatsapp", label, {
        status: "error",
        reachable: true,
        latency_ms: ms,
        message: credential
          ? "A Meta recusou o token (código 190): gere um token de usuário do sistema e troque META_WHATSAPP_ACCESS_TOKEN."
          : `A Meta respondeu HTTP ${response.status}${code ? ` (código ${code})` : ""} ao ler o número: confira META_WHATSAPP_PHONE_NUMBER_ID.`,
        warnings: webhookWarnings,
        details: { http_status: response.status, meta_code: code },
      });
    }

    const checked = await checkTemplates(deps, templates);
    const quality = body?.quality_rating ?? null;
    const warnings = [...checked.warnings, ...webhookWarnings];

    if (quality === "RED") {
      warnings.push(
        "Qualidade do número em RED na Meta: risco de limite de envio.",
      );
    }

    return settle(
      base("whatsapp", label, {
        status: checked.problems.length > 0 ? "error" : "ok",
        reachable: true,
        latency_ms: ms,
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
    );
  } catch (error) {
    return base("whatsapp", label, {
      status: "error",
      reachable: false,
      message:
        failureKind(error) === "timeout"
          ? `A Meta não respondeu em ${timeoutMs / 1000}s.`
          : "Sem rota até a Meta (rede ou DNS).",
      warnings: webhookWarnings,
    });
  }
}

// ---------------------------------------------------------------------------
// Push (Expo → FCM)
// ---------------------------------------------------------------------------

async function checkPush(deps: ReadinessDeps): Promise<ProviderReadiness> {
  const label = "Push (Expo → FCM)";
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  // The FCM service account lives in the EAS project, not here: the API
  // only reaches Expo. A receipts query for an id that does not exist proves
  // the route without sending anything.
  try {
    const { value: response, ms } = await timed(() =>
      deps.fetch("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ ids: ["00000000-0000-0000-0000-000000000000"] }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );

    return base("push", label, {
      status: response.ok ? "ok" : "error",
      reachable: true,
      latency_ms: ms,
      message: response.ok
        ? "Serviço de push da Expo acessível. A credencial do FCM fica no projeto EAS: um erro nela aparece nos recibos (InvalidCredentials)."
        : `A Expo respondeu HTTP ${response.status}.`,
      details: { fcm_credentials: "eas" },
    });
  } catch (error) {
    return base("push", label, {
      status: "error",
      reachable: false,
      message:
        failureKind(error) === "timeout"
          ? `A Expo não respondeu em ${timeoutMs / 1000}s.`
          : "Sem rota até a Expo (rede ou DNS).",
      details: { fcm_credentials: "eas" },
    });
  }
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

  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const { ms } = await timed(() =>
      deps.headBucket(AbortSignal.timeout(timeoutMs)),
    );

    return base("storage", label, {
      reachable: true,
      latency_ms: ms,
      message: "Bucket acessível com a credencial configurada.",
      details: { storage: "r2", bucket: env.R2_BUCKET_NAME ?? null },
    });
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
      ?.$metadata?.httpStatusCode;

    if (status === 403 || status === 401) {
      return base("storage", label, {
        status: "error",
        reachable: true,
        message: `O R2 recusou a credencial (HTTP ${status}): confira R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY e a permissão no bucket.`,
        details: {
          storage: "r2",
          bucket: env.R2_BUCKET_NAME ?? null,
          http_status: status,
        },
      });
    }

    if (status === 404) {
      return base("storage", label, {
        status: "error",
        reachable: true,
        message:
          "O bucket não existe nesta conta: confira R2_BUCKET_NAME e R2_ACCOUNT_ID.",
        details: {
          storage: "r2",
          bucket: env.R2_BUCKET_NAME ?? null,
          http_status: status,
        },
      });
    }

    return base("storage", label, {
      status: "error",
      reachable: false,
      message:
        failureKind(error) === "timeout"
          ? `O R2 não respondeu em ${timeoutMs / 1000}s.`
          : "Sem rota até o R2 (rede ou DNS).",
      details: { storage: "r2", bucket: env.R2_BUCKET_NAME ?? null },
    });
  }
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
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  // Host and port only (the URL never carries credentials, but a typo could):
  // which name the API tried is what tells a wrong App Name from a down service.
  let host = url;

  try {
    host = new URL(url).host;
  } catch {
    // Left as typed; the schema already requires a URL.
  }

  let response: Response;
  let ms: number;

  try {
    ({ value: response, ms } = await timed(() =>
      deps.fetch(`${url}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ));
  } catch (error) {
    return base("ai_ocr", label, {
      status: "error",
      reachable: false,
      message:
        failureKind(error) === "timeout"
          ? `O serviço em ${host} não respondeu em ${timeoutMs / 1000}s.`
          : `Sem rota até ${host} (${networkCode(error)}): confira se a Application trajetto-ai está de pé e se AI_LOCAL_URL usa o App Name dela (http://<App Name>:8080), não o Name.`,
    });
  }

  try {
    const body = (await readJson(response)) as {
      ok?: boolean;
      engine?: string;
      engineVersion?: string;
      error?: string;
    } | null;

    if (response.status === 503) {
      return base("ai_ocr", label, {
        status: "warning",
        reachable: true,
        latency_ms: ms,
        message:
          "O serviço está aquecendo os modelos; as leituras esperam na fila.",
      });
    }

    if (!response.ok) {
      return base("ai_ocr", label, {
        status: "error",
        reachable: true,
        latency_ms: ms,
        message: `O serviço respondeu HTTP ${response.status} em /health.`,
      });
    }

    // The token: the service checks it before anything else, so an empty
    // request with an unknown profile answers 401 for a wrong token and 400
    // for a right one, without reading a photo or taking the slot.
    const tokenProbe = await deps.fetch(
      `${url}/v1/read?profile=readiness-probe`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_LOCAL_TOKEN}`,
          "Content-Length": "0",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    const details = {
      engine: body?.engine ?? null,
      engine_version: body?.engineVersion ?? null,
    };

    if (tokenProbe.status === 401) {
      return base("ai_ocr", label, {
        status: "error",
        reachable: true,
        latency_ms: ms,
        message:
          "O serviço recusou o token: AI_LOCAL_TOKEN tem de ser o mesmo AI_TOKEN do trajetto-ai.",
        details,
      });
    }

    return base("ai_ocr", label, {
      reachable: true,
      latency_ms: ms,
      message: "Serviço pronto e token aceito.",
      details,
    });
  } catch (error) {
    // /health answered, so the route exists: what failed is the token check.
    return base("ai_ocr", label, {
      status: "error",
      reachable: true,
      latency_ms: ms,
      message:
        failureKind(error) === "timeout"
          ? `O serviço em ${host} respondeu /health, mas a conferência do token não respondeu em ${timeoutMs / 1000}s.`
          : `O serviço em ${host} respondeu /health, mas a conferência do token falhou (${networkCode(error)}).`,
    });
  }
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
      storageClient ??= new S3Client({
        credentials: {
          accessKeyId: uploadConfig.r2.accessKeyId,
          secretAccessKey: uploadConfig.r2.secretAccessKey,
        },
        endpoint: uploadConfig.r2.endpoint,
        forcePathStyle: uploadConfig.r2.forcePathStyle,
        region: "auto",
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
 * Probes are cached per replica for this long, and concurrent readers share
 * one probe: refreshing the screen must not turn into calls to Meta.
 */
const READINESS_CACHE_MS = 30 * 1000;

let cached: { at: number; report: ProviderReadinessReport } | null = null;
let inFlight: Promise<ProviderReadinessReport> | null = null;

async function readProviderReadiness(
  { refresh = false }: { refresh?: boolean } = {},
  deps: () => ReadinessDeps = productionDeps,
): Promise<ProviderReadinessReport & { cached: boolean }> {
  if (!refresh && cached && Date.now() - cached.at < READINESS_CACHE_MS) {
    return { ...cached.report, cached: true };
  }

  inFlight ??= checkProviders(deps()).finally(() => {
    inFlight = null;
  });

  const report = await inFlight;

  cached = { at: Date.now(), report };

  return { ...report, cached: false };
}

/** For tests: forget the cached report. */
function resetProviderReadinessCache(): void {
  cached = null;
  inFlight = null;
}

export {
  READINESS_CACHE_MS,
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
  ProviderKey,
  ProviderReadiness,
  ProviderReadinessReport,
  ReadinessDeps,
  ReadinessEnv,
  ReadinessStatus,
};

#!/usr/bin/env node
/**
 * Deploys one Dokploy Application (provider Docker, image from GHCR) and
 * waits for the outcome.
 *
 * Every service runs as its own Dokploy Application pointed at a GHCR tag
 * (`:staging` or `:stable`): the API and the AI OCR service here, the web in
 * trajetto-ui, which keeps an identical copy of this file (a test there
 * compares them). Database backups are Dokploy's own Database backups, not an
 * Application deployed here. Dokploy runs each one as a Swarm service behind
 * its Traefik, which is why the stack is not a Compose app (docs/deploy.md).
 * deploy.yml calls this script once per Application.
 *
 * What `done` means: Dokploy pulled the Application's tag again and updated
 * the Swarm service, and the manager ACCEPTED the new spec. The rollout
 * itself happens after that, and an image that fails its healthcheck is
 * rolled back by Swarm with the old one still serving. A green run of this
 * script is therefore NOT a converged service: deploy.yml follows the API
 * deploy with a convergence check (by default, wait-for-version.mjs polling
 * the public /health/liveness for the new commit; or
 * infra/scripts/verify-rollout.sh over SSH).
 *
 * What it does catch, unlike a bare webhook (a 2xx the moment the redeploy
 * was queued): a deploy Dokploy could not run at all — an image it cannot
 * pull, a wrong key or application id. It follows the deployment Dokploy
 * created for THIS call and fails when that one fails.
 *
 * A deployment that ends in `error` is triggered again, up to
 * DOKPLOY_ATTEMPTS times: the failure seen in practice is the image pull
 * from GHCR dying midway ("connection reset by peer" on the VPS's IPv6
 * route, 27/10/2026), which a later pull gets through. The pauses double
 * (20, 40, 80, 160, 160 s by default): run 40551925038 failed 3/3 with a
 * fixed 20 s, which retried inside the same bad minute of that route. Docker
 * keeps the layers a broken pull finished, so each attempt only fetches what
 * is left. A wrong image or registry login fails every attempt the same
 * way, so the run still fails — with Dokploy's own reason in the log. A
 * `cancelled` deployment was stopped by a person and is not retried.
 *
 * No retry is silent: each one is a ::warning:: with its count (a request to
 * Dokploy tried again, a status check that failed, a deployment triggered
 * again), and the job summary lists every failed attempt with Dokploy's
 * reason — a green run that needed three pulls says so, and a pull route
 * that went bad again shows up before it fails a deploy.
 *
 * Environment:
 *   DOKPLOY_URL                https base URL of the Dokploy panel
 *   DOKPLOY_API_KEY            API key (Dokploy > Settings > Profile > API/CLI)
 *   DOKPLOY_APPLICATION_ID     the Application to deploy (from its URL in the panel)
 *   DOKPLOY_APP_LABEL          the service's name in messages (default "a Application")
 *   DOKPLOY_OPTIONAL           `true`: no application id is a notice, not an error
 *                              (the AI Application may not exist yet)
 *   DOKPLOY_WAIT               `false` only triggers, without following (default true)
 *   DOKPLOY_TIMEOUT_SECONDS    how long to follow each attempt (default 900)
 *   DOKPLOY_POLL_SECONDS       interval between checks (default 10)
 *   DOKPLOY_ATTEMPTS           deploys tried while they end in error (default 6)
 *   DOKPLOY_RETRY_SECONDS      first pause before deploying again (default 20),
 *                              doubled after each failed attempt
 *   DOKPLOY_RETRY_MAX_SECONDS  ceiling of that pause (default 160)
 *
 * The key is sent only as the `x-api-key` header and never printed, and is
 * blanked out of any text Dokploy sends back before it is logged.
 */
import { appendFileSync } from "node:fs";

const env = process.env;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function summary(line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function baseUrl(raw) {
  let url;

  try {
    url = new URL(raw);
  } catch {
    fail("DOKPLOY_URL não é uma URL válida.");
  }

  // The API key travels in a header: plain http only to the loopback, where
  // the tests run a fake Dokploy.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("DOKPLOY_URL precisa ser https:// (a chave de API vai no cabeçalho).");
  }

  return url.origin + url.pathname.replace(/\/+$/, "");
}

const LABEL = env.DOKPLOY_APP_LABEL || "a Application";

// An optional Application not created yet: say so and leave the run green.
if (!env.DOKPLOY_APPLICATION_ID && env.DOKPLOY_OPTIONAL === "true") {
  summary(
    `Dokploy: deploy de ${LABEL} pulado (o id da Application não está no environment).`,
  );
  console.log(
    `::notice::Deploy de ${LABEL} pulado: o id da Application não está definido no environment do GitHub (docs/deploy.md).`,
  );
  process.exit(0);
}

const missing = [
  "DOKPLOY_URL",
  "DOKPLOY_API_KEY",
  "DOKPLOY_APPLICATION_ID",
].filter((name) => !env[name]);

if (missing.length > 0)
  fail(`Defina ${missing.join(", ")} no environment do GitHub.`);

if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.DOKPLOY_APPLICATION_ID)) {
  fail(
    "DOKPLOY_APPLICATION_ID tem formato inesperado (copie o id da URL da Application no Dokploy).",
  );
}

const BASE = baseUrl(env.DOKPLOY_URL);
const APPLICATION_ID = env.DOKPLOY_APPLICATION_ID;
const WAIT = env.DOKPLOY_WAIT !== "false";
const TIMEOUT_MS = Number(env.DOKPLOY_TIMEOUT_SECONDS || 900) * 1000;
const POLL_MS = Number(env.DOKPLOY_POLL_SECONDS || 10) * 1000;
const ATTEMPTS = Math.max(1, Math.floor(Number(env.DOKPLOY_ATTEMPTS || 6)));
const RETRY_MS = Math.max(0, Number(env.DOKPLOY_RETRY_SECONDS ?? 20) * 1000);
const RETRY_MAX_MS = Math.max(
  RETRY_MS,
  Number(env.DOKPLOY_RETRY_MAX_SECONDS ?? 160) * 1000,
);

/** The pause after failed attempt `number` (1-based): doubling, capped. */
const retryDelay = (number) =>
  Math.min(RETRY_MS * 2 ** (number - 1), RETRY_MAX_MS);

/**
 * Why Dokploy says a deployment failed, fit for a public log: one line, at
 * most 500 characters, the API key and any credentials in a URL blanked out.
 * Dokploy records the error of a failed deploy on the deployment itself
 * (`errorMessage`); older versions leave it empty, and the reason is then
 * only in the deployment's log in the panel.
 */
function reasonOf(deployment) {
  const raw = [
    deployment?.errorMessage,
    deployment?.error,
    deployment?.message,
  ].find((value) => typeof value === "string" && value.trim() !== "");

  return raw ? redact(raw) : null;
}

/** Any text from Dokploy or the network, fit for a public log. */
function redact(raw) {
  let text = String(raw).replace(/\s+/g, " ").trim();

  if (env.DOKPLOY_API_KEY) text = text.split(env.DOKPLOY_API_KEY).join("***");

  text = text
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1***@")
    .replace(
      /\b(password|passwd|token|secret|api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
      "$1$2***",
    );

  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const said = (deployment) => {
  const reason = reasonOf(deployment);

  return reason
    ? ` Motivo informado pelo Dokploy: ${reason}`
    : " O Dokploy não informou o motivo; o log está no painel, em Deployments da Application.";
};

const headers = {
  "x-api-key": env.DOKPLOY_API_KEY,
  accept: "application/json",
  "content-type": "application/json",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds for a message: whole in production, exact in the tests' 0.01 s. */
const seconds = (ms) => Number((ms / 1000).toFixed(2));

/**
 * A request, retried on network errors and 5xx (as `curl --retry 3` was),
 * each retry a ::warning:: with its count.
 */
async function call(method, path, body) {
  const route = `${method} ${path.split("?")[0]}`;
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      const text = await response.text();

      if (response.ok) return text ? JSON.parse(text) : null;

      last = redact(`HTTP ${response.status}: ${text.slice(0, 300)}`);

      // A 4xx will not change on retry: wrong key, wrong id, wrong URL.
      if (response.status < 500) break;
    } catch (error) {
      last = redact(error instanceof Error ? error.message : String(error));
    }

    if (attempt < 3) {
      const pause = Math.min(POLL_MS, 2_000) * attempt;

      console.log(
        `::warning::Dokploy: ${route} falhou (${last}); tentativa ${attempt + 1} de 3 em ${seconds(pause)}s.`,
      );
      await sleep(pause);
    }
  }

  throw new Error(last);
}

/** Every failed attempt of this deploy, for the summary. */
const failures = [];

function summarizeFailures() {
  for (const { number, deploymentId, reason } of failures) {
    summary(
      `Dokploy: ${LABEL}, tentativa ${number} de ${ATTEMPTS} terminou em 'error' (deployment ${deploymentId}). ${reason ? `Motivo informado pelo Dokploy: ${reason}` : "O Dokploy não informou o motivo."}`,
    );
  }
}

async function deployments() {
  const list = await call(
    "GET",
    `/api/deployment.all?applicationId=${encodeURIComponent(APPLICATION_ID)}`,
  );

  if (!Array.isArray(list)) {
    throw new Error("resposta inesperada de deployment.all (não é uma lista)");
  }

  return list;
}

/**
 * Triggers one deploy and follows the deployment it creates. Returns
 * "done" or "error"; any other outcome fails the run here.
 */
async function attempt(number) {
  // The deployments that already exist: the one this call creates is the one
  // that is NOT here. Comparing clocks with the server would race, and taking
  // "the latest" would read the previous deploy's `done` (or a failed
  // attempt's `error`) as this one's.
  let before = null;

  if (WAIT) {
    try {
      before = new Set((await deployments()).map((item) => item.deploymentId));
    } catch (error) {
      fail(
        `Não foi possível ler os deployments de ${LABEL} no Dokploy: ${error.message}`,
      );
    }
  }

  try {
    await call("POST", "/api/application.deploy", {
      applicationId: APPLICATION_ID,
    });
  } catch (error) {
    fail(`O Dokploy recusou o deploy de ${LABEL}: ${error.message}`);
  }

  if (!WAIT) {
    console.log(
      "::warning::Deploy disparado no Dokploy sem acompanhar o resultado (DOKPLOY_WAIT=false). Confira no painel.",
    );
    return "done";
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let current = null;
  let checksFailed = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    let list;

    try {
      list = await deployments();
    } catch (error) {
      checksFailed += 1;
      console.log(
        `::warning::Falha ao consultar o Dokploy (${redact(error.message)}); consulta ${checksFailed} que falhou nesta tentativa, tentando de novo.`,
      );
      continue;
    }

    current = list.find((item) => !before.has(item.deploymentId)) ?? null;

    if (!current) continue;

    if (current.status === "done") {
      summarizeFailures();
      summary(
        `Dokploy: deployment ${current.deploymentId} de ${LABEL} concluído${number > 1 ? ` na tentativa ${number} de ${ATTEMPTS}` : ""} (spec aceita pelo Swarm).`,
      );
      return "done";
    }

    if (current.status === "cancelled") {
      summarizeFailures();
      fail(
        `O deployment ${current.deploymentId} de ${LABEL} terminou em 'cancelled' no Dokploy (cancelado no painel; não é repetido).`,
      );
    }

    if (current.status === "error") {
      failures.push({
        number,
        deploymentId: current.deploymentId,
        reason: reasonOf(current),
      });

      if (number < ATTEMPTS) {
        console.log(
          `::warning::O deployment ${current.deploymentId} de ${LABEL} terminou em 'error' no Dokploy (o motivo comum é o download da imagem cair no meio). Disparando de novo em ${seconds(retryDelay(number))}s: tentativa ${number + 1} de ${ATTEMPTS}.${said(current)}`,
        );
        return "error";
      }

      summarizeFailures();
      fail(
        `O deployment ${current.deploymentId} de ${LABEL} terminou em 'error' no Dokploy, depois de ${ATTEMPTS} tentativas.${said(current)}`,
      );
    }
  }

  summarizeFailures();

  fail(
    current
      ? `O deployment ${current.deploymentId} ainda estava '${current.status}' após ${TIMEOUT_MS / 1000}s. Acompanhe no painel do Dokploy.`
      : `O Dokploy não criou o deployment em ${TIMEOUT_MS / 1000}s. Confira a fila no painel.`,
  );
}

async function main() {
  for (let number = 1; number <= ATTEMPTS; number += 1) {
    if ((await attempt(number)) === "done") return;
    await sleep(retryDelay(number));
  }
}

await main();

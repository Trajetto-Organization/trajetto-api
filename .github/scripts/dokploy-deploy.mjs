#!/usr/bin/env node
/**
 * Deploys one Dokploy Application (provider Docker, image from GHCR) and
 * waits for the outcome.
 *
 * Every service runs as its own Dokploy Application pointed at a GHCR tag
 * (`:staging` or `:stable`): the API and the AI OCR service. Database backups
 * are Dokploy's own Database backups, not an Application deployed here.
 * Dokploy runs each one as a Swarm service behind its Traefik, which is why
 * the stack is not a Compose app (docs/deploy.md). deploy.yml calls this
 * script once per Application: AI first, then the API.
 *
 * What `done` means: Dokploy pulled the Application's tag again and updated
 * the Swarm service, and the manager ACCEPTED the new spec. The rollout
 * itself happens after that, and an image that fails its healthcheck is
 * rolled back by Swarm with the old one still serving. A green run of this
 * script is therefore NOT a converged service: deploy.yml follows the API
 * deploy with the convergence check (infra/scripts/verify-rollout.sh over SSH).
 *
 * What it does catch, unlike a bare webhook (a 2xx the moment the redeploy
 * was queued): a deploy Dokploy could not run at all — an image it cannot
 * pull, a wrong key or application id. It follows the deployment Dokploy
 * created for THIS call and fails when that one fails.
 *
 * Environment:
 *   DOKPLOY_URL              https base URL of the Dokploy panel
 *   DOKPLOY_API_KEY          API key (Dokploy > Settings > Profile > API/CLI)
 *   DOKPLOY_APPLICATION_ID   the Application to deploy (from its URL in the panel)
 *   DOKPLOY_APP_LABEL        the service's name in messages (default "a Application")
 *   DOKPLOY_OPTIONAL         `true`: no application id is a notice, not an error
 *                            (the AI Application may not exist yet)
 *   DOKPLOY_WAIT             `false` only triggers, without following (default true)
 *   DOKPLOY_TIMEOUT_SECONDS  how long to follow the deployment (default 900)
 *   DOKPLOY_POLL_SECONDS     interval between checks (default 10)
 *
 * The key is sent only as the `x-api-key` header and never printed.
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

const headers = {
  "x-api-key": env.DOKPLOY_API_KEY,
  accept: "application/json",
  "content-type": "application/json",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request, retried on network errors and 5xx (as `curl --retry 3` was). */
async function call(method, path, body) {
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

      last = `HTTP ${response.status}: ${text.slice(0, 300)}`;

      // A 4xx will not change on retry: wrong key, wrong id, wrong URL.
      if (response.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 3) await sleep(Math.min(POLL_MS, 2_000) * attempt);
  }

  throw new Error(last);
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

async function main() {
  // The deployments that already exist: the one this call creates is the one
  // that is NOT here. Comparing clocks with the server would race, and taking
  // "the latest" would read the previous deploy's `done` as this one's.
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
    return;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let current = null;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    let list;

    try {
      list = await deployments();
    } catch (error) {
      console.log(
        `::warning::Falha ao consultar o Dokploy (${error.message}); tentando de novo.`,
      );
      continue;
    }

    current = list.find((item) => !before.has(item.deploymentId)) ?? null;

    if (!current) continue;

    if (current.status === "done") {
      summary(
        `Dokploy: deployment ${current.deploymentId} de ${LABEL} concluído (spec aceita pelo Swarm; a convergência da API é conferida depois).`,
      );
      return;
    }

    if (current.status === "error" || current.status === "cancelled") {
      fail(
        `O deployment ${current.deploymentId} de ${LABEL} terminou em '${current.status}' no Dokploy. O log está no painel, em Deployments da Application.`,
      );
    }
  }

  fail(
    current
      ? `O deployment ${current.deploymentId} ainda estava '${current.status}' após ${TIMEOUT_MS / 1000}s. Acompanhe no painel do Dokploy.`
      : `O Dokploy não criou o deployment em ${TIMEOUT_MS / 1000}s. Confira a fila no painel.`,
  );
}

await main();

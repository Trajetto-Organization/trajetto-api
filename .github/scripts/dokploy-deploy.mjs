#!/usr/bin/env node
/**
 * Deploys a Dokploy compose app (Stack mode) and waits for the outcome.
 *
 * Used by trajetto-api only: the API is a Dokploy compose app (Docker Stack)
 * with several services, while the web deploys as a Dokploy Application
 * through its own webhook script (trajetto-ui/.github/scripts/).
 *
 * What `done` means: Dokploy ran `docker stack deploy` and the manager
 * ACCEPTED the new service specs. Dokploy runs it detached, so the rollout
 * itself happens after this script returns, and an image that fails its
 * healthcheck is rolled back by Swarm with the old one still serving. A green
 * run of this script is therefore NOT a converged stack: deploy.yml follows
 * it with the convergence check (infra/scripts/verify-rollout.sh over SSH).
 *
 * What it does catch, unlike the Portainer webhook it replaces (a 204 the
 * moment the redeploy was queued): a deploy Dokploy could not run at all — a
 * compose that does not render, a required variable missing, a registry it
 * cannot reach, a wrong key or app id. It follows the deployment Dokploy
 * created for THIS call and fails when that one fails.
 *
 * Environment:
 *   DOKPLOY_URL              https base URL of the Dokploy panel
 *   DOKPLOY_API_KEY          API key (Dokploy > Settings > Profile > API/CLI)
 *   DOKPLOY_COMPOSE_ID       the compose app (production or staging) to deploy
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
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
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

const missing = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_COMPOSE_ID"].filter(
  (name) => !env[name],
);

if (missing.length > 0) fail(`Defina ${missing.join(", ")} no environment do GitHub.`);

if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.DOKPLOY_COMPOSE_ID)) {
  fail("DOKPLOY_COMPOSE_ID tem formato inesperado (copie o id da URL do app no Dokploy).");
}

const BASE = baseUrl(env.DOKPLOY_URL);
const COMPOSE_ID = env.DOKPLOY_COMPOSE_ID;
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
    `/api/deployment.allByCompose?composeId=${encodeURIComponent(COMPOSE_ID)}`,
  );

  if (!Array.isArray(list)) {
    throw new Error("resposta inesperada de deployment.allByCompose (não é uma lista)");
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
      fail(`Não foi possível ler os deployments do app no Dokploy: ${error.message}`);
    }
  }

  try {
    await call("POST", "/api/compose.deploy", { composeId: COMPOSE_ID });
  } catch (error) {
    fail(`O Dokploy recusou o deploy: ${error.message}`);
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
      console.log(`::warning::Falha ao consultar o Dokploy (${error.message}); tentando de novo.`);
      continue;
    }

    current = list.find((item) => !before.has(item.deploymentId)) ?? null;

    if (!current) continue;

    if (current.status === "done") {
      summary(
        `Dokploy: deployment ${current.deploymentId} concluído (specs aceitas pelo Swarm; a convergência é conferida no passo seguinte).`,
      );
      return;
    }

    if (current.status === "error" || current.status === "cancelled") {
      fail(
        `O deployment ${current.deploymentId} terminou em '${current.status}' no Dokploy. O log está no painel, em Deployments do app.`,
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

#!/usr/bin/env node
/**
 * Waits until the public API serves the build a deploy shipped, and fails
 * when it does not.
 *
 * The Dokploy step (.github/scripts/dokploy-deploy.mjs) only proves the
 * deploy was ACCEPTED: the rollout runs afterwards, and a build that fails
 * its healthcheck is rolled back by Swarm (failure_action: rollback) with
 * the old one still serving — a green run with nothing shipped. The image
 * carries its commit (Dockerfile: GIT_SHA → APP_COMMIT_SHA) and
 * GET /health/liveness answers it, anonymously and without touching any
 * dependency, so this polls it through the real edge (Cloudflare, Traefik)
 * until it has answered the expected commit for a whole window longer than
 * Swarm's rollback monitor. Each request lands on any replica, so an old
 * replica still answering inside the window resets it: a pass means every
 * replica the edge reaches runs the new build. No SSH, no key on the host:
 * the same check as the web's wait-for-build.mjs (trajetto-ui), against
 * the API's probe.
 *
 * What it does not see: the AI service (no public address, docs/deploy.md,
 * "Conferir a convergência"), and a replica the edge never routes to.
 * infra/scripts/verify-rollout.sh over SSH (ROLLOUT_VERIFY=ssh) reads the
 * Swarm tasks themselves.
 *
 * Environment:
 *   API_URL               public origin of the API (vars.API_PUBLIC_URL)
 *   EXPECTED_SHA          commit the shipped image was built from (7-40 hex)
 *   WAIT_TIMEOUT_SECONDS  how long to wait in total (default 600)
 *   WAIT_POLL_SECONDS     interval between requests (default 5)
 *   WAIT_STABLE_SECONDS   how long the answer must hold (default 90)
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

const missing = ["API_URL", "EXPECTED_SHA"].filter((name) => !env[name]);

if (missing.length > 0) fail(`Defina ${missing.join(", ")}.`);

let api;

try {
  api = new URL(env.API_URL);
} catch {
  fail("API_URL não é uma URL válida.");
}

if (api.protocol !== "https:" && api.protocol !== "http:") {
  fail("API_URL precisa ser http(s)://.");
}

const EXPECTED = env.EXPECTED_SHA.trim().toLowerCase();

if (!/^[0-9a-f]{7,40}$/.test(EXPECTED)) {
  fail(
    "EXPECTED_SHA precisa ser o sha do commit (7 a 40 caracteres hexadecimais).",
  );
}

const ENDPOINT = `${api.origin}/health/liveness`;
const TIMEOUT_MS = Number(env.WAIT_TIMEOUT_SECONDS || 600) * 1000;
const POLL_MS = Number(env.WAIT_POLL_SECONDS || 5) * 1000;
const STABLE_MS = Number(env.WAIT_STABLE_SECONDS || 90) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A short sha is a prefix of the full one the build carries, and the other
// way round (a promote knows only the 7 characters of `sha-<7>`).
const isExpected = (sha) =>
  typeof sha === "string" &&
  (sha === EXPECTED ||
    (EXPECTED.length < 40 && sha.startsWith(EXPECTED)) ||
    (sha.length < EXPECTED.length && EXPECTED.startsWith(sha)));

let attempt = 0;

/** What the API answers now: the commit, or why there is none. */
async function probe() {
  attempt += 1;

  try {
    // A fresh query per request and no-cache: no cache between here and the
    // server may answer for it.
    const response = await fetch(`${ENDPOINT}?t=${Date.now()}-${attempt}`, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return { sha: null, answer: `HTTP ${response.status}` };

    const body = await response.json();
    const sha =
      typeof body?.commit === "string" && body.commit
        ? body.commit.toLowerCase()
        : null;

    return {
      sha,
      answer: sha
        ? `commit ${sha}`
        : "sem commit (build anterior à versão na liveness, ou sem GIT_SHA)",
    };
  } catch (error) {
    return {
      sha: null,
      answer: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  let since = null;
  let last = "";

  for (;;) {
    const { sha, answer } = await probe();
    const now = Date.now();

    if (isExpected(sha)) {
      since ??= now;

      if (now - since >= STABLE_MS) {
        summary(
          `API: ${ENDPOINT} responde ${EXPECTED} há ${Math.round((now - since) / 1000)}s.`,
        );
        return;
      }
    } else {
      if (since !== null) {
        console.log(
          `::warning::A API voltou a responder ${answer} depois de servir ${EXPECTED} (rollback do Swarm, ou uma réplica antiga ainda no ar?).`,
        );
      }

      since = null;
    }

    if (answer !== last) {
      console.log(`[wait-for-version] ${answer}`);
      last = answer;
    }

    if (now >= deadline) {
      fail(
        since === null
          ? `A API não responde ${EXPECTED} em ${ENDPOINT} após ${TIMEOUT_MS / 1000}s (responde: ${answer}). O Swarm pode ter revertido o deploy: no host, 'docker service ps --no-trunc <App Name da API>'.`
          : `A API responde ${EXPECTED} há só ${Math.round((now - since) / 1000)}s, menos que a janela de ${STABLE_MS / 1000}s, ao fim de ${TIMEOUT_MS / 1000}s.`,
      );
    }

    await sleep(POLL_MS);
  }
}

await main();

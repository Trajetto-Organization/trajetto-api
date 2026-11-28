#!/usr/bin/env node
/**
 * Which release steps the environment left pending (plano-escala U-11): the
 * deploy action's "Decide migrations" runs the release step again when this
 * lists any, even with the release image the database already applied.
 *
 * Reads GET <API_URL>/health/rollout with the environment's
 * ROLLOUT_STATUS_TOKEN (the same value as in the trajetto-api Application)
 * and prints the pending and failed steps on stdout, comma-separated, or
 * nothing when there are none. Exit 1, with a reason on stderr, when it
 * cannot tell: no URL, the API not answering, a 404 (an API from before
 * U-11, or a token that differs from the API's) — the caller then keeps
 * today's rule (only a new image runs the step), with a warning.
 *
 * It reads the API that is serving NOW, before this deploy: the state the
 * last release step left. Never prints the token or the answer's body.
 *
 * Environment:
 *   API_URL                 the environment's public API origin (vars.API_PUBLIC_URL)
 *   ROLLOUT_STATUS_TOKEN    the environment's secret
 *   ROLLOUT_TIMEOUT_SECONDS per request (default 15)
 */
const env = process.env;

function stop(reason) {
  console.error(reason);
  process.exit(1);
}

const token = env.ROLLOUT_STATUS_TOKEN ?? "";

if (!token) stop("ROLLOUT_STATUS_TOKEN vazio.");

let url;

try {
  url = new URL("/health/rollout", env.API_URL);
} catch {
  stop(
    "API_PUBLIC_URL do environment está vazia ou não é uma URL: sem ela o deploy não lê os passos pendentes.",
  );
}

// The token travels in a header: plain http only to the loopback (tests).
const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";

if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
  stop("API_PUBLIC_URL precisa ser https:// (o token vai no cabeçalho).");
}

const TIMEOUT_MS = Number(env.ROLLOUT_TIMEOUT_SECONDS || 15) * 1000;

async function read() {
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.status === 404) {
        stop(
          `${url.origin}/health/rollout respondeu 404: a API ainda não tem a rota (build anterior), ou o ROLLOUT_STATUS_TOKEN do GitHub não é o mesmo da trajetto-api.`,
        );
      }

      if (response.ok) return await response.json();

      last = `HTTP ${response.status}`;

      // A 4xx will not change on retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      last = error instanceof Error ? error.name : String(error);
    }

    if (attempt < 3) {
      await new Promise((done) => setTimeout(done, attempt * 2_000));
    }
  }

  stop(`${url.origin}/health/rollout não respondeu (${last}).`);
}

const answer = await read();
const pending = answer?.release?.pending;

if (!Array.isArray(pending)) {
  stop(`${url.origin}/health/rollout respondeu sem release.pending.`);
}

const steps = pending
  .map((item) => String(item?.step ?? ""))
  .filter((step) => /^[\w./@-]{1,200}$/.test(step));

process.stdout.write(steps.join(", "));

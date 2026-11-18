#!/usr/bin/env node
/**
 * Waits until every role of the environment runs the deployed build, and
 * fails when it does not (plano-escala F3-31b, D22).
 *
 * With the same image running as several Applications (the worker, later
 * the scheduler, the worker-external, the realtime and the ingest), the
 * API's liveness proves only the API. A worker whose new task failed its
 * healthcheck is rolled back by Swarm, the old one keeps claiming the
 * queues on the old build, and the run was green. Every process writes its
 * row in process_heartbeat (F3-03), and GET /health/rollout answers them
 * counted (src/shared/health/rollout-status.ts). This polls it, with the
 * environment's ROLLOUT_STATUS_TOKEN, until for a whole window:
 *
 *  - every role in ROLLOUT_ROLES_EXPECTED has a live process on the
 *    expected commit. The role `all` (one process doing everything, today's
 *    production) covers api, worker and scheduler, on either side: expected
 *    `all` needs the three covered, and a process in `all` covers
 *    `api,worker` (D22: production expects `all` until its worker exists);
 *  - no live process of this environment runs another commit;
 *  - every queue the build knows has a consumer, and some process runs the
 *    cron, counted over the union of the processes on the expected commit;
 *  - every live process shares one configuration fingerprint (secrets,
 *    environment, database and Redis identities, never the values): two
 *    Environments that drifted apart, or a process of the other environment
 *    pointed at this database, never converge.
 *
 * A build that predates the roles (its answer has no `roles`: a rollback to
 * an older build) is skipped with a notice once the API answers the
 * expected commit; one that predates the route, or a token that is not the
 * API's (the same 404, by design), is skipped with a warning after three
 * 404s in a row. Without the token or without ROLLOUT_ROLES_EXPECTED, the
 * check does not run, and the run is today's.
 *
 * WAIT_ROLES_SCOPE=roles is the same wait for only the roles a deploy has
 * just shipped, before the API's turn (deploy-roles.sh verify, without
 * SSH): the API still runs the previous build and answers for them, so only
 * the listed roles are judged — each has a live process on the expected
 * commit and none on another, the role taken as written (`all` is the API
 * of before, never a worker) — and an API too old to list the processes
 * makes it step aside with a notice, whatever commit it answers.
 *
 * Environment:
 *   API_URL                 the environment's public API origin (vars.API_PUBLIC_URL)
 *   ROLLOUT_STATUS_TOKEN    the environment's secret (the same as the API's)
 *   ROLLOUT_ROLES_EXPECTED  vars.ROLLOUT_ROLES_EXPECTED, e.g. `all` or `api,worker`
 *   WAIT_ROLES_SCOPE        `environment` (default) or `roles` (above)
 *   EXPECTED_SHA            the commit the deployed image was built from (7-40 hex)
 *   WAIT_TIMEOUT_SECONDS    how long to wait in total (default 600, at most 600)
 *   WAIT_POLL_SECONDS       interval between requests (default 5)
 *   WAIT_STABLE_SECONDS     how long it must hold (default 90)
 */
import { appendFileSync } from "node:fs";

const env = process.env;

const ROLES = [
  "all",
  "api",
  "worker",
  "scheduler",
  "realtime",
  "worker-external",
  "ingest",
];

/** What a process in each role does, for the expectation. */
const COVERS = {
  all: ["api", "worker", "scheduler"],
};

const covers = (role) => COVERS[role] ?? [role];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function summary(line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function skip(level, message) {
  console.log(`::${level}::${message}`);
  summary(`Papéis: ${message}`);
  process.exit(0);
}

const token = env.ROLLOUT_STATUS_TOKEN ?? "";
const expectedRaw = (env.ROLLOUT_ROLES_EXPECTED ?? "").trim();

if (!token) {
  skip(
    "notice",
    "sem o secret ROLLOUT_STATUS_TOKEN, a conferência por papel não roda (docs/deploy.md, seção 14).",
  );
}

if (!expectedRaw) {
  skip(
    "notice",
    "sem a variável ROLLOUT_ROLES_EXPECTED no environment, a conferência por papel não roda (docs/deploy.md, seção 14).",
  );
}

const expectedRoles = expectedRaw
  .split(",")
  .map((role) => role.trim().toLowerCase())
  .filter(Boolean);

const unknownRoles = expectedRoles.filter((role) => !ROLES.includes(role));

if (expectedRoles.length === 0 || unknownRoles.length > 0) {
  fail(
    `ROLLOUT_ROLES_EXPECTED='${expectedRaw.slice(0, 200)}' tem papel desconhecido (${unknownRoles.join(", ") || "nenhum papel"}): use uma lista separada por vírgula de ${ROLES.join(", ")}.`,
  );
}

const scopeRaw = (env.WAIT_ROLES_SCOPE ?? "").trim().toLowerCase();

if (scopeRaw !== "" && scopeRaw !== "environment" && scopeRaw !== "roles") {
  fail(
    `WAIT_ROLES_SCOPE='${scopeRaw.slice(0, 40)}' precisa ser environment ou roles.`,
  );
}

/** Only the listed roles, before the API's deploy (see the top). */
const ROLES_ONLY = scopeRaw === "roles";

/** Every role that must have a live process, `all` expanded. */
const NEEDED = ROLES_ONLY
  ? [...new Set(expectedRoles)]
  : [...new Set(expectedRoles.flatMap(covers))];

let url;

try {
  url = new URL("/health/rollout", env.API_URL);
} catch {
  fail(
    "API_PUBLIC_URL do environment está vazia ou não é uma URL: sem ela a conferência por papel não lê /health/rollout.",
  );
}

// The token travels in a header: plain http only to the loopback (tests).
const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";

if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
  fail("API_PUBLIC_URL precisa ser https:// (o token vai no cabeçalho).");
}

const EXPECTED = (env.EXPECTED_SHA ?? "").trim().toLowerCase();

if (!/^[0-9a-f]{7,40}$/.test(EXPECTED)) {
  fail(
    "EXPECTED_SHA precisa ser o sha do commit (7 a 40 caracteres hexadecimais).",
  );
}

const seconds = (name, fallback) => {
  const value = Number(env[name] || fallback);

  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const TIMEOUT_MS = Math.min(seconds("WAIT_TIMEOUT_SECONDS", 600), 600) * 1000;
const POLL_MS = seconds("WAIT_POLL_SECONDS", 5) * 1000;
const STABLE_MS = seconds("WAIT_STABLE_SECONDS", 90) * 1000;

/** 404s in a row before the route counts as absent. */
const ABSENT_AFTER = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A short sha is a prefix of the full one the build carries, and the other
// way round (a promote knows only the 7 characters of `sha-<7>`).
const isExpected = (sha) =>
  typeof sha === "string" &&
  (sha === EXPECTED ||
    (EXPECTED.length < 40 && sha.startsWith(EXPECTED)) ||
    (sha.length < EXPECTED.length && EXPECTED.startsWith(sha)));

/** The answer, or why there is none. Never prints the token or the body. */
async function probe() {
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "cache-control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) return { kind: "absent" };

    if (!response.ok) {
      return { kind: "none", reason: `HTTP ${response.status}` };
    }

    try {
      return { kind: "answer", body: await response.json() };
    } catch {
      return { kind: "none", reason: "corpo que não é JSON" };
    }
  } catch (error) {
    return {
      kind: "none",
      reason: error instanceof Error ? error.name : String(error),
    };
  }
}

const short = (sha) =>
  typeof sha === "string" ? sha.slice(0, 12) : "sem commit";

/**
 * What still keeps the listed roles from having converged, in the scope
 * `roles`: each with a live process of this environment on the expected
 * commit, and none on another. Nothing else is theirs to judge: the API and
 * the queues it may still consume are on the previous build by design.
 */
function pendingOfRoles(roles) {
  const live = Array.isArray(roles?.processes) ? roles.processes : [];
  const own = live.filter((group) => group.appEnv === roles.appEnv);
  const count = (groups) =>
    groups.reduce((total, group) => total + Number(group.count ?? 0), 0);
  const reasons = [];

  for (const role of NEEDED) {
    const groups = own.filter((group) => group.role === role);

    for (const group of groups.filter((one) => !isExpected(one.commit))) {
      reasons.push(
        `${count([group])} processo(s) ${role} ainda em ${short(group.commit)}`,
      );
    }

    if (!groups.some((group) => isExpected(group.commit))) {
      reasons.push(`nenhum processo vivo do papel ${role} no commit novo`);
    }
  }

  return reasons;
}

/**
 * What still keeps the environment from having converged, in pt-BR; an
 * empty list is converged.
 */
function pendingOf(roles) {
  if (ROLES_ONLY) return pendingOfRoles(roles);

  const live = Array.isArray(roles?.processes) ? roles.processes : [];
  const reasons = [];

  if (live.length === 0) {
    return ["nenhum processo vivo no process_heartbeat"];
  }

  const own = live.filter((group) => group.appEnv === roles.appEnv);
  const foreign = live.filter((group) => group.appEnv !== roles.appEnv);
  const current = own.filter((group) => isExpected(group.commit));
  const count = (groups) =>
    groups.reduce((total, group) => total + Number(group.count ?? 0), 0);

  for (const group of foreign) {
    reasons.push(
      `${count([group])} processo(s) ${group.role} de outro ambiente (APP_ENV=${group.appEnv}) neste banco`,
    );
  }

  const stale = own.filter((group) => !isExpected(group.commit));

  for (const group of stale) {
    reasons.push(
      `${count([group])} processo(s) ${group.role} ainda em ${short(group.commit)}`,
    );
  }

  for (const role of NEEDED) {
    if (!current.some((group) => covers(group.role).includes(role))) {
      reasons.push(`nenhum processo vivo cobre o papel ${role} no commit novo`);
    }
  }

  const known = Array.isArray(roles.queues) ? roles.queues : [];
  const consumed = new Set(current.flatMap((group) => group.queues ?? []));
  const orphans = known.filter((queue) => !consumed.has(queue));

  if (orphans.length > 0) {
    reasons.push(
      `fila(s) sem consumidor no commit novo: ${orphans.join(", ")}`,
    );
  }

  if (!current.some((group) => group.cron === true)) {
    reasons.push("nenhum processo no commit novo roda o cron");
  }

  const fingerprints = new Set(live.map((group) => group.fingerprint));

  if (fingerprints.has(null)) {
    reasons.push("processo ainda sem a impressão da configuração");
  }

  fingerprints.delete(null);

  if (fingerprints.size > 1) {
    reasons.push(
      `${fingerprints.size} impressões de configuração diferentes (os Environments das Applications divergem, ou um processo de outro ambiente usa este banco)`,
    );
  }

  return reasons;
}

/** One line of who runs what, for the log and the summary. */
function describe(roles) {
  const live = Array.isArray(roles?.processes) ? roles.processes : [];

  return live
    .map(
      (group) =>
        `${group.role}×${group.count} ${short(group.commit)}${group.appEnv === roles.appEnv ? "" : ` (${group.appEnv})`}`,
    )
    .join(", ");
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  let since = null;
  let absent = 0;
  let last = "";
  let lastPending = ["nenhuma resposta ainda"];

  for (;;) {
    const result = await probe();
    const now = Date.now();
    let line;

    if (result.kind === "absent") {
      absent += 1;
      since = null;
      line = `${url.origin}/health/rollout respondeu 404 (${absent} seguida(s))`;

      if (absent >= ABSENT_AFTER) {
        skip(
          "warning",
          `${url.origin}/health/rollout responde 404: o build no ar é anterior à rota, ou o ROLLOUT_STATUS_TOKEN do GitHub não é o mesmo da trajetto-api. A conferência por papel não rodou.`,
        );
      }
    } else {
      absent = 0;

      if (result.kind === "none") {
        // Says nothing about which build serves: neither starts nor resets
        // the window, as in wait-for-version.mjs.
        line = `sem resposta (${result.reason})`;
      } else {
        const body = result.body;

        if (body?.roles === undefined) {
          // Before the API's deploy, the API answering is the previous
          // build by design: one too old to list the processes has nothing
          // to say about the roles, whatever commit it answers.
          if (ROLES_ONLY) {
            skip(
              "notice",
              `a API no ar (${short(body?.commit)}) é anterior à conferência por papel: os papéis implantados antes dela não são conferidos neste run.`,
            );
          }

          if (isExpected(body?.commit)) {
            skip(
              "notice",
              `o build ${short(body.commit)} é anterior à conferência por papel (a resposta não traz os processos); nada a conferir.`,
            );
          }

          // An older replica still answering: the API's own check passed,
          // so the next answers are the new build's.
          since = null;
          line = `a API ainda responde ${short(body?.commit)} sem os processos`;
        } else if (body.roles === null) {
          since = null;
          lastPending = ["a API não leu o process_heartbeat"];
          line = "a API não leu o process_heartbeat";
        } else {
          const pending = pendingOf(body.roles);

          lastPending = pending.length > 0 ? pending : lastPending;
          line =
            pending.length === 0
              ? `convergido: ${describe(body.roles)}`
              : `${pending.join("; ")} [${describe(body.roles)}]`;

          if (pending.length === 0) {
            since ??= now;

            if (now - since >= STABLE_MS) {
              summary(
                `${ROLES_ONLY ? "Papéis antes da API" : "Papéis"}: ${expectedRoles.join(",")} em ${EXPECTED} há ${Math.round((now - since) / 1000)}s (${describe(body.roles)}).`,
              );
              return;
            }
          } else {
            if (since !== null) {
              console.log(
                `::warning::Os papéis deixaram de estar todos em ${EXPECTED}: ${pending.join("; ")}.`,
              );
            }

            since = null;
          }
        }
      }
    }

    if (line !== last) {
      console.log(`[wait-for-roles] ${line}`);
      last = line;
    }

    if (now >= deadline) {
      const stopped = ROLES_ONLY
        ? " A API não foi implantada: o ambiente segue nela, no build anterior."
        : "";

      fail(
        since === null
          ? `Os papéis de ${expectedRoles.join(",")} não convergiram para ${EXPECTED} em ${TIMEOUT_MS / 1000}s: ${lastPending.join("; ")}. Confira o log da Application de cada papel no Dokploy e 'docker service ps --no-trunc <App Name>' no host.${stopped}`
          : `Os papéis convergiram há só ${Math.round((now - since) / 1000)}s, menos que a janela de ${STABLE_MS / 1000}s, ao fim de ${TIMEOUT_MS / 1000}s.${stopped}`,
      );
    }

    await sleep(POLL_MS);
  }
}

await main();

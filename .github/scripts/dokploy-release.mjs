#!/usr/bin/env node
/**
 * Runs the release step — `prisma migrate deploy` plus the idempotent seeds —
 * on the Dokploy Application trajetto-api-migrate, and waits until it
 * FINISHED: applied, or failed. deploy.yml runs it before the API rolls out,
 * on staging and on the promote, only when the database has not applied
 * this release image yet.
 *
 * The Application runs the release image (Dockerfile, stage `migrate`) on
 * its `:staging` or `:stable` tag, like every other service, with the
 * database URL in its Environment — no credential lives in CI, and no SSH
 * key reaches the host. The image's command migrates, seeds, and then stays
 * idle; its HEALTHCHECK passes only once both finished (docker-entrypoint.sh,
 * mode `release`). So Swarm itself reports the outcome on the task:
 * `Starting` while it migrates, `Running` once it finished, `Failed` with the
 * exit code when a migration or a seed failed. (A Swarm job would report
 * `Complete`, but a job cannot carry an update config and Dokploy always
 * sends one: an Application in job mode never deploys. Measured.)
 *
 * Steps:
 *   1. application.one: the Application's appName, and that it is set up so
 *      the outcome can be trusted — the release image on the expected tag,
 *      Restart Policy `none` (Swarm's default, `any`, starts a failed
 *      migration over and over, and an update can cut one midway), no
 *      Health Check of its own (it would replace the image's, which is the
 *      signal), one replica, and no `stop-first` update order (it stops a
 *      migration still running when a second deploy arrives). Anything off
 *      fails here, before the database is touched, saying what to change.
 *   2. The service's tasks before the deploy: docker.getServiceContainersByAppName,
 *      the list behind the panel's Logs tab. Dokploy answers an empty list
 *      on any stderr from `docker service ps`, so an empty one is read three
 *      times and then believed only when the deployment history
 *      (deployment.all, the ten newest) shows no successful deploy and is
 *      not full: no Swarm service yet.
 *   3. dokploy-deploy.mjs: Dokploy pulls the tag again and updates the
 *      service, with that script's retries on a broken pull.
 *   4. The tasks again, every few seconds, until a task that was not there
 *      before is `Running` or `Complete` (finished) or `Failed`, `Rejected`
 *      or `Orphaned` (failed), or the timeout. Only NEW tasks count: under
 *      Dokploy's default update config (start-first, rollback) a failed
 *      release leaves the previous, idle task `Running`.
 *
 * What it cannot show is the migration's own output: Dokploy has no REST
 * endpoint for logs. A failure says so and points at the Application's
 * Logs tab, where Swarm keeps the failed task's log.
 *
 * Environment:
 *   DOKPLOY_URL               https base URL of the Dokploy panel
 *   DOKPLOY_API_KEY           API key (never printed)
 *   DOKPLOY_APPLICATION_ID    the release Application (from its URL in the panel)
 *   DOKPLOY_APP_LABEL         its name in messages (default trajetto-api-migrate)
 *   RELEASE_IMAGE             the image the Application must run, e.g.
 *                             ghcr.io/trajetto-organization/trajetto-api-migrate:staging
 *   RELEASE_TIMEOUT_SECONDS   how long to wait for the outcome (default 1800)
 *   RELEASE_POLL_SECONDS      interval between reads of the tasks (default 5)
 *   ...and the DOKPLOY_* knobs of dokploy-deploy.mjs, handed over to it.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const LABEL = env.DOKPLOY_APP_LABEL || "trajetto-api-migrate";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function summary(line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

const missing = [
  "DOKPLOY_URL",
  "DOKPLOY_API_KEY",
  "DOKPLOY_APPLICATION_ID",
  "RELEASE_IMAGE",
].filter((name) => !env[name]);

if (missing.length > 0)
  fail(
    `Defina ${missing.join(", ")} (a Application ${LABEL} no environment do GitHub: docs/deploy.md, "Migrations").`,
  );

if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.DOKPLOY_APPLICATION_ID)) {
  fail(
    `O id da Application ${LABEL} tem formato inesperado (copie o id da URL da Application no Dokploy).`,
  );
}

function baseUrl(raw) {
  let url;

  try {
    url = new URL(raw);
  } catch {
    fail("DOKPLOY_URL não é uma URL válida.");
  }

  // As in dokploy-deploy.mjs: the key travels in a header, so plain http
  // only to the loopback, where the tests run a fake Dokploy.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("DOKPLOY_URL precisa ser https:// (a chave de API vai no cabeçalho).");
  }

  return url.origin + url.pathname.replace(/\/+$/, "");
}

const BASE = baseUrl(env.DOKPLOY_URL);
const APPLICATION_ID = env.DOKPLOY_APPLICATION_ID;
const IMAGE = env.RELEASE_IMAGE.trim().toLowerCase();
const TIMEOUT_MS = Number(env.RELEASE_TIMEOUT_SECONDS || 1800) * 1000;
const POLL_MS = Number(env.RELEASE_POLL_SECONDS || 5) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any text from Dokploy or the network, fit for a public log. */
function redact(raw) {
  let text = String(raw).replace(/\s+/g, " ").trim();

  text = text.split(env.DOKPLOY_API_KEY).join("***");
  text = text
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1***@")
    .replace(
      /\b(password|passwd|token|secret|api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
      "$1$2***",
    );

  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * A GET, retried on network errors and 5xx, each retry a ::warning::. The
 * answer is never logged: application.one carries the Application's
 * Environment, the database URL included.
 */
async function get(path) {
  const route = path.split("?")[0];
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: {
          "x-api-key": env.DOKPLOY_API_KEY,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();

      if (response.ok) return text ? JSON.parse(text) : null;

      last = redact(`HTTP ${response.status}: ${text.slice(0, 200)}`);

      // A 4xx will not change on retry: wrong key, wrong id, wrong URL.
      if (response.status < 500) break;
    } catch (error) {
      last = redact(error instanceof Error ? error.message : String(error));
    }

    if (attempt < 3) {
      console.log(
        `::warning::Dokploy: GET ${route} falhou (${last}); tentativa ${attempt + 1} de 3.`,
      );
      await sleep(Math.min(POLL_MS, 2_000) * attempt);
    }
  }

  throw new Error(last);
}

const SWARM_SETTINGS = `No Dokploy: Application ${LABEL} → Advanced → Swarm Settings`;

/**
 * Why this Application cannot run the release step as deployed, or null.
 * Each answer says what to change in the panel (docs/deploy.md, "Migrations").
 */
function misconfiguration(app) {
  if (!/^[a-zA-Z0-9.\-_]+$/.test(String(app.appName ?? ""))) {
    return `o Dokploy não informou um appName válido para ${LABEL}.`;
  }

  const image = String(app.dockerImage ?? "")
    .trim()
    .toLowerCase();

  if (app.sourceType !== "docker" || image !== IMAGE) {
    return `a Application ${LABEL} precisa rodar a imagem ${IMAGE} (Provider: Docker). Hoje: ${app.sourceType === "docker" ? image || "sem imagem" : `provider ${app.sourceType}`}. Confira se o id em DOKPLOY_MIGRATE_APPLICATION_ID é o da Application de migração deste ambiente.`;
  }

  if (app.restartPolicySwarm?.Condition !== "none") {
    return `${SWARM_SETTINGS} → Restart Policy precisa ser {"Condition":"none"} (hoje: ${JSON.stringify(app.restartPolicySwarm ?? null)}, e sem ela o Swarm usa "any"). Com "any", uma migration que falha é repetida sem parar, e um deploy pode cortar uma no meio.`;
  }

  const health = app.healthCheckSwarm;

  if (health && Object.keys(health).length > 0) {
    return `${SWARM_SETTINGS} → Health Check precisa ficar vazio: o da imagem é o que diz quando a migration terminou.`;
  }

  const mode = app.modeSwarm;
  const replicas = mode ? mode.Replicated?.Replicas : app.replicas;

  if ((mode && !mode.Replicated) || replicas !== 1) {
    return `a Application ${LABEL} precisa de exatamente 1 réplica (Advanced → Cluster Settings → Replicas; e Mode vazio em Swarm Settings).`;
  }

  if (app.updateConfigSwarm?.Order === "stop-first") {
    return `${SWARM_SETTINGS} → Update Config: deixe vazio (o padrão do Dokploy, start-first). Com "stop-first", um segundo deploy para uma migration ainda em andamento.`;
  }

  return null;
}

/** The service's tasks, as Dokploy lists them (newest first). */
async function tasks(appName) {
  const list = await get(
    `/api/docker.getServiceContainersByAppName?appName=${encodeURIComponent(appName)}`,
  );

  if (!Array.isArray(list)) {
    throw new Error(
      "resposta inesperada de docker.getServiceContainersByAppName (não é uma lista)",
    );
  }

  return list
    .filter((task) => task && typeof task.containerId === "string")
    .map((task) => ({
      id: task.containerId,
      // "Running 3 seconds ago", "Failed 8 seconds ago": the state is the
      // first word.
      status: String(task.currentState ?? "")
        .trim()
        .split(/\s+/)[0],
      currentState: String(task.currentState ?? "").trim(),
      error: String(task.error ?? "")
        .trim()
        .replace(/^"|"$/g, ""),
    }));
}

const DONE = new Set(["Running", "Complete"]);
const FAILED = new Set(["Failed", "Rejected", "Orphaned"]);
const STOPPED = new Set(["Shutdown", "Remove"]);

/** The outcome of the release among the tasks created by this deploy. */
function outcome(fresh) {
  const failed = fresh.find((task) => FAILED.has(task.status));

  if (failed) return { kind: "failed", task: failed };

  const done = fresh.find((task) => DONE.has(task.status));

  if (done) return { kind: "done", task: done };

  if (fresh.length > 0 && fresh.every((task) => STOPPED.has(task.status))) {
    return { kind: "stopped", task: fresh[0] };
  }

  return { kind: "waiting", task: fresh[0] ?? null };
}

const LOGS = `O log da migration está no Dokploy: Application ${LABEL} → Logs (o Swarm guarda o da tarefa que falhou).`;

async function main() {
  let app;

  try {
    app = await get(
      `/api/application.one?applicationId=${encodeURIComponent(APPLICATION_ID)}`,
    );
  } catch (error) {
    fail(
      `Não foi possível ler a Application ${LABEL} no Dokploy: ${error.message}`,
    );
  }

  const wrong = misconfiguration(app ?? {});

  if (wrong) fail(`Etapa de release não rodou: ${wrong} Nada foi migrado.`);

  const appName = app.appName;
  let current = [];

  // A deployed service always lists its current task, but Dokploy answers
  // an empty list whenever `docker service ps` printed anything on stderr.
  // Taken at face value, the idle task of the last release would look new
  // after the deploy: a success that never ran. So an empty list is read
  // three times, and then believed only when the deployment history proves
  // that no deploy of this Application ever succeeded — no `done`, so no
  // Swarm service (a Deploy that failed on a tag not pushed yet ends in
  // `error`). Dokploy keeps only the ten newest deployments, so a history
  // that reached ten proves nothing, and fails closed too; one deleted by
  // hand in the panel cannot be told apart. `applicationStatus` cannot say
  // it either: saving the Docker provider (a new GHCR token) or stopping
  // the Application sets `idle` on a live service.
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      current = await tasks(appName);
      if (current.length > 0) break;
      if (attempt < 3) await sleep(Math.min(POLL_MS, 2_000) * attempt);
    }
  } catch (error) {
    fail(
      `Não foi possível ler as tarefas de ${LABEL} no Dokploy: ${error.message}. Nada foi migrado.`,
    );
  }

  if (current.length === 0) {
    let history;

    try {
      history = await get(
        `/api/deployment.all?applicationId=${encodeURIComponent(APPLICATION_ID)}`,
      );
    } catch (error) {
      fail(
        `Não foi possível ler os deployments de ${LABEL} no Dokploy: ${error.message}. Nada foi migrado.`,
      );
    }

    if (!Array.isArray(history)) {
      fail(
        `Resposta inesperada de deployment.all para ${LABEL} (não é uma lista). Nada foi migrado.`,
      );
    }

    if (history.some((deployment) => deployment?.status === "done")) {
      fail(
        `O Dokploy devolveu a lista de tarefas de ${LABEL} vazia três vezes, mas a Application já foi implantada com sucesso: sem saber quais tarefas já existiam, o resultado da etapa não seria confiável. Nada foi migrado. Confira a Application no painel (se o serviço foi removido do servidor, um Deploy nela o recria).`,
      );
    }

    if (history.length >= 10) {
      fail(
        `O Dokploy devolveu a lista de tarefas de ${LABEL} vazia três vezes, e o histórico de deployments (o Dokploy guarda só os 10 mais recentes) não mostra se o serviço já existe: o resultado da etapa não seria confiável. Nada foi migrado. Dê Deploy na ${LABEL} pelo painel (seguro: as migrations já aplicadas não mudam nada), espere Running e rode o pipeline de novo.`,
      );
    }
  }

  const before = new Set(current.map((task) => task.id));

  // The deploy itself, with its follow-up and retries. Its own messages
  // name the Application.
  const deployEnv = { ...env, DOKPLOY_APP_LABEL: LABEL };

  delete deployEnv.DOKPLOY_OPTIONAL;
  delete deployEnv.DOKPLOY_WAIT;

  const deploy = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "dokploy-deploy.mjs")],
    { stdio: "inherit", env: deployEnv },
  );

  if (deploy.status !== 0) {
    fail(
      `O deploy de ${LABEL} no Dokploy falhou (acima): a etapa de release não rodou, e nada mais foi implantado.`,
    );
  }

  const started = Date.now();
  let last = { kind: "waiting", task: null };
  let lastSeen = "";

  while (Date.now() - started < TIMEOUT_MS) {
    let fresh;

    try {
      fresh = (await tasks(appName)).filter((task) => !before.has(task.id));
    } catch (error) {
      console.log(
        `::warning::Falha ao ler as tarefas de ${LABEL} (${redact(error.message)}); tentando de novo.`,
      );
      await sleep(POLL_MS);
      continue;
    }

    last = outcome(fresh);

    const seen = last.task ? last.task.currentState : "sem tarefa nova ainda";

    // One line per change, not one per poll.
    if (seen.split(" ")[0] !== lastSeen) {
      console.log(`[release] ${LABEL}: ${seen}`);
      lastSeen = seen.split(" ")[0];
    }

    const seconds = Math.round((Date.now() - started) / 1000);

    if (last.kind === "done") {
      summary(
        `Migrations: ${LABEL} concluiu a etapa de release em ~${seconds}s (migrations e seeds aplicados).`,
      );
      return;
    }

    if (last.kind === "failed") {
      fail(
        `A etapa de release falhou em ${LABEL}: ${last.task.currentState}${last.task.error ? ` (${redact(last.task.error)})` : ""}. A API não foi implantada e segue no build anterior. ${LOGS}`,
      );
    }

    if (last.kind === "stopped") {
      fail(
        `A tarefa de ${LABEL} foi parada antes de terminar (${last.task.currentState}): outro deploy da Application, ou um rollback do Swarm. A API não foi implantada. ${LOGS}`,
      );
    }

    await sleep(POLL_MS);
  }

  fail(
    last.task
      ? `A etapa de release de ${LABEL} não terminou em ${TIMEOUT_MS / 1000}s (a tarefa está ${last.task.currentState}). Ela segue no servidor — uma migration nunca é interrompida no meio; a API não foi implantada. Acompanhe em Logs; quando terminar, o próximo run a encontra aplicada ou a roda de novo.`
      : `O Dokploy aceitou o deploy de ${LABEL}, mas nenhuma tarefa nova apareceu em ${TIMEOUT_MS / 1000}s. A API não foi implantada. Confira a Application no painel (Logs, e se o serviço existe).`,
  );
}

await main();

#!/usr/bin/env node
/**
 * Runs the release step — `prisma migrate deploy` plus the idempotent seeds —
 * on the Dokploy Application trajetto-api-migrate, and waits until it
 * FINISHED: applied, or failed. The deploy action runs it before the API rolls out,
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
 *   1b. On the single VPS, the other environment's release step first: while
 *      Dokploy still deploys it, or its task has not reached `Running`, this
 *      one waits (U-11).
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
 *   RELEASE_TIMEOUT_SECONDS   how long the whole step may take, the wait on the
 *                             other environment included (default 1800, at
 *                             most 3600)
 *   RELEASE_POLL_SECONDS      interval between reads of the tasks (default 5)
 *   RELEASE_SERIALIZE_WITH_APPLICATION_ID
 *                             the OTHER environment's release Application:
 *                             wait while it migrates (waitForTheOtherRelease)
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
/**
 * The ceiling of RELEASE_TIMEOUT_SECONDS. The deploy job has 120 min
 * (staging.yml, production.yml), and after this step it still moves the
 * tags, deploys the AI and the API (with their retries) and checks the
 * rollout: a longer wait let GitHub kill the job halfway through those,
 * which must never be cut, with the API's and the AI's tags apart. A
 * build that needs more runs outside the pipeline (Deploy on
 * trajetto-api-migrate in the panel, docs/deploy.md).
 */
const MAX_RELEASE_TIMEOUT_SECONDS = 3600;

/**
 * The patience for the whole step, from the environment's variable
 * RELEASE_TIMEOUT_SECONDS (vars of the GitHub environment, through the
 * deploy action; F2-01): a release with a long prisma/concurrent build
 * needs more than the default 30 min. ONE budget for the wait on the other
 * environment's release and for this one's outcome. Not a positive number:
 * the default, with a warning (a typo must not turn the wait into zero);
 * above the ceiling: the ceiling, with a warning.
 */
function releaseTimeoutMs(raw) {
  if (raw === undefined || raw.trim() === "") return 1800 * 1000;

  const seconds = Number(raw);

  if (Number.isFinite(seconds) && seconds > MAX_RELEASE_TIMEOUT_SECONDS) {
    console.log(
      `::warning::RELEASE_TIMEOUT_SECONDS="${raw}" passa do teto de ${MAX_RELEASE_TIMEOUT_SECONDS} s (o job do deploy tem 120 min, e a IA, a API e a conferência do rollout ainda vêm depois desta etapa); vale ${MAX_RELEASE_TIMEOUT_SECONDS}.`,
    );

    return MAX_RELEASE_TIMEOUT_SECONDS * 1000;
  }

  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  console.log(
    `::warning::RELEASE_TIMEOUT_SECONDS="${raw}" não é um número positivo de segundos; vale o padrão, 1800.`,
  );

  return 1800 * 1000;
}

const TIMEOUT_MS = releaseTimeoutMs(env.RELEASE_TIMEOUT_SECONDS);

/**
 * The least of the budget this step's own release must still have when
 * the wait on the other environment ends: that wait gives up this much
 * before the budget does, so this run never starts a release only to give
 * up on it at once.
 */
const MIN_OWN_WINDOW_MS = Math.min(120_000, TIMEOUT_MS / 2);
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

/**
 * A task that has not reached `Running` yet: Swarm's states before it, the
 * image pull (`Preparing`) and the migration itself (`Starting`, until the
 * image's healthcheck sees the marker) included.
 */
const IN_FLIGHT = new Set([
  "New",
  "Allocated",
  "Pending",
  "Assigned",
  "Accepted",
  "Preparing",
  "Ready",
  "Starting",
]);

/**
 * A Dokploy deployment `running` for longer than this is taken as stuck (a
 * Dokploy restart leaves them so), not as a release in progress: the same
 * patience dokploy-deploy.mjs gives one attempt by default.
 */
const STUCK_DEPLOYMENT_MS = 15 * 60 * 1000;

/**
 * What the other environment's release Application is doing right now: the
 * reasons to wait (empty when it is idle), and the warnings to print once.
 * Throws when Dokploy cannot say.
 */
async function otherReleaseActivity(otherId, otherName) {
  const busy = [];
  const warnings = [];

  for (const task of await tasks(otherName)) {
    if (IN_FLIGHT.has(task.status)) busy.push(`tarefa ${task.currentState}`);
  }

  const deployments = await get(
    `/api/deployment.all?applicationId=${encodeURIComponent(otherId)}`,
  );

  if (!Array.isArray(deployments)) {
    throw new Error("resposta inesperada de deployment.all (não é uma lista)");
  }

  for (const deployment of deployments) {
    if (deployment?.status !== "running") continue;

    const createdAt = Date.parse(String(deployment.createdAt ?? ""));

    if (
      Number.isFinite(createdAt) &&
      Date.now() - createdAt < STUCK_DEPLOYMENT_MS
    ) {
      busy.push("deploy em andamento no Dokploy (baixando a imagem)");
    } else {
      warnings.push(
        `::warning::O deployment ${redact(deployment.deploymentId ?? "?")} de ${otherName} está 'running' no Dokploy há mais de ${STUCK_DEPLOYMENT_MS / 60_000} min (ou sem data): tomado como travado, não como uma etapa em andamento.`,
      );
    }
  }

  return { busy, warnings };
}

/**
 * One release step at a time on the VPS (plano-escala U-11): while the
 * OTHER environment's release Application (RELEASE_SERIALIZE_WITH_APPLICATION_ID,
 * a variable of the GitHub environment) is releasing, this one waits before
 * deploying its own. Staging and production share one host until staging
 * moves to its own server, and the memory plan counts one migrate at a time
 * (plano-escala-execucao, section 3).
 *
 * "Releasing" is the whole span, not only the migration: a Dokploy
 * deployment of it still `running` (Dokploy pulls the image before it
 * updates the service, and the tasks show nothing new meanwhile), and any
 * task before `Running` (`Preparing` while Swarm pulls, then `Starting`
 * while it migrates). Watching `Starting` alone let a release that was
 * still pulling slip past the check, and both then migrated at once.
 *
 * Both environments check each other, and the check runs right before this
 * one's own deploy; two runs that read each other within the same second
 * can still both go, since Dokploy offers no lock to take. A rare overlap
 * costs memory for a few minutes, never data: each step works on its own
 * database.
 *
 * Unset: nothing to wait for. Unreadable (a wrong id, Dokploy not
 * answering): a warning, and the step goes ahead as before — the
 * serialization guards memory, not data. Still releasing at the deadline:
 * this run fails before touching the database, saying which Application
 * holds it.
 *
 * Returns how long it waited, which the budget of this release's own
 * outcome loses (RELEASE_TIMEOUT_SECONDS is one budget for both).
 */
async function waitForTheOtherRelease() {
  const other = (env.RELEASE_SERIALIZE_WITH_APPLICATION_ID ?? "").trim();

  if (!other) return 0;

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(other)) {
    console.log(
      "::warning::RELEASE_SERIALIZE_WITH_APPLICATION_ID tem formato inesperado (copie o id da URL da trajetto-api-migrate do outro ambiente); a etapa segue sem esperar.",
    );
    return 0;
  }

  if (other === APPLICATION_ID) {
    console.log(
      `::warning::RELEASE_SERIALIZE_WITH_APPLICATION_ID aponta para a própria ${LABEL} deste ambiente; ela deve ser a do OUTRO ambiente. A etapa segue sem esperar.`,
    );
    return 0;
  }

  let otherName;

  try {
    const app = await get(
      `/api/application.one?applicationId=${encodeURIComponent(other)}`,
    );

    otherName = String(app?.appName ?? "");
  } catch (error) {
    console.log(
      `::warning::Não foi possível ler a trajetto-api-migrate do outro ambiente (${redact(error.message)}); a etapa segue sem esperar por ela.`,
    );
    return 0;
  }

  if (!/^[a-zA-Z0-9.\-_]+$/.test(otherName)) {
    console.log(
      "::warning::O Dokploy não informou o appName da trajetto-api-migrate do outro ambiente; a etapa segue sem esperar por ela.",
    );
    return 0;
  }

  const started = Date.now();
  let announced = false;
  const warned = new Set();

  for (;;) {
    let activity;

    try {
      activity = await otherReleaseActivity(other, otherName);
    } catch (error) {
      console.log(
        `::warning::Falha ao ler o estado de ${otherName} (${redact(error.message)}); a etapa segue sem esperar.`,
      );
      return Date.now() - started;
    }

    for (const warning of activity.warnings) {
      if (!warned.has(warning)) console.log(warning);
      warned.add(warning);
    }

    const seconds = Math.round((Date.now() - started) / 1000);

    if (activity.busy.length === 0) {
      if (announced) {
        summary(
          `Migrations: esperou ~${seconds}s a etapa de release do outro ambiente (${otherName}) terminar; uma por vez na VPS.`,
        );
      }
      return Date.now() - started;
    }

    if (!announced) {
      console.log(
        `[release] A etapa de release do outro ambiente (${otherName}) está rodando (${activity.busy.join("; ")}): esperando ela terminar antes de começar esta (uma migração por vez na VPS).`,
      );
      announced = true;
    }

    if (Date.now() - started >= TIMEOUT_MS - MIN_OWN_WINDOW_MS) {
      fail(
        `A etapa de release do outro ambiente (${otherName}) segue rodando há ${seconds}s (${activity.busy.join("; ")}): esta não começou, e nada foi migrado nem implantado. Acompanhe a ${otherName} no Dokploy (Logs) e rode de novo quando ela terminar; para não esperar, apague a variável RELEASE_SERIALIZE_WITH_APPLICATION_ID do environment do GitHub.`,
      );
    }

    await sleep(POLL_MS);
  }
}

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

  // One budget for both waits: what the other environment took, this
  // release's outcome no longer has. (The deploy call in between keeps the
  // bounds of dokploy-deploy.mjs, as every service's deploy does.)
  const ownBudgetMs = TIMEOUT_MS - (await waitForTheOtherRelease());

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

  while (Date.now() - started < ownBudgetMs) {
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
      ? `A etapa de release de ${LABEL} não terminou no prazo (RELEASE_TIMEOUT_SECONDS, ${TIMEOUT_MS / 1000}s no total, a espera pela do outro ambiente incluída; a tarefa está ${last.task.currentState}). Ela segue no servidor — uma migration nunca é interrompida no meio; a API não foi implantada. Acompanhe em Logs; quando terminar, o próximo run a encontra aplicada ou a roda de novo.`
      : `O Dokploy aceitou o deploy de ${LABEL}, mas nenhuma tarefa nova apareceu no prazo (${TIMEOUT_MS / 1000}s no total). A API não foi implantada. Confira a Application no painel (Logs, e se o serviço existe).`,
  );
}

await main();

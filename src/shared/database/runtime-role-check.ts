import type { PrismaClient } from "@prisma/client";

import { isDatabaseUnavailable } from "@/shared/errors/database-unavailable";
import { settlesWithin } from "@/shared/lifecycle/deadline";
import { logger } from "@/shared/logging/logger";

import { openDdlConnection, type DdlConnection } from "./ddl-connection";
import { PARTITION_OWNER_ROLE } from "./partition-owner";

/**
 * Whether the runtime still connects as the owner of the database (plano-
 * escala F3-21, the security review).
 *
 * Today the runtime connects as the Database's user, the owner of every
 * table and a superuser: an SQL injection there could read the PITR keys
 * and delete the backups. The cut gives it trajetto_http and
 * trajetto_batch (infra/sql/20-runtime-roles.sql) — a URL the owner types
 * by hand in each Application, and so a step that can be forgotten, or
 * undone by a copy of an old Environment. So the boot says it out loud:
 *
 *  - connected as a superuser or as the tables' owner: a warning on every
 *    boot; with DATABASE_REQUIRE_RUNTIME_ROLE=true, the process does not
 *    start (the flag goes on only after the cut, docs/deploy.md);
 *  - with the flag, a process that runs the cron (WORKERS_ENABLED=true
 *    today) must also have BATCH_DATABASE_URL, and its DDL connection must
 *    be able to SET ROLE trajetto_partitions. Without either, the nightly
 *    job could no longer create tomorrow's partitions of the positions,
 *    and the pings of the day after would be refused with no partition to
 *    land in — in silence, a day later. So it is refused at the boot,
 *    where the deploy shows it.
 *
 * A database that does not answer proves nothing about the configuration:
 * the check logs it and lets the boot go on, as it always did (readiness
 * keeps the replica out of the balancer until the database is back). Only
 * an answer — the role the database reports, a SET ROLE it refuses, a
 * login it rejects — can stop a boot, and only with the flag.
 */

const log = logger.child({ component: "database-role" });

interface RuntimeRole {
  /** The role the runtime's pool is connected as. */
  user: string;
  superuser: boolean;
  /** It may act as the owner of the tables (the migration user). */
  tablesOwner: boolean;
}

type PartitionRoleProbe =
  | { state: "not-checked" }
  | { state: "ok" }
  | { state: "refused"; detail: string }
  | { state: "unreachable"; detail: string };

interface RoleCheckInput {
  /** Null when the database did not answer. */
  role: RuntimeRole | null;
  require: boolean;
  runsCron: boolean;
  batchUrl: string | undefined;
  partitionRole: PartitionRoleProbe;
}

interface RoleCheckVerdict {
  /** Each stops the boot. */
  fatal: string[];
  warnings: string[];
}

/**
 * The tables' owner is the one who ran the migrations: the owner of
 * _prisma_migrations. A member of it (or a superuser, a member of every
 * role) can do whatever the owner can.
 */
const RUNTIME_ROLE_SQL = `
  SELECT current_user::text AS "user",
         r.rolsuper AS "superuser",
         coalesce(pg_has_role(current_user, c.relowner, 'MEMBER'), false) AS "tablesOwner"
  FROM pg_catalog.pg_roles r
  LEFT JOIN pg_catalog.pg_class c
    ON c.oid = to_regclass(format('%I._prisma_migrations', current_schema()))
  WHERE r.rolname = current_user
`;

const FLAG = "DATABASE_REQUIRE_RUNTIME_ROLE=true";

/** What the boot makes of what it read. Pure: the unit tests drive it. */
function judgeRuntimeRole(input: RoleCheckInput): RoleCheckVerdict {
  const verdict: RoleCheckVerdict = { fatal: [], warnings: [] };
  const { role } = input;

  if (role && (role.superuser || role.tablesOwner)) {
    const what = role.superuser
      ? "superusuário"
      : "dono das tabelas (o usuário das migrations)";
    const sentence = `O runtime conecta ao banco como ${role.user}, ${what}: troque a DATABASE_URL pelo login trajetto_http (docs/deploy.md, roles do banco).`;

    if (input.require) verdict.fatal.push(`${sentence} ${FLAG} recusa.`);
    else verdict.warnings.push(sentence);
  }

  if (!input.require || !input.runsCron) return verdict;

  if (!input.batchUrl) {
    verdict.fatal.push(
      `Com ${FLAG} e o cron neste processo (WORKERS_ENABLED=true), falta a BATCH_DATABASE_URL: sem ela o job de partições não cria as partições de amanhã.`,
    );

    return verdict;
  }

  if (input.partitionRole.state === "refused") {
    verdict.fatal.push(
      `Com ${FLAG}, a conexão DDL das partições (BATCH_DATABASE_URL) não consegue SET ROLE ${PARTITION_OWNER_ROLE}: ${input.partitionRole.detail}. O login precisa ser o trajetto_batch.`,
    );
  }

  return verdict;
}

/**
 * The SQLSTATEs of a login Postgres refuses for what it is, which a retry
 * will not change: a wrong password (28P01), a login it does not accept
 * (28000: no pg_hba line, a role without LOGIN), a database that does not
 * exist (3D000), CONNECT not granted on it (42501).
 *
 * Any other code on connect is the database away or busy, never the
 * configuration: no slot left (53300), starting or shutting down (57P0x),
 * the connection failing (class 08) — the outages isDatabaseUnavailable
 * knows, met by a rolling deploy at max_connections or a restart of the
 * Database — and Node's socket errnos (EPIPE, EINTR…), five letters too.
 * Those are logged and the boot goes on, as for the main pool.
 */
const LOGIN_REFUSED = new Set(["28P01", "28000", "3D000", "42501"]);

function loginRefusalOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === "string" && LOGIN_REFUSED.has(code) ? code : undefined;
}

async function probePartitionRole(
  batchUrl: string,
  openDdl: (url: string) => Promise<DdlConnection>,
): Promise<PartitionRoleProbe> {
  let connection: DdlConnection;

  try {
    connection = await openDdl(batchUrl);
  } catch (error) {
    const state = loginRefusalOf(error);

    // Only a refusal of the login itself is the configuration; anything
    // else is the database away (LOGIN_REFUSED above).
    return state
      ? { state: "refused", detail: `login recusado (SQLSTATE ${state})` }
      : {
          state: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        };
  }

  try {
    return (await connection.canActAsPartitionOwner())
      ? { state: "ok" }
      : { state: "refused", detail: "o login não é membro do role" };
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await connection.close();
  }
}

interface VerifyRuntimeRoleOptions {
  /** The runtime's own pool: the role every request runs as. */
  client: Pick<PrismaClient, "$queryRawUnsafe">;
  require: boolean;
  runsCron: boolean;
  batchUrl: string | undefined;
  openDdl?: (url: string) => Promise<DdlConnection>;
  log?: Pick<typeof log, "info" | "warn" | "error">;
}

/**
 * The boot's check. Logs what it found; throws, with every reason in the
 * message, only with DATABASE_REQUIRE_RUNTIME_ROLE=true.
 */
async function verifyRuntimeRole(
  options: VerifyRuntimeRoleOptions,
): Promise<RoleCheckVerdict> {
  const out = options.log ?? log;
  let role: RuntimeRole | null = null;

  try {
    const [row] =
      await options.client.$queryRawUnsafe<RuntimeRole[]>(RUNTIME_ROLE_SQL);

    role = row ?? null;
  } catch (error) {
    // Never a reason to stop a boot by itself: without the flag the check
    // only informs, and with it only an answer counts (see above).
    out.error(
      { err: error, unavailable: isDatabaseUnavailable(error) },
      "database role not checked at boot",
    );
  }

  const partitionRole: PartitionRoleProbe =
    options.require && options.runsCron && options.batchUrl
      ? await probePartitionRole(
          options.batchUrl,
          options.openDdl ?? ((url) => openDdlConnection(url)),
        )
      : { state: "not-checked" };

  if (partitionRole.state === "unreachable") {
    out.error(
      { detail: partitionRole.detail },
      "partition owner role not checked at boot: the batch connection did not answer",
    );
  }

  const verdict = judgeRuntimeRole({
    role,
    require: options.require,
    runsCron: options.runsCron,
    batchUrl: options.batchUrl,
    partitionRole,
  });

  for (const warning of verdict.warnings) {
    out.warn({ user: role?.user }, warning);
  }

  if (verdict.fatal.length > 0) {
    throw new Error(verdict.fatal.join(" "));
  }

  if (role) {
    out.info(
      {
        user: role.user,
        superuser: role.superuser,
        tablesOwner: role.tablesOwner,
        partitionRole: partitionRole.state,
      },
      "database role checked",
    );
  }

  return verdict;
}

/**
 * How long the boot waits for the check. A database that drops packets
 * instead of refusing them leaves each connection hanging until its own
 * connect_timeout (5 s in the runtime URL), and there are two of them; the
 * boot did not wait for the database before this check existed, and must
 * not start to because of it.
 */
const BOOT_CHECK_DEADLINE_MS = 12_000;

/**
 * The check as the boot runs it: past the deadline it is abandoned, as one
 * the database did not answer, and the boot goes on. A refusal that comes
 * in time still stops it.
 */
async function checkRuntimeRoleAtBoot(
  options: VerifyRuntimeRoleOptions & { deadlineMs?: number },
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? BOOT_CHECK_DEADLINE_MS;
  const check = verifyRuntimeRole(options);

  if (await settlesWithin(check, deadlineMs)) {
    await check;
    return;
  }

  // Settles later, unheard: never an unhandled rejection.
  check.catch(() => undefined);

  (options.log ?? log).error(
    { deadlineMs },
    "database role not checked at boot: no answer within the deadline",
  );
}

export {
  BOOT_CHECK_DEADLINE_MS,
  RUNTIME_ROLE_SQL,
  checkRuntimeRoleAtBoot,
  judgeRuntimeRole,
  verifyRuntimeRole,
};
export type { RoleCheckInput, RoleCheckVerdict, RuntimeRole };

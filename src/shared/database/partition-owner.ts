import type { Prisma } from "@prisma/client";

/**
 * The NOLOGIN role that owns the partitioned tables and every partition
 * (plano-escala F2-07, infra/sql/10-partitions.sql).
 */
const PARTITION_OWNER_ROLE = "trajetto_partitions";

type TransactionSql = Pick<
  Prisma.TransactionClient,
  "$queryRawUnsafe" | "$executeRawUnsafe"
>;

/**
 * Whether this session may act as the role on `$1` (a table name): the
 * role owns it and the session's user is a member of the role (a
 * superuser is a member of every role). A table that does not exist is
 * "no". Shared by the transactions below and the DDL connection
 * (ddl-connection.ts), which asks before each statement.
 */
const AS_OWNER_SQL = `
  SELECT coalesce(
    c.relowner = r.oid AND pg_has_role(current_user, r.oid, 'MEMBER'),
    false
  ) AS as_owner
  FROM (SELECT to_regclass(quote_ident($1)) AS rel) target
  LEFT JOIN pg_catalog.pg_class c ON c.oid = target.rel
  LEFT JOIN pg_catalog.pg_roles r ON r.rolname = $2
`;

/**
 * Runs the rest of `tx` as the owner of the partitions, when it can.
 *
 * ATTACH needs the owner of both tables, and a partition created as this
 * role is owned by it, which is what lets a later DETACH and DROP run
 * without a superuser. So the partition DDL switches to the role with SET
 * LOCAL ROLE: it lives and dies with this transaction, and the pooled
 * connection goes back as it came.
 *
 * Only when both hold: the session's user is a member of the role (a
 * superuser is a member of every role), and the role already owns
 * `parent`. Otherwise the transaction stays as current_user, which is what
 * every release before infra/sql/10-partitions.sql did: before the step ran
 * (an image that came before it, a step left 'pending' by a lock) the
 * parent still belongs to the Database's user, and a partition made as the
 * role could not be attached to it. The answer says which way it went; the
 * catalog's own view of it is `partitions.<table>.owner_ok` on
 * /health/metrics.
 */
async function asPartitionOwner(
  tx: TransactionSql,
  parent: string,
): Promise<boolean> {
  const [row] = await tx.$queryRawUnsafe<Array<{ as_owner: boolean }>>(
    AS_OWNER_SQL,
    parent,
    PARTITION_OWNER_ROLE,
  );

  if (!row?.as_owner) return false;

  // A role name is not a value: it cannot be a bind parameter. It is the
  // constant above, never input.
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PARTITION_OWNER_ROLE}`);

  return true;
}

export { AS_OWNER_SQL, PARTITION_OWNER_ROLE, asPartitionOwner };

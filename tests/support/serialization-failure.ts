import { Prisma } from "@prisma/client";

/**
 * A serialization failure in the shapes @prisma/client 7.10.1 + adapter-pg
 * really throw (measured against Postgres, see
 * tests/E2E/serializable-commit-retry.test.ts), for tests that need one
 * without two racing transactions.
 *
 * adapter-pg maps both 40001 and 40P01 to the kind `TransactionWriteConflict`
 * and keeps Postgres' code as `originalCode`. The client wraps that adapter
 * error in a PrismaClientKnownRequestError on the query path only.
 */
const clientVersion = Prisma.prismaVersion.client;

const POSTGRES_MESSAGE: Record<string, string> = {
  "40001":
    "could not serialize access due to read/write dependencies among transactions",
  "40P01": "deadlock detected",
};

/** The adapter's error, as adapter-pg builds it from pg's DatabaseError. */
function adapterWriteConflict(originalCode = "40001"): Error {
  return Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: {
      kind: "TransactionWriteConflict",
      originalCode,
      originalMessage: POSTGRES_MESSAGE[originalCode] ?? "N/A",
    },
  });
}

/**
 * Refused at COMMIT: Prisma 7 runs the COMMIT outside its error mapping, so
 * the caller of `$transaction` gets the adapter's error itself.
 */
const commitWriteConflict = adapterWriteConflict;

/** Refused on a model query inside the transaction: P2034. */
function queryWriteConflict(
  originalCode = "40001",
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    {
      code: "P2034",
      clientVersion,
      meta: { driverAdapterError: adapterWriteConflict(originalCode) },
    },
  );
}

/** Refused on a `$queryRaw`/`$executeRaw` inside the transaction: P2010. */
function rawQueryWriteConflict(
  originalCode = "40001",
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Raw query failed. Code: \`${originalCode}\`. Message: \`${POSTGRES_MESSAGE[originalCode]}\``,
    {
      code: "P2010",
      clientVersion,
      meta: { driverAdapterError: adapterWriteConflict(originalCode) },
    },
  );
}

export { commitWriteConflict, queryWriteConflict, rawQueryWriteConflict };

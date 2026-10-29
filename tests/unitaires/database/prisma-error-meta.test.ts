import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  driverAdapterCauseOf,
  isSerializationFailure,
  sqlStateOf,
  uniqueTargetOf,
} from "@/shared/errors/prisma-error-meta";
import { branchUniqueViolation } from "@/modules/branch/usecases/errors/branch-unique-violation";
import { driverUniqueViolation } from "@/modules/driver/usecases/errors/driver-unique-violation";
import { pauseConflictOf } from "@/modules/driver-pause/repositories/pause-conflicts";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { vehicleUniqueFieldOf } from "@/shared/vehicle/vehicle-conflicts";

import {
  commitWriteConflict,
  queryWriteConflict,
  rawQueryWriteConflict,
} from "../../support/serialization-failure";

/**
 * Which unique key refused a write, under Prisma 6 and Prisma 7.
 *
 * Prisma 6 named the COLUMNS in `meta.target`, read from Postgres' DETAIL.
 * Prisma 7 hands over the driver adapter's error, which names the INDEX
 * (`constraint.index`), or the columns when Postgres gave no constraint
 * name. Seven call sites tell conflicts apart by that value; read the Prisma
 * 7 way without a helper they all saw `undefined` and answered 500 for a
 * plain "CPF já cadastrado".
 */
const clientVersion = Prisma.prismaVersion.client;

/** P2002 exactly as @prisma/client 7.10.1 + adapter-pg raise it for 23505. */
function uniqueV7(constraint: { index?: string; fields?: string[] }) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${constraint.index}\``,
    {
      code: "P2002",
      clientVersion,
      meta: {
        modelName: "Driver",
        table: "driver",
        driverAdapterError: Object.assign(
          new Error("UniqueConstraintViolation"),
          {
            name: "DriverAdapterError",
            cause: {
              kind: "UniqueConstraintViolation",
              originalCode: "23505",
              originalMessage: `duplicate key value violates unique constraint "${constraint.index}"`,
              constraint,
            },
          },
        ),
      },
    },
  );
}

/** P2002 as Prisma 6 raised it (and the in-memory twins still do). */
function uniqueV6(target: string[] | string) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion,
    meta: { target },
  });
}

describe("uniqueTargetOf", () => {
  it("reads the index name Prisma 7 reports", () => {
    expect(
      uniqueTargetOf(uniqueV7({ index: "driver_businessId_cpf_key" })),
    ).toBe("driver_businessId_cpf_key");
  });

  it("reads the columns when Postgres gave no constraint name", () => {
    expect(uniqueTargetOf(uniqueV7({ fields: ["businessId", "cpf"] }))).toEqual(
      ["businessId", "cpf"],
    );
  });

  it("still reads Prisma 6's meta.target, both spellings", () => {
    expect(uniqueTargetOf(uniqueV6(["businessId", "cpf"]))).toEqual([
      "businessId",
      "cpf",
    ]);
    expect(uniqueTargetOf(uniqueV6("driver_pause_one_open_idx"))).toBe(
      "driver_pause_one_open_idx",
    );
  });

  it("is undefined for an error that names nothing", () => {
    expect(uniqueTargetOf(new Error("x"))).toBeUndefined();
    expect(uniqueTargetOf(null)).toBeUndefined();
  });
});

describe("the conflict readers, on Prisma 7's index names", () => {
  it("tells the driver's CPF from its CNH", () => {
    expect(
      driverUniqueViolation(uniqueV7({ index: "driver_businessId_cpf_key" }))
        ?.constructor.name,
    ).toBe("DriverCpfAlreadyExistsError");
    expect(
      driverUniqueViolation(uniqueV7({ index: "driver_businessId_cnh_key" }))
        ?.constructor.name,
    ).toBe("DriverLicenseAlreadyExistsError");
  });

  it("tells the branch's name, e-mail, ERP code and CNPJ apart", () => {
    const names = [
      "branch_businessId_corporate_reason_key",
      "branch_businessId_email_key",
      "branch_businessId_erp_code_key",
      "branch_cnpj_key",
    ].map(
      (index) => branchUniqueViolation(uniqueV7({ index }))?.constructor.name,
    );

    expect(names).toEqual([
      "BranchNameAlreadyExistsError",
      "BranchEmailAlreadyExistsError",
      "BranchErpCodeAlreadyExistsError",
      "BranchCnpjAlreadyExistsError",
    ]);
  });

  it("tells a vehicle's plate from its RENAVAM", () => {
    expect(
      vehicleUniqueFieldOf(
        uniqueV7({ index: "vehicle_businessId_license_plate_key" }),
      ),
    ).toBe("license_plate");
    expect(
      vehicleUniqueFieldOf(
        uniqueV7({ index: "vehicle_businessId_renavam_key" }),
      ),
    ).toBe("renavam");
  });

  it("reads the delivery's NF-e key", () => {
    expect(
      violatesUniqueOn(
        uniqueV7({ index: "delivery_businessId_invoice_key_key" }),
        "invoice_key",
      ),
    ).toBe(true);
    expect(
      violatesUniqueOn(
        uniqueV7({ index: "delivery_businessId_client_submission_id_key" }),
        "invoice_key",
      ),
    ).toBe(false);
  });

  it("reads the driver pause's three keys, the raw partial index included", () => {
    expect(
      pauseConflictOf(
        uniqueV7({ index: "driver_pause_businessId_start_submission_id_key" }),
      ),
    ).toBe("start-submission-taken");
    expect(
      pauseConflictOf(
        uniqueV7({ index: "driver_pause_businessId_end_submission_id_key" }),
      ),
    ).toBe("end-submission-taken");
    expect(
      pauseConflictOf(uniqueV7({ index: "driver_pause_one_open_idx" })),
    ).toBe("already-open");
  });
});

describe("sqlStateOf", () => {
  it("reads Prisma 7's originalCode", () => {
    const error = uniqueV7({ index: "x" });

    expect(sqlStateOf(error)).toBe("23505");
    expect(driverAdapterCauseOf(error)?.kind).toBe("UniqueConstraintViolation");
  });

  it("reads Prisma 6's meta.code, and never reports N/A as a state", () => {
    const raw = (code: string) =>
      new Prisma.PrismaClientKnownRequestError("Raw query failed", {
        code: "P2010",
        clientVersion,
        meta: { code, message: "x" },
      });

    expect(sqlStateOf(raw("23503"))).toBe("23503");
    expect(sqlStateOf(raw("N/A"))).toBeUndefined();
  });
});

describe("the bare DriverAdapterError of a refused COMMIT", () => {
  it("has its cause read like the one Prisma wraps in meta", () => {
    const error = commitWriteConflict();

    expect(driverAdapterCauseOf(error)?.kind).toBe("TransactionWriteConflict");
    expect(sqlStateOf(error)).toBe("40001");
  });

  it("is only trusted under the adapter's own name", () => {
    const lookalike = Object.assign(new Error("TransactionWriteConflict"), {
      cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
    });

    expect(driverAdapterCauseOf(lookalike)).toBeUndefined();
    expect(sqlStateOf(lookalike)).toBeUndefined();
  });
});

/**
 * Whether a serializable transaction may simply run again.
 *
 * The fuel and checklist repositories retried on `P2034` only. Under Prisma
 * 7.10.1 + adapter-pg the conflict Postgres finds at COMMIT — the usual place
 * for two transactions that only read and insert — reaches the caller as the
 * bare adapter error instead, and the loops gave up after one attempt with a
 * 500. Every shape is listed here; the race itself is reproduced against
 * Postgres in tests/E2E/serializable-commit-retry.test.ts.
 */
describe("isSerializationFailure", () => {
  /** An adapter error whose kind the client does not map (P2039/P2010). */
  const genericPostgres = (code: string) =>
    Object.assign(new Error("postgres"), {
      name: "DriverAdapterError",
      cause: { kind: "postgres", code, severity: "ERROR", message: "x" },
    });

  /** P2010 as Prisma 6 raised it for a refused raw statement. */
  const rawV6 = (code: string) =>
    new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010",
      clientVersion,
      meta: { code, message: "x" },
    });

  it("sees the bare adapter error a refused COMMIT throws", () => {
    const error = commitWriteConflict();

    // What the old `instanceof ... && code === "P2034"` check missed.
    expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(isSerializationFailure(error)).toBe(true);
  });

  it("sees P2034, as Prisma 7 and Prisma 6 raise it", () => {
    const v6 = new Prisma.PrismaClientKnownRequestError(
      "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
      { code: "P2034", clientVersion },
    );

    expect(isSerializationFailure(queryWriteConflict())).toBe(true);
    expect(isSerializationFailure(v6)).toBe(true);
  });

  it("sees a refused raw statement (P2010), under either version", () => {
    expect(isSerializationFailure(rawQueryWriteConflict())).toBe(true);
    expect(isSerializationFailure(rawV6("40001"))).toBe(true);
  });

  it("reads 40001 under an adapter's generic kind as well", () => {
    const modelQuery = new Prisma.PrismaClientKnownRequestError(
      "Database error. Code: `40001`. Message: `x`",
      {
        code: "P2039",
        clientVersion,
        meta: { driverAdapterError: genericPostgres("40001") },
      },
    );

    expect(isSerializationFailure(genericPostgres("40001"))).toBe(true);
    expect(isSerializationFailure(modelQuery)).toBe(true);
  });

  it("counts a deadlock (40P01), as Prisma's own P2034 always has", () => {
    expect(isSerializationFailure(commitWriteConflict("40P01"))).toBe(true);
    expect(isSerializationFailure(queryWriteConflict("40P01"))).toBe(true);
    expect(isSerializationFailure(rawQueryWriteConflict("40P01"))).toBe(true);
    expect(isSerializationFailure(rawV6("40P01"))).toBe(true);
    expect(isSerializationFailure(genericPostgres("40P01"))).toBe(true);
  });

  it("refuses the other answers about the data", () => {
    const closed = new Prisma.PrismaClientKnownRequestError(
      "Transaction already closed",
      { code: "P2028", clientVersion },
    );
    const uniqueAtCommit = Object.assign(
      new Error("UniqueConstraintViolation"),
      {
        name: "DriverAdapterError",
        cause: { kind: "UniqueConstraintViolation", originalCode: "23505" },
      },
    );

    expect(isSerializationFailure(uniqueV7({ index: "x" }))).toBe(false);
    expect(isSerializationFailure(closed)).toBe(false);
    expect(isSerializationFailure(rawV6("23505"))).toBe(false);
    expect(isSerializationFailure(rawV6("N/A"))).toBe(false);
    expect(isSerializationFailure(uniqueAtCommit)).toBe(false);
  });

  it("refuses the rest of class 40 and a COMMIT cut short", () => {
    // 40003 (statement_completion_unknown): the COMMIT may have landed, and
    // running the transaction again could write it twice. 57P01: the backend
    // was terminated — an outage, isDatabaseUnavailable's business.
    expect(isSerializationFailure(genericPostgres("40003"))).toBe(false);
    expect(isSerializationFailure(genericPostgres("40002"))).toBe(false);
    expect(isSerializationFailure(genericPostgres("57P01"))).toBe(false);
  });

  it("trusts neither a message nor a look-alike", () => {
    const lookalike = Object.assign(new Error("TransactionWriteConflict"), {
      cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
    });

    expect(isSerializationFailure(new Error("P2034 write conflict"))).toBe(
      false,
    );
    expect(isSerializationFailure({ code: "P2034" })).toBe(false);
    expect(isSerializationFailure(lookalike)).toBe(false);
    expect(isSerializationFailure("40001")).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  driverAdapterCauseOf,
  sqlStateOf,
  uniqueTargetOf,
} from "@/shared/errors/prisma-error-meta";
import { branchUniqueViolation } from "@/modules/branch/usecases/errors/branch-unique-violation";
import { driverUniqueViolation } from "@/modules/driver/usecases/errors/driver-unique-violation";
import { pauseConflictOf } from "@/modules/driver-pause/repositories/pause-conflicts";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { vehicleUniqueFieldOf } from "@/shared/vehicle/vehicle-conflicts";

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

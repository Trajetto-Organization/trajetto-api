import { describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";
import {
  conflictFromPrisma,
  prismaConflictFloor,
  uniqueFieldLabel,
} from "@/shared/errors/prisma-conflict";
import {
  foreignKeyViolation,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";

/**
 * The 409 behind a race the use case's own check could not see (batch of
 * 14/11/2026): the loser of two requests for the same e-mail, a delete that
 * met a reference committed after the count. Several catches did not map
 * them, and the person read "Houve um erro… tente novamente" (500) — or,
 * uncaught, the English "Internal server error" — for a conflict they can
 * act on.
 */

/** A unique violation as Prisma 7 raises it: the index name, no columns. */
const prisma7Unique = (index: string) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: {
      driverAdapterError: Object.assign(new Error("driver adapter error"), {
        name: "DriverAdapterError",
        cause: {
          kind: "UniqueConstraintViolation",
          originalCode: "23505",
          constraint: { index },
        },
      }),
    },
  });

class TakenError extends AppError {
  constructor(what: string) {
    super(`${what} em uso.`, 409, `${what.toUpperCase()}_TAKEN`);
  }
}

describe("conflictFromPrisma", () => {
  const map = {
    unique: {
      email: () => new TakenError("email"),
      driverId: () => new TakenError("driver"),
    },
  };

  it("answers the domain's error for the index the map names, by columns or by index name", async () => {
    expect(
      await conflictFromPrisma(uniqueViolation(["email"]), map),
    ).toMatchObject({ code: "EMAIL_TAKEN", statusCode: 409 });
    expect(
      await conflictFromPrisma(prisma7Unique("user_driverId_key"), map),
    ).toMatchObject({ code: "DRIVER_TAKEN" });
  });

  it("falls to the floor for an index the map does not name", async () => {
    expect(
      await conflictFromPrisma(
        prisma7Unique("vehicle_businessId_renavam_key"),
        map,
      ),
    ).toMatchObject({ code: "UNIQUE_CONFLICT", statusCode: 409 });
  });

  it("counts again on a foreign key, and answers what the count says", async () => {
    let counted = 0;

    const answer = await conflictFromPrisma(
      foreignKeyViolation("fine_vehicleId_fkey"),
      {
        inUse: async () => {
          counted += 1;

          return new TakenError("vehicle");
        },
      },
    );

    expect(counted).toBe(1);
    expect(answer).toMatchObject({ code: "VEHICLE_TAKEN" });
  });

  it("falls to the delete floor when the recount finds nothing", async () => {
    expect(
      await conflictFromPrisma(foreignKeyViolation("x_fkey"), {
        inUse: async () => null,
      }),
    ).toMatchObject({
      code: "RECORD_IN_USE",
      message: expect.stringContaining("antes de excluir"),
    });
  });

  it("answers nothing for an error that is no conflict, so the caller keeps its 500", async () => {
    expect(await conflictFromPrisma(new Error("boom"), map)).toBeNull();
    expect(
      await conflictFromPrisma(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "test",
        }),
        map,
      ),
    ).toBeNull();
  });
});

describe("prismaConflictFloor", () => {
  it("names the field, never the other row", () => {
    const floor = prismaConflictFloor(
      prisma7Unique("vehicle_businessId_license_plate_key"),
    );

    expect(floor).toMatchObject({
      statusCode: 409,
      code: "UNIQUE_CONFLICT",
      message: "Já existe um registro com este valor nesta empresa (placa).",
    });
  });

  it("says the sentence without a label, and without a place, for a key it cannot read", () => {
    expect(
      prismaConflictFloor(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "test",
        }),
      )?.message,
    ).toBe("Já existe um registro com este valor.");
  });

  // Review of the batch of 14/11/2026: the sentence said "nesta empresa"
  // for every key, the user's e-mail and the branch CNPJ included, which
  // are unique across companies: the other row may be in any of them.
  it("says 'nesta empresa' only for a key of the company", () => {
    expect(prismaConflictFloor(prisma7Unique("user_email_key"))?.message).toBe(
      "Já existe um registro com este valor (e-mail).",
    );
    expect(prismaConflictFloor(prisma7Unique("branch_cnpj_key"))?.message).toBe(
      "Já existe um registro com este valor (CNPJ).",
    );
    expect(
      prismaConflictFloor(prisma7Unique("driver_businessId_cpf_key"))?.message,
    ).toBe("Já existe um registro com este valor nesta empresa (CPF).");
  });

  it("reads a raw 23505 too (a $queryRaw, or a deferred check at COMMIT)", () => {
    const atCommit = Object.assign(new Error("duplicate key"), {
      name: "DriverAdapterError",
      cause: {
        kind: "UniqueConstraintViolation",
        originalCode: "23505",
        constraint: { index: "driver_businessId_cpf_key" },
      },
    });

    expect(prismaConflictFloor(atCommit)).toMatchObject({
      code: "UNIQUE_CONFLICT",
      message: expect.stringContaining("(CPF)"),
    });
  });

  it("speaks of the reference on a delete and of the missing link on other writes", () => {
    expect(
      prismaConflictFloor(foreignKeyViolation("fine_vehicleId_fkey"), "delete"),
    ).toMatchObject({
      code: "RECORD_IN_USE",
      message:
        "Este registro está em uso por outros cadastros. Inative-o ou remova os vínculos antes de excluir.",
    });
    expect(
      prismaConflictFloor(foreignKeyViolation("user_profileAccessId_fkey")),
    ).toMatchObject({
      code: "RECORD_IN_USE",
      message: expect.stringContaining("não existe mais"),
    });
  });

  it("is null for anything else", () => {
    expect(prismaConflictFloor(new Error("boom"))).toBeNull();
    expect(prismaConflictFloor(undefined)).toBeNull();
  });
});

describe("uniqueFieldLabel", () => {
  it.each([
    ["vehicle_businessId_renavam_key", "RENAVAM"],
    ["branch_businessId_erp_code_key", "código ERP"],
    ["route_businessId_code_key", "código"],
    ["branch_businessId_corporate_reason_key", "nome"],
    ["shipper_businessId_name_key", "nome"],
    ["delivery_businessId_invoice_key_key", "chave da NF-e"],
    ["user_email_key", "e-mail"],
    ["user_driverId_key", "motorista"],
    ["driver_businessId_cnh_key", "CNH"],
  ])("names %s as %s", (index, label) => {
    expect(uniqueFieldLabel(prisma7Unique(index))).toBe(label);
  });

  it("names nothing for a composite it does not know", () => {
    expect(
      uniqueFieldLabel(
        prisma7Unique("permission_action_profileAccessId_businessId_key"),
      ),
    ).toBeNull();
  });
});

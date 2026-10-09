import "reflect-metadata";

import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/AppError";
import { toHttpError } from "@/shared/errors/http-error-rules";

import { FINE_ERRORS } from "@/modules/fine/usecases/fine-http-errors";
import {
  FUEL_VEHICLE_READ_ERRORS,
  FUEL_WRITE_ERRORS,
} from "@/modules/fuel/usecases/errors/fuel-http-errors";
import { FUEL_TYPE_ERRORS } from "@/modules/fuel-type/usecases/errors/fuel-type-http-errors";

/**
 * Every domain error of the A–F modules reaches a client with an honest
 * status and a code (decision 11.3) — the twin of error-classes-b.
 *
 * A plain `Error` used to leave its controller as `400 { message }` with no
 * code, or as a 500 where no controller caught it (another module's create
 * naming a foreign branch or driver). Now each class is an AppError with a
 * code of its own, or is answered by its module's HTTP table.
 */
const MODULES = [
  "account-payable",
  "activity",
  "ai-analysis",
  "branch",
  "business",
  "chat",
  "dashboard",
  "delivery",
  "driver",
  "fine",
  "fuel",
  "fuel-type",
];

const ROOT = path.resolve(__dirname, "../../../src/modules");

/**
 * Raised and caught inside the repository's caller, never sent as they are:
 * the use cases turn each into a 409 DELIVERY_STATUS_CONFLICT AppError.
 */
const INTERNAL_SIGNALS = new Set([
  "DeliveryAssignmentConflictError",
  "DeliveryStatusConflictError",
]);

const TABLES = [FINE_ERRORS, FUEL_WRITE_ERRORS, FUEL_VEHICLE_READ_ERRORS, FUEL_TYPE_ERRORS];

function errorFiles(): string[] {
  const files: string[] = [];

  for (const module of MODULES) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) walk(full);
        else if (/-errors?\.ts$/.test(entry.name) && !/http-errors\.ts$/.test(entry.name)) {
          files.push(full);
        }
      }
    };

    walk(path.join(ROOT, module, "usecases"));
  }

  return files;
}

type ErrorClass = new (...args: unknown[]) => Error;

async function errorClasses(): Promise<Array<{ name: string; type: ErrorClass; file: string }>> {
  const found: Array<{ name: string; type: ErrorClass; file: string }> = [];

  for (const file of errorFiles()) {
    const exported = (await import(file)) as Record<string, unknown>;

    for (const [name, value] of Object.entries(exported)) {
      if (
        typeof value === "function" &&
        /Error$/.test(name) &&
        (value as { prototype?: unknown }).prototype instanceof Error
      ) {
        found.push({ name, type: value as ErrorClass, file });
      }
    }
  }

  return found;
}

describe("the domain errors of the A–F modules", () => {
  it("are AppErrors with a code of their own, or answered by a module table", async () => {
    const classes = await errorClasses();
    const unanswered: string[] = [];

    expect(classes.length).toBeGreaterThan(40);

    for (const { name, type, file } of classes) {
      if (INTERNAL_SIGNALS.has(name)) continue;

      const inTable = TABLES.some((table) =>
        table.some(([tableType]) => tableType === type),
      );

      if (inTable) continue;

      if (!(type.prototype instanceof AppError)) {
        unanswered.push(`${name} (${path.relative(ROOT, file)}): plain Error, no table`);
        continue;
      }

      let instance: AppError;

      try {
        instance = new type("detalhe", "detalhe", "detalhe") as AppError;
      } catch {
        continue; // Needs real arguments; its code is checked by its module's tests.
      }

      // A base class whose subclasses pass the code (SupportTicketDetailedError).
      if (instance.code === "detalhe") continue;

      if (instance.code === "BAD_REQUEST" || !/^[A-Z][A-Z0-9_]+$/.test(instance.code)) {
        unanswered.push(`${name}: code ${instance.code}`);
      }
    }

    expect(unanswered).toEqual([]);
  });

  it("answer another company's branch and driver exactly like missing ones", async () => {
    const { BranchNotFoundError } = await import("@/modules/branch/usecases/errors/branch-not-found-error");
    const { BranchNotBelongBusinessError } = await import("@/modules/branch/usecases/errors/branch-not-belong-business-error");
    const { DriverNotFoundError } = await import("@/modules/driver/usecases/errors/driver-not-found-error");
    const { DriverNotBelongBusinessError } = await import("@/modules/driver/usecases/errors/driver-not-belong-business-error");

    const pick = ({ statusCode, code, message }: AppError) => ({ statusCode, code, message });

    // Red before: plain Errors saying "não pertence a esta empresa", which
    // confirmed the id and fell to a 500 wherever no table mapped them.
    expect(pick(new BranchNotBelongBusinessError())).toEqual(pick(new BranchNotFoundError()));
    expect(pick(new DriverNotBelongBusinessError())).toEqual(pick(new DriverNotFoundError()));
    expect(pick(new DriverNotFoundError())).toMatchObject({ statusCode: 404, code: "DRIVER_NOT_FOUND" });
  });

  it("make conflicts with the current state 409 and a wrong confirmation 400", async () => {
    const branch = await import("@/modules/branch/usecases/errors/branch-no-pending-deletion-error");
    const business = await import("@/modules/business/usecases/errors/business-no-pending-deletion-error");
    const branchInvalid = await import("@/modules/branch/usecases/errors/branch-deletion-code-invalid-error");
    const businessUsed = await import("@/modules/business/usecases/errors/business-has-children-error");

    expect(new branch.BranchNoPendingDeletionError()).toMatchObject({
      statusCode: 409,
      code: "BRANCH_DELETION_NOT_REQUESTED",
    });
    expect(new business.BusinessNoPendingDeletionError()).toMatchObject({
      statusCode: 409,
      code: "BUSINESS_DELETION_NOT_REQUESTED",
    });
    expect(new branchInvalid.BranchDeletionCodeInvalidError()).toMatchObject({
      statusCode: 400,
      code: "BRANCH_DELETION_CODE_INVALID",
    });
    expect(new businessUsed.BusinessHasChildrenError("x")).toMatchObject({
      statusCode: 409,
      code: "BUSINESS_IN_USE",
    });
  });
});

describe("toHttpError, the convention every controller rethrows through", () => {
  class LinkMissing extends Error {}

  it("turns a listed error into the AppError the route decided", () => {
    const mapped = toHttpError(new LinkMissing("Veículo não encontrado."), [
      [LinkMissing, 400, "VEHICLE_NOT_FOUND"],
    ]);

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({
      statusCode: 400,
      code: "VEHICLE_NOT_FOUND",
      message: "Veículo não encontrado.",
    });
  });

  it("lets a rule override an AppError's own status (a body link is a 400)", () => {
    const pathMissing = new AppError("Filial não encontrada.", 404, "BRANCH_NOT_FOUND");

    expect(
      toHttpError(pathMissing, [[AppError, 400, "BRANCH_NOT_FOUND", "A filial informada não existe."]]),
    ).toMatchObject({ statusCode: 400, code: "BRANCH_NOT_FOUND", message: "A filial informada não existe." });
  });

  it("leaves an unlisted error as it is, for the handler", () => {
    const unknown = new Error("boom");

    expect(toHttpError(unknown, [[LinkMissing, 400, "X"]])).toBe(unknown);
  });
});

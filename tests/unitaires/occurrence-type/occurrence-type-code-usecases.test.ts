import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { CreateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-usecase";
import { UpdateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import { AppError } from "@/shared/errors/AppError";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: vi.fn() }));

/**
 * The occurrence type's own code, the "código do ERP" (plan of 02/11/2026,
 * L8): the ERP matches an occurrence by it instead of by a name the company
 * can rename. Optional and unique per company — a code taken in this company
 * is a 409 with its code, the same code at another company is not.
 */
const BUSINESS = "018f7000-0000-7000-8000-000000000db1";
const OTHER = "018f7000-0000-7000-8000-000000000db2";
const ADMIN = "018f7000-0000-7000-8000-000000000da1";
const OTHER_ADMIN = "018f7000-0000-7000-8000-000000000da2";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let types: InMemoryOccurrenceTypeRepository;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  types = new InMemoryOccurrenceTypeRepository();

  users.user.push(
    {
      id: ADMIN,
      name: "Ana",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: OTHER_ADMIN,
      name: "Bia",
      role: "BUSINESS_ADMIN",
      businessId: OTHER,
    } as User,
  );
  businesses.business.push(
    { id: BUSINESS } as Business,
    { id: OTHER } as Business,
  );
});

// Async, so a schema refusal reaches `refusal` as a rejection.
const create = async (
  body: Record<string, unknown>,
  businessId = BUSINESS,
  userId = ADMIN,
) =>
  new CreateOccurrenceTypeUseCase(users, businesses, types).execute(
    { ...createOccurrenceTypeSchema.parse(body), businessId },
    userId,
  );

const update = async (
  occurrenceTypeId: string,
  body: Record<string, unknown>,
) =>
  new UpdateOccurrenceTypeUseCase(users, types).execute({
    userId: ADMIN,
    businessId: BUSINESS,
    occurrenceTypeId,
    occurrenceTypeData: updateOccurrenceTypeSchema.parse(body),
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    if (error instanceof ZodError)
      return `400 VALIDATION_ERROR: ${error.errors.map((e) => e.message).join(" | ")}`;
    throw error;
  }

  return "accepted";
}

const stored = (name: string, businessId = BUSINESS) =>
  types.occurrenceTypes.find(
    (type) => type.businessId === businessId && type.name === name,
  )!;

describe("the occurrence type's ERP code", () => {
  it("is stored on create, and absent means none", async () => {
    await create({ name: "Cliente ausente", code: "AUS-01" });
    await create({ name: "Endereço não localizado" });

    expect(stored("Cliente ausente").code).toBe("AUS-01");
    expect(stored("Endereço não localizado").code ?? null).toBeNull();
  });

  it("answers 409 OCCURRENCE_TYPE_CODE_TAKEN for a code taken in the company", async () => {
    await create({ name: "Cliente ausente", code: "AUS-01" });

    expect(
      await refusal(create({ name: "Recusou a carga", code: "AUS-01" })),
    ).toBe("409 OCCURRENCE_TYPE_CODE_TAKEN");
  });

  it("lets another company use the same code", async () => {
    await create({ name: "Cliente ausente", code: "AUS-01" });

    expect(
      await refusal(
        create({ name: "Cliente ausente", code: "AUS-01" }, OTHER, OTHER_ADMIN),
      ),
    ).toBe("accepted");
  });

  it("never collides on types without a code", async () => {
    await create({ name: "Cliente ausente" });

    expect(await refusal(create({ name: "Recusou a carga" }))).toBe("accepted");
  });

  it("refuses an edit onto another type's code, keeps it when omitted and clears it with null", async () => {
    await create({ name: "Cliente ausente", code: "AUS-01" });
    await create({ name: "Recusou a carga", code: "REC-02" });

    const refused = stored("Recusou a carga");

    expect(await refusal(update(refused.id!, { code: "AUS-01" }))).toBe(
      "409 OCCURRENCE_TYPE_CODE_TAKEN",
    );
    expect(stored("Recusou a carga").code).toBe("REC-02");

    await update(refused.id!, { description: "O cliente recusou." });
    expect(stored("Recusou a carga").code).toBe("REC-02");

    await update(refused.id!, { code: null });
    expect(stored("Recusou a carga").code).toBeNull();

    // Freed: the code can now move to another type.
    await update(stored("Cliente ausente").id!, { code: "REC-02" });
    expect(stored("Cliente ausente").code).toBe("REC-02");
  });

  it("reads an empty code as none, and refuses spaces at the edges or a long code", async () => {
    await create({ name: "Cliente ausente", code: "" });
    expect(stored("Cliente ausente").code).toBeNull();

    expect(await refusal(create({ name: "Avaria", code: " AV " }))).toMatch(
      /^400 VALIDATION_ERROR: O código .*espaço/,
    );
    expect(
      await refusal(create({ name: "Avaria", code: "X".repeat(41) })),
    ).toMatch(/^400 VALIDATION_ERROR: O código .*40 caracteres/);
  });
});

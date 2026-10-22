import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { CreateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-usecase";
import { UpdateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-usecase";
import { DeleteOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/delete-occurrence-type/delete-occurrence-type-usecase";
import { ListOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import { AppError } from "@/shared/errors/AppError";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

const catalogChanged = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalogChanged }));

/**
 * The catalogue with categories (decisions 14.3 and 14.4; design §4.1) on the
 * twins: the matrix as 400s, category and nature locked once used or seeded,
 * one active delivery type and one active pause type always, defaults never
 * deleted, the category facet, and the driver's lists split by category.
 */
const BUSINESS = "018f7000-0000-7000-8000-000000000cb1";
const OTHER = "018f7000-0000-7000-8000-000000000cb2";
const ADMIN = "018f7000-0000-7000-8000-000000000ca1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let types: InMemoryOccurrenceTypeRepository;

beforeEach(async () => {
  catalogChanged.mockReset();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  types = new InMemoryOccurrenceTypeRepository();

  users.user.push({
    id: ADMIN,
    name: "Ana",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  businesses.business.push({ id: BUSINESS } as Business);

  await types.ensureDefaultTypes(BUSINESS);
});

const create = (body: Record<string, unknown>) =>
  new CreateOccurrenceTypeUseCase(users, businesses, types).execute(
    { ...createOccurrenceTypeSchema.parse(body), businessId: BUSINESS },
    ADMIN,
  );

const update = (occurrenceTypeId: string, body: Record<string, unknown>) =>
  new UpdateOccurrenceTypeUseCase(users, types).execute({
    userId: ADMIN,
    businessId: BUSINESS,
    occurrenceTypeId,
    occurrenceTypeData: updateOccurrenceTypeSchema.parse(body),
  });

const remove = (occurrenceTypeId: string) =>
  new DeleteOccurrenceTypeUseCase(users, types).execute({
    userId: ADMIN,
    businessId: BUSINESS,
    occurrenceTypeId,
  });

const byKey = (key: string) =>
  types.occurrenceTypes.find(
    (type) => type.businessId === BUSINESS && type.system_key === key,
  )!;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    if (error instanceof ZodError)
      return `400 VALIDATION_ERROR: ${error.errors.map((e) => e.message).join(" | ")}`;
    throw error;
  }

  throw new Error("expected a refusal");
}

describe("the seeded defaults", () => {
  it("are the four types of the design, idempotent, with a free name on a collision", async () => {
    await types.ensureDefaultTypes(BUSINESS);

    expect(
      types.occurrenceTypes
        .filter((type) => type.businessId === BUSINESS)
        .map((type) => [
          type.system_key,
          type.name,
          type.category,
          type.pause_kind ?? null,
        ]),
    ).toEqual([
      ["delivered_default", "Entrega normal", "DELIVERED", null],
      ["pause_meal", "Refeição", "PAUSE", "MEAL"],
      ["pause_rest", "Descanso", "PAUSE", "REST"],
      ["pause_other", "Outra pausa", "PAUSE", "OTHER"],
    ]);
    expect(byKey("delivered_default").requires_receipt_photo).toBe(true);
    expect(byKey("delivered_default").requires_signature).toBe(false);

    // Another company already says "Descanso" for something of its own.
    await types.createOccurrenceType({ businessId: OTHER, name: "Descanso" });
    await types.ensureDefaultTypes(OTHER);

    const rest = types.occurrenceTypes.find(
      (type) => type.businessId === OTHER && type.system_key === "pause_rest",
    );

    expect(rest?.name).toBe("Descanso (padrão)");
  });
});

describe("creating a type", () => {
  it("defaults to NOT_DELIVERED, the vocabulary the old web sends", async () => {
    const created = await create({
      name: "Cliente ausente",
      blocks_delivery: true,
    });

    expect(created.category).toBe("NOT_DELIVERED");
    expect(created.pause_kind).toBeNull();
  });

  it("creates a delivered type with its requirements and a pause type with its nature", async () => {
    const delivered = await create({
      name: "Entrega com avaria",
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_signature: true,
      requires_photo: true,
    });
    const snack = await create({
      name: "Lanche",
      category: "PAUSE",
      pause_kind: "REST",
    });

    expect(delivered).toMatchObject({
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_signature: true,
      requires_photo: true,
    });
    expect(snack).toMatchObject({ category: "PAUSE", pause_kind: "REST" });
    expect(catalogChanged).toHaveBeenCalledWith(BUSINESS, "occurrence_type");
  });

  it("refuses what the matrix refuses with sentences, writing nothing", async () => {
    const before = types.occurrenceTypes.length;

    expect(
      await refusal(create({ name: "Pausa sem natureza", category: "PAUSE" })),
    ).toBe(
      "400 VALIDATION_ERROR: Escolha a natureza legal da pausa (refeição, descanso ou outra).",
    );
    expect(
      await refusal(
        create({
          name: "Pausa com foto",
          category: "PAUSE",
          pause_kind: "MEAL",
          requires_photo: true,
        }),
      ),
    ).toBe(
      "400 VALIDATION_ERROR: Tipos de pausa não exigem fotos, assinatura, formulário nem autorização.",
    );
    expect(
      await refusal(
        create({
          name: "Entrega que impede",
          category: "DELIVERED",
          blocks_delivery: true,
        }),
      ),
    ).toBe(
      "400 VALIDATION_ERROR: Só tipos de não entrega podem ser impeditivos.",
    );
    expect(types.occurrenceTypes).toHaveLength(before);
  });

  it("keeps a nature only on a pause type", async () => {
    const created = await create({ name: "Recusa", pause_kind: null });

    expect(created.pause_kind).toBeNull();
    expect(
      await refusal(create({ name: "Recusa 2", pause_kind: "MEAL" })),
    ).toBe(
      "400 VALIDATION_ERROR: A natureza legal só existe em tipos de pausa.",
    );
  });
});

describe("editing a type", () => {
  it("locks the category and the nature of a default type", async () => {
    expect(
      await refusal(
        update(byKey("pause_meal").id!, { category: "NOT_DELIVERED" }),
      ),
    ).toBe("409 OCCURRENCE_TYPE_CATEGORY_LOCKED");
    expect(
      await refusal(update(byKey("pause_meal").id!, { pause_kind: "REST" })),
    ).toBe("409 OCCURRENCE_TYPE_CATEGORY_LOCKED");
  });

  it("locks the category of a type already used, and lets an unused one move", async () => {
    const used = await create({ name: "Cliente ausente" });
    const fresh = await create({ name: "Portão fechado" });

    types.occurrenceCounts.set(used.id!, 1);

    expect(await refusal(update(used.id!, { category: "DELIVERED" }))).toBe(
      "409 OCCURRENCE_TYPE_CATEGORY_LOCKED",
    );

    const moved = await update(fresh.id!, {
      category: "PAUSE",
      pause_kind: "OTHER",
    });

    expect(moved).toMatchObject({ category: "PAUSE", pause_kind: "OTHER" });
  });

  it("lets a default be renamed and its requirements changed (signature required)", async () => {
    const edited = await update(byKey("delivered_default").id!, {
      name: "Entrega padrão",
      requires_signature: true,
    });

    expect(edited).toMatchObject({
      name: "Entrega padrão",
      requires_signature: true,
    });
  });

  it("refuses requirements a pause cannot have, against the type as it would be", async () => {
    expect(
      await refusal(
        update(byKey("pause_rest").id!, { requires_signature: true }),
      ),
    ).toBe(
      "400 VALIDATION_ERROR: Tipos de pausa não exigem fotos, assinatura, formulário nem autorização.",
    );
    expect(
      await refusal(
        update(byKey("pause_rest").id!, {
          form_fields: [{ key: "onde", label: "Onde", type: "text" }],
        }),
      ),
    ).toBe(
      "400 VALIDATION_ERROR: Tipos de pausa não exigem fotos, assinatura, formulário nem autorização.",
    );
  });

  it("never leaves the company without an active delivery type or pause type", async () => {
    expect(
      await refusal(
        update(byKey("delivered_default").id!, { is_active: false }),
      ),
    ).toBe("409 OCCURRENCE_TYPE_LAST_OF_CATEGORY");

    await update(byKey("pause_meal").id!, { is_active: false });
    await update(byKey("pause_rest").id!, { is_active: false });

    expect(
      await refusal(update(byKey("pause_other").id!, { is_active: false })),
    ).toBe("409 OCCURRENCE_TYPE_LAST_OF_CATEGORY");

    // With a second delivery type, the default may go.
    await create({ name: "Entrega com avaria", category: "DELIVERED" });
    await update(byKey("delivered_default").id!, { is_active: false });

    expect(byKey("delivered_default").is_active).toBe(false);
  });

  it("stamps deactivated_at when a type goes off and clears it when it comes back", async () => {
    const created = await create({ name: "Cliente ausente" });

    const off = await update(created.id!, { is_active: false });

    expect(off.deactivated_at).toBeInstanceOf(Date);

    const on = await update(created.id!, { is_active: true });

    expect(on.deactivated_at).toBeNull();
  });
});

describe("deleting a type", () => {
  it("never deletes a default, and counts pauses as use", async () => {
    expect(await refusal(remove(byKey("pause_meal").id!))).toBe(
      "409 OCCURRENCE_TYPE_DEFAULT",
    );

    const snack = await create({
      name: "Lanche",
      category: "PAUSE",
      pause_kind: "REST",
    });

    types.occurrenceCounts.set(snack.id!, 2);

    expect(await refusal(remove(snack.id!))).toBe("409 OCCURRENCE_TYPE_IN_USE");
  });

  it("refuses deleting the last active delivery or pause type, as deactivating it", async () => {
    const lone = await create({
      name: "Entrega na portaria",
      category: "DELIVERED",
    });

    await update(byKey("delivered_default").id!, { is_active: false });

    expect(await refusal(remove(lone.id!))).toBe(
      "409 OCCURRENCE_TYPE_LAST_OF_CATEGORY",
    );

    // An inactive type never counted as the category's last: it goes.
    const off = await create({
      name: "Lanche",
      category: "PAUSE",
      pause_kind: "REST",
    });

    await update(off.id!, { is_active: false });
    await remove(off.id!);

    await update(byKey("delivered_default").id!, { is_active: true });
    await remove(lone.id!);

    expect(catalogChanged).toHaveBeenCalled();
  });
});

describe("the catalogue list", () => {
  it("filters by category, counts each category, and marks defaults and use", async () => {
    const problem = await create({ name: "Cliente ausente" });
    types.occurrenceCounts.set(problem.id!, 3);

    const list = new ListOccurrenceTypeUseCase(users, types);

    const pauses = await list.execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      categories: ["PAUSE"],
    });

    expect(pauses.data.map((row) => row.name).sort()).toEqual([
      "Descanso",
      "Outra pausa",
      "Refeição",
    ]);
    expect(pauses.data.every((row) => row.is_default)).toBe(true);
    expect(pauses.data.some((row) => "system_key" in row)).toBe(false);
    expect(pauses.meta.facets.category).toEqual([
      { value: "DELIVERED", count: 1 },
      { value: "NOT_DELIVERED", count: 1 },
      { value: "PAUSE", count: 3 },
    ]);

    const problems = await list.execute({
      userId: ADMIN,
      page: 1,
      pageSize: 10,
      categories: ["NOT_DELIVERED"],
    });

    expect(problems.data).toEqual([
      expect.objectContaining({
        name: "Cliente ausente",
        is_default: false,
        in_use: true,
      }),
    ]);
  });
});

describe("the driver's lists", () => {
  it("split by category: problems, deliveries (default first) and pauses", async () => {
    await create({ name: "Cliente ausente" });
    await create({
      name: "Avaria",
      category: "DELIVERED",
      requires_photo: true,
    });

    const problems = await types.listActiveOccurrenceTypes(BUSINESS);
    const delivered = await types.listActiveDeliveredTypes(BUSINESS);
    const pauses = await types.listActivePauseTypes(BUSINESS);

    expect(problems.map((type) => type.name)).toEqual(["Cliente ausente"]);
    expect(delivered.map((type) => [type.name, type.is_default])).toEqual([
      ["Entrega normal", true],
      ["Avaria", false],
    ]);
    expect(pauses.map((type) => [type.name, type.pause_kind])).toEqual([
      ["Descanso", "REST"],
      ["Outra pausa", "OTHER"],
      ["Refeição", "MEAL"],
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-usecase";
import { UpdateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";
import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

const catalogChanged = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalogChanged }));

/**
 * The form on the catalogue's use cases (decision 6.2), on the twins: stored
 * normalized, the version moving only with a real change, the driver's list
 * carrying what the app renders offline.
 */
const BUSINESS = "018f7000-0000-7000-8000-000000000ab1";
const ADMIN = "018f7000-0000-7000-8000-000000000aa1";

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
});

const FORM = [
  { key: "quem_atendeu", label: "Quem atendeu", type: "text", required: true },
  { key: "ligou", label: "Ligou para o cliente", type: "boolean" },
];

async function create() {
  return new CreateOccurrenceTypeUseCase(users, businesses, types).execute(
    {
      ...createOccurrenceTypeSchema.parse({
        name: "Cliente ausente",
        requires_authorization: true,
        form_fields: FORM,
      }),
      businessId: BUSINESS,
    },
    ADMIN,
  );
}

function update(occurrenceTypeId: string, body: Record<string, unknown>) {
  return new UpdateOccurrenceTypeUseCase(users, types).execute({
    userId: ADMIN,
    businessId: BUSINESS,
    occurrenceTypeId,
    occurrenceTypeData: updateOccurrenceTypeSchema.parse(body),
  });
}

describe("the form of an occurrence type", () => {
  it("is stored normalized at version 1", async () => {
    const created = await create();

    expect(created).toMatchObject({
      requires_authorization: true,
      form_version: 1,
      form_fields: [
        {
          key: "quem_atendeu",
          label: "Quem atendeu",
          type: "text",
          required: true,
          max_length: 200,
          multiline: false,
        },
        {
          key: "ligou",
          label: "Ligou para o cliente",
          type: "boolean",
          required: false,
        },
      ],
    });
  });

  it("keeps its version when the same form is saved again, and moves it on a change", async () => {
    const created = await create();

    await update(created.id!, { name: "Cliente ausente", form_fields: FORM });
    expect(types.occurrenceTypes[0].form_version).toBe(1);

    await update(created.id!, {
      form_fields: [{ ...FORM[0], label: "Quem recebeu o aviso" }, FORM[1]],
    });
    expect(types.occurrenceTypes[0].form_version).toBe(2);

    await update(created.id!, { form_fields: [] });
    expect(types.occurrenceTypes[0]).toMatchObject({
      form_version: 3,
      form_fields: null,
    });

    await update(created.id!, { description: "Portão fechado" });
    expect(types.occurrenceTypes[0].form_version).toBe(3);
  });

  it("reaches the driver's list with the flag and the form", async () => {
    await create();

    const [listed] = await types.listActiveOccurrenceTypes(BUSINESS);

    expect(listed).toMatchObject({
      name: "Cliente ausente",
      requires_authorization: true,
      form_version: 1,
      form_fields: [{ key: "quem_atendeu" }, { key: "ligou" }],
    });
  });
});

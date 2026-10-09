import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";
import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * Editing a delivery (decisions 5.2 and 5.7).
 *
 * - A deactivated shipper takes no new deliveries through ANY door; the edit
 *   used to move a delivery onto one (REV-14).
 * - The NF-e key is set once: editable while empty, immutable after.
 * - Items are the dispatcher's text on a typed delivery, and the note's on an
 *   imported XML.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000008b1";
const OPERATOR = "018f0000-0000-7000-8000-0000000008a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000008f1";
const RETIRED_SHIPPER = "018f0000-0000-7000-8000-0000000008f2";
const XML_IMPORT = "018f0000-0000-7000-8000-000000000871";

const KEY = "35240612345678000199550010000012341000012345";
const OTHER_KEY = "35240612345678000199550010000012351000012346";

let deliveries: InMemoryDeliveryRepository;
let shippers: InMemoryShipperRepository;
let update: UpdateDeliveryUseCase;
let create: CreateDeliveryUseCase;

beforeEach(() => {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();

  deliveries = new InMemoryDeliveryRepository();
  shippers = new InMemoryShipperRepository();

  users.user.push({
    id: OPERATOR,
    name: "Despachante",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businesses.business.push({ id: BUSINESS } as Business);

  shippers.shippers.push(
    { id: SHIPPER, name: "Ativo", businessId: BUSINESS, is_active: true } as Shipper,
    {
      id: RETIRED_SHIPPER,
      name: "Desativado",
      businessId: BUSINESS,
      is_active: false,
    } as Shipper,
  );

  update = new UpdateDeliveryUseCase(users, shippers, deliveries);

  create = new CreateDeliveryUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    { createActivityIfEnabled: async () => undefined } as unknown as NotificationService,
    new InMemoryWebhookFanOutService().asService(),
  );
});

async function seed(overrides: Partial<CreateDeliveryProps> = {}) {
  const created = await deliveries.createDelivery({
    businessId: BUSINESS,
    shipperId: SHIPPER,
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    ...overrides,
  } as CreateDeliveryProps);

  return created.id!;
}

function edit(deliveryId: string, deliveryData: Record<string, unknown>) {
  return update.execute({
    userId: OPERATOR,
    businessId: BUSINESS,
    deliveryId,
    deliveryData,
  });
}

describe("the shipper on an edit", () => {
  it("refuses moving a delivery onto a deactivated shipper", async () => {
    const id = await seed();

    await expect(edit(id, { shipperId: RETIRED_SHIPPER })).rejects.toMatchObject({
      statusCode: 400,
      code: "SHIPPER_INACTIVE",
    });

    expect(deliveries.deliveries[0].shipperId).toBe(SHIPPER);
  });

  it("still lets a delivery already on a deactivated shipper be corrected", async () => {
    const id = await seed({ shipperId: RETIRED_SHIPPER });

    const updated = await edit(id, {
      shipperId: RETIRED_SHIPPER,
      street: "Rua Dois",
    });

    expect(updated.street).toBe("Rua Dois");
  });
});

describe("the NF-e key is set once", () => {
  it("accepts a key on a delivery typed without one", async () => {
    const id = await seed();

    const updated = await edit(id, { invoice_key: KEY, invoice_number: "1234" });

    expect(updated.invoice_key).toBe(KEY);
    expect(updated.invoice_number).toBe("1234");
  });

  it("refuses to change a key already set", async () => {
    const id = await seed({ invoice_key: KEY });

    await expect(edit(id, { invoice_key: OTHER_KEY })).rejects.toMatchObject({
      code: "DELIVERY_INVOICE_KEY_IMMUTABLE",
    });

    await expect(edit(id, { invoice_key: null })).rejects.toMatchObject({
      code: "DELIVERY_INVOICE_KEY_IMMUTABLE",
    });

    await expect(edit(id, { invoice_number: "99" })).rejects.toMatchObject({
      code: "DELIVERY_INVOICE_KEY_IMMUTABLE",
    });

    expect(deliveries.deliveries[0].invoice_key).toBe(KEY);
  });

  it("treats the stored value sent back by the form as no change", async () => {
    const id = await seed({ invoice_key: KEY, invoice_number: "1234" });

    const updated = await edit(id, {
      invoice_key: KEY,
      invoice_number: "1234",
      city: "Campinas",
    });

    expect(updated.city).toBe("Campinas");
  });

  it("answers 409 when another delivery already holds the key", async () => {
    await seed({ invoice_key: KEY });
    const id = await seed();

    await expect(edit(id, { invoice_key: KEY })).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_INVOICE_KEY_EXISTS",
    });
  });

  it("answers the same 409 when the key is taken between the check and the write", async () => {
    await seed({ invoice_key: KEY });
    const id = await seed();

    // The check sees nothing (the twin commits in between); the unique
    // index then refuses the write, as Postgres does.
    vi.spyOn(deliveries, "findDeliveryByInvoiceKey").mockResolvedValueOnce(null);

    await expect(edit(id, { invoice_key: KEY })).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_INVOICE_KEY_EXISTS",
    });
  });
});

describe("the items of a delivery", () => {
  const items = [{ description: "Caixa de leite", quantity: 12 }];
  // As delivery_item stores them: no unit and no unit value are NULL.
  const stored = [{ description: "Caixa de leite", quantity: 12, unit: null, unit_value: null }];

  it("are replaced on a typed delivery", async () => {
    const id = await seed({ items: [{ description: "Antigo", quantity: 1 }] });

    await edit(id, { items });

    expect(deliveries.deliveryItems.get(id)).toEqual(stored);
  });

  it("are locked on a delivery imported from an NF-e XML", async () => {
    deliveries.importSources.set(XML_IMPORT, "NFE_XML");

    const id = await seed({ importId: XML_IMPORT, invoice_key: KEY });

    await expect(edit(id, { items })).rejects.toMatchObject({
      code: "DELIVERY_ITEMS_LOCKED",
    });
  });

  it("stay editable on a spreadsheet delivery (the rows were typed)", async () => {
    deliveries.importSources.set(XML_IMPORT, "SPREADSHEET");

    const id = await seed({ importId: XML_IMPORT });

    await edit(id, { items });

    expect(deliveries.deliveryItems.get(id)).toEqual(stored);
  });
});

describe("the create, racing on the NF-e key", () => {
  it("answers 409 instead of a 500 when the unique index decides", async () => {
    await seed({ invoice_key: KEY });

    vi.spyOn(deliveries, "findDeliveryByInvoiceKey").mockResolvedValueOnce(null);

    await expect(
      create.execute(
        {
          businessId: BUSINESS,
          shipperId: SHIPPER,
          recipient_name: "Outro destinatário",
          city: "São Paulo",
          uf: "SP",
          street: "Rua Três",
          invoice_key: KEY,
        } as CreateDeliveryProps,
        OPERATOR,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "DELIVERY_INVOICE_KEY_EXISTS",
    });
  });

  it("refuses a deactivated shipper with the shared code", async () => {
    await expect(
      create.execute(
        {
          businessId: BUSINESS,
          shipperId: RETIRED_SHIPPER,
          recipient_name: "Destinatário",
          city: "São Paulo",
          uf: "SP",
          street: "Rua Três",
        } as CreateDeliveryProps,
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: "SHIPPER_INACTIVE" });
  });
});

describe("what the delivery forms may send", () => {
  const valid = {
    shipperId: SHIPPER,
    recipient_name: "Cliente",
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Praça da Sé",
  };

  it("takes the expected date as a day (AAAA-MM-DD), stored at UTC midnight", () => {
    const parsed = createDeliverySchema.parse({
      ...valid,
      scheduled_date: "2026-09-17",
    });

    expect((parsed.scheduled_date as Date).toISOString()).toBe(
      "2026-09-17T00:00:00.000Z",
    );
  });

  it.each(["2026-09-17T03:00:00.000Z", "17/09/2026", "2026-02-30"])(
    "refuses %j as an expected date",
    (value) => {
      expect(
        createDeliverySchema.safeParse({ ...valid, scheduled_date: value })
          .success,
      ).toBe(false);
    },
  );

  it("accepts notes with blank lines between paragraphs (decision 5.5)", () => {
    expect(
      createDeliverySchema.safeParse({
        ...valid,
        notes: "Portão azul.\n\nTocar o interfone 2.",
      }).success,
    ).toBe(true);

    expect(
      createDeliverySchema.safeParse({ ...valid, notes: "Portão  azul." })
        .success,
    ).toBe(false);
  });

  it("does not carry a driver or a vehicle: assignment builds the route (DLV-EDIT-4)", () => {
    const parsed = createDeliverySchema.parse({
      ...valid,
      driverId: "018f0000-0000-7000-8000-0000000008d1",
      vehicleId: "018f0000-0000-7000-8000-0000000008c1",
    }) as Record<string, unknown>;

    expect(parsed.driverId).toBeUndefined();
    expect(parsed.vehicleId).toBeUndefined();
  });

  it("lets the edit carry the key and the items (the use case decides)", () => {
    const parsed = updateDeliverySchema.parse({
      invoice_key: KEY,
      items: [{ description: "Caixa", quantity: 2 }],
    });

    expect(parsed.invoice_key).toBe(KEY);
    expect(parsed.items).toHaveLength(1);
  });
});

/**
 * Decision 14.7, design §4.11: the point on the route map belongs to the
 * address. A new street or city with the old pin puts the stop where the
 * delivery no longer is, so changing the address clears it.
 */
describe("the address point when the address changes", () => {
  async function pinned() {
    const deliveryId = await seed();
    const row = deliveries.deliveries.find((entry) => entry.id === deliveryId)!;

    Object.assign(row, {
      latitude: -23.55,
      longitude: -46.63,
      geo_source: "MANUAL",
      geo_updated_at: new Date("2026-10-05T12:00:00.000Z"),
    });

    return row;
  }

  it("clears the pin when the street changes", async () => {
    const row = await pinned();

    await update.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: row.id!,
      deliveryData: { street: "Avenida Nova" },
    });

    expect(deliveries.deliveries.find((entry) => entry.id === row.id)).toMatchObject({
      street: "Avenida Nova",
      latitude: null,
      longitude: null,
      geo_source: null,
      geo_updated_at: null,
    });
  });

  it("keeps the pin when the address is sent unchanged, or only other fields change", async () => {
    const row = await pinned();

    await update.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      deliveryId: row.id!,
      deliveryData: { street: row.street, city: row.city, notes: "Portão azul" },
    });

    expect(deliveries.deliveries.find((entry) => entry.id === row.id)).toMatchObject({
      latitude: -23.55,
      longitude: -46.63,
      geo_source: "MANUAL",
    });
  });
});

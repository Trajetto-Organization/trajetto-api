import { describe, expect, it } from "vitest";

import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type {
  CreateDeliveryProps,
  CreateOccurrenceProps,
} from "@/modules/delivery/dtos/delivery-dto";
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";

import { expectPrismaCode, fixedId, minute, type Kind } from "../support";

/**
 * The delivery repository's contract (decision 13.2): the listing, the
 * exports, the detail, the unique keys and the occurrence/event writes —
 * what the Entregas screens, the spreadsheet exports and every proof or
 * occurrence use case rely on. Fixed ids for everything the twin keeps in
 * seams (shipper, driver, vehicle, route, type, reason, user); deliveries are
 * created through the repository itself and referred to by key.
 */

const A = fixedId("0d0a", 1);
const B = fixedId("0d0a", 2);

const FIXTURE = {
  A,
  B,
  shipperA: fixedId("0d5a", 1),
  shipperA2: fixedId("0d5a", 2),
  shipperB: fixedId("0d5b", 1),
  driverA: fixedId("0dd0", 1),
  vehicleA: fixedId("0dfe", 1),
  userA: fixedId("0dee", 1),
  deciderA: fixedId("0dee", 2),
  typeA: fixedId("0d7e", 1),
  reasonA: fixedId("0d8e", 1),
  routeA: fixedId("0d80", 1),
  driverName: "Ágata Motorista",
  driverCnh: "61234567890",
  plate: "ABC1D23",
  routeCode: 7,
  typeName: "Avaria na carga",
  reasonName: "Cliente ausente",
  userName: "Operador Um",
  deciderName: "Supervisora Dois",
  formFields: [{ key: "lacre", label: "Lacre", type: "text", required: false }],
} as const;

const MISSING = fixedId("0d0a", 99);

const base = (extra: Partial<CreateDeliveryProps>): CreateDeliveryProps => ({
  recipient_name: "Cliente",
  city: "São Paulo",
  uf: "SP",
  street: "Rua das Flores",
  businessId: A,
  shipperId: FIXTURE.shipperA,
  ...extra,
});

/**
 * The deliveries every case reads, in creation order (minute = created_at).
 * `d4` and `d5` share an instant: the id breaks the tie.
 */
const SEED: Array<{ key: string; minute: number; data: CreateDeliveryProps }> =
  [
    {
      key: "d1",
      minute: 1,
      data: base({
        recipient_name: "Padaria Estrela",
        invoice_key: "35260911222333000181550010000000011000000011",
        invoice_number: "11",
        code: "PED-1",
        driverId: FIXTURE.driverA,
        vehicleId: FIXTURE.vehicleA,
        items: [
          { description: "Caixa", quantity: 2, unit: "", unit_value: 10.5 },
        ],
      }),
    },
    {
      key: "d2",
      minute: 2,
      data: base({
        recipient_name: "Mercado Bom Preço",
        city: "Campinas",
        shipperId: FIXTURE.shipperA2,
        client_submission_id: "sub-d2",
      }),
    },
    {
      key: "d3",
      minute: 3,
      data: base({
        recipient_name: "açougue central",
        driverId: FIXTURE.driverA,
      }),
    },
    {
      key: "d4",
      minute: 4,
      data: base({ recipient_name: "Bar do Zé", code: "", invoice_key: "" }),
    },
    {
      key: "d5",
      minute: 4,
      data: base({ recipient_name: "Zebra Atacado", invoice_number: "" }),
    },
    // Another company, with the same NF-e key and submission key as A's rows.
    {
      key: "b1",
      minute: 0,
      data: base({
        businessId: B,
        shipperId: FIXTURE.shipperB,
        recipient_name: "Padaria Estrela de B",
        invoice_key: "35260911222333000181550010000000011000000011",
        client_submission_id: "sub-d2",
      }),
    },
  ];

interface DeliveryHarness {
  kind: Kind;
  repo: IDeliveryRepository;
  /** The id the repository gave each SEED key (and the extra rows a case adds). */
  id(key: string): string;
  /** The occurrence and event ids created in the seed, by key. */
  occurrence(key: string): string;
}

/** Creates the SEED through `repo` and the trail of d1; returns the ids. */
async function seedThrough(
  repo: IDeliveryRepository,
  pin: {
    delivery(id: string, at: Date): Promise<void>;
    occurrence(id: string, at: Date): Promise<void>;
    event(at: Date): Promise<void>;
  },
): Promise<{
  deliveries: Map<string, string>;
  occurrences: Map<string, string>;
}> {
  const deliveries = new Map<string, string>();
  const occurrences = new Map<string, string>();

  // Created out of order on purpose: the order must come from created_at.
  for (const row of [...SEED].reverse()) {
    const created = await repo.createDelivery(row.data);

    deliveries.set(row.key, created.id!);
    await pin.delivery(created.id!, minute(row.minute));
  }

  const d1 = deliveries.get("d1")!;

  const occurrenceSeed: Array<
    [string, number, Partial<CreateOccurrenceProps>]
  > = [
    ["o-old", 10, { description: "", photos: ["a.jpg", "b.jpg"] }],
    [
      "o-new",
      11,
      {
        description: "Lacre rompido",
        client_submission_id: "occ-sub-1",
        form_answers: { lacre: "123" },
        form_version: 1,
        authorization_status: "APPROVED",
        authorizedById: FIXTURE.deciderA,
        authorized_at: minute(12),
      },
    ],
  ];

  for (const [key, at, extra] of occurrenceSeed) {
    const { id } = await repo.createOccurrence({
      deliveryId: d1,
      occurrenceTypeId: FIXTURE.typeA,
      reportedById: FIXTURE.userA,
      ...extra,
    });

    occurrences.set(key, id);
    await pin.occurrence(id, minute(at));
  }

  await repo.createDeliveryEvent({
    type: "STATUS_CHANGE",
    deliveryId: d1,
    reportedById: FIXTURE.userA,
    status_from: "PENDING",
    status_to: "FAILED",
    reasonId: FIXTURE.reasonA,
    client_submission_id: "evt-sub-1",
  });
  await pin.event(minute(13));

  return { deliveries, occurrences };
}

function deliveryRepositoryContract(harness: () => DeliveryHarness): void {
  const ids = (h: DeliveryHarness, keys: string[]) =>
    keys.map((key) => h.id(key));
  const list = (
    extra: Partial<Parameters<IDeliveryRepository["listDeliveries"]>[0]> = {},
  ) =>
    harness().repo.listDeliveries({
      page: 1,
      pageSize: 50,
      businessId: A,
      ...extra,
    });

  describe("createDelivery", () => {
    it("stores an empty code, NF-e key or number as NULL", async () => {
      const h = harness();
      const d4 = await h.repo.findDeliveryById(h.id("d4"));
      const d5 = await h.repo.findDeliveryById(h.id("d5"));

      expect(d4).toMatchObject({
        code: null,
        invoice_key: null,
        status: "PENDING",
      });
      expect(d5).toMatchObject({ invoice_number: null });
    });

    it("refuses the same NF-e key or submission key twice in a company (P2002), not across companies", async () => {
      const { repo } = harness();

      await expectPrismaCode(
        repo.createDelivery(base({ invoice_key: SEED[0].data.invoice_key })),
        "P2002",
      );
      await expectPrismaCode(
        repo.createDelivery(base({ client_submission_id: "sub-d2" })),
        "P2002",
      );
    });

    it("finds by submission key and by NF-e key inside the company only", async () => {
      const h = harness();

      expect((await h.repo.findDeliveryBySubmissionId(A, "sub-d2"))?.id).toBe(
        h.id("d2"),
      );
      expect((await h.repo.findDeliveryBySubmissionId(B, "sub-d2"))?.id).toBe(
        h.id("b1"),
      );
      expect(await h.repo.findDeliveryBySubmissionId(A, "nope")).toBeNull();

      const key = SEED[0].data.invoice_key!;
      expect((await h.repo.findDeliveryByInvoiceKey(A, key))?.id).toBe(
        h.id("d1"),
      );
      expect((await h.repo.findDeliveryByInvoiceKey(B, key))?.id).toBe(
        h.id("b1"),
      );
    });
  });

  describe("listDeliveries", () => {
    it("lists one company, newest first, the id breaking a created_at tie, and pages", async () => {
      const h = harness();
      const tie = [h.id("d4"), h.id("d5")].sort().reverse();

      const first = await list({ pageSize: 3 });
      const second = await list({ page: 2, pageSize: 3 });

      expect([...first.data, ...second.data].map((row) => row.id)).toEqual([
        ...tie,
        ...ids(h, ["d3", "d2", "d1"]),
      ]);
    });

    it("sorts by driver name with the deliveries without a driver last ascending and first descending", async () => {
      const h = harness();
      const noDriver = [h.id("d4"), h.id("d5")].sort().reverse();

      const asc = await list({ sort: "driverName", order: "asc" });
      const desc = await list({ sort: "driverName", order: "desc" });

      expect(asc.data.map((row) => row.id)).toEqual([
        ...ids(h, ["d3", "d1"]),
        ...noDriver,
        h.id("d2"),
      ]);
      expect(desc.data.map((row) => row.id)).toEqual([
        ...noDriver,
        h.id("d2"),
        ...ids(h, ["d3", "d1"]),
      ]);
    });

    it("searches the recipient, the driver's name and CNH, the code, the city and the id, case-insensitively", async () => {
      const h = harness();
      const found = async (search: string) =>
        (await list({ search })).data.map((row) => row.id).sort();

      expect(await found("AÇOUGUE")).toEqual([h.id("d3")]);
      expect(await found("ágata")).toEqual(ids(h, ["d1", "d3"]).sort());
      expect(await found("12345678")).toEqual(ids(h, ["d1", "d3"]).sort());
      expect(await found("ped-1")).toEqual([h.id("d1")]);
      expect(await found("campinas")).toEqual([h.id("d2")]);
      expect(await found(h.id("d5").slice(-10))).toEqual([h.id("d5")]);
      // Literal: a LIKE wildcard matches nothing.
      expect(await found("%")).toEqual([]);
    });

    it("embeds the shipper, the driver and the vehicle the panel shows", async () => {
      const h = harness();
      const page = await list({ search: "Padaria" });

      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id: h.id("d1"),
        shipper: { id: FIXTURE.shipperA, name: "Alfa Embarcador" },
        driver: {
          id: FIXTURE.driverA,
          name: FIXTURE.driverName,
          cnh: FIXTURE.driverCnh,
        },
        vehicle: { id: FIXTURE.vehicleA, license_plate: FIXTURE.plate },
      });
    });

    it("counts each facet without its own filter, within the company", async () => {
      const page = await list({
        shipperIds: [FIXTURE.shipperA2],
        statuses: ["PENDING"],
      });

      expect(page.data.map((row) => row.recipient_name)).toEqual([
        "Mercado Bom Preço",
      ]);
      expect(page.statusCounts).toEqual([{ value: "PENDING", count: 1 }]);
      expect(
        [...page.shipperOptions].sort((x, y) => (x.value < y.value ? -1 : 1)),
      ).toEqual([
        { value: FIXTURE.shipperA, label: "Alfa Embarcador", count: 4 },
        { value: FIXTURE.shipperA2, label: "Alfa Filial", count: 1 },
      ]);
    });
  });

  describe("updateDelivery", () => {
    it("writes only from the expected status, and answers a missing row the same way", async () => {
      const h = harness();

      await expect(
        h.repo.updateDelivery(h.id("d5"), { notes: "x" }, "DELIVERED"),
      ).rejects.toBeInstanceOf(DeliveryStatusConflictError);
      await expect(
        h.repo.updateDelivery(MISSING, { notes: "x" }, "PENDING"),
      ).rejects.toBeInstanceOf(DeliveryStatusConflictError);

      const updated = await h.repo.updateDelivery(
        h.id("d5"),
        { notes: "Portão azul", city: undefined },
        "PENDING",
      );

      expect(updated).toMatchObject({
        notes: "Portão azul",
        city: "São Paulo",
      });
    });
  });

  describe("the detail", () => {
    it("carries the items as stored, the trail newest first, and the occurrences with their type", async () => {
      const h = harness();
      const detail = (await h.repo.findDeliveryDetailById(h.id("d1"))) as {
        items: Array<{
          description: string;
          quantity: unknown;
          unit: unknown;
          unit_value: unknown;
        }>;
        import: unknown;
        events: Array<{
          type: string;
          reason: { name: string } | null;
          reportedBy: { name: string } | null;
        }>;
        occurrences: Array<{
          id: string;
          description: string | null;
          photos: string[];
          occurrenceType: {
            name: string;
            blocks_delivery: boolean;
            form_fields: unknown;
          };
          reportedBy: { name: string } | null;
          authorizedBy: { name: string } | null;
        }>;
        vehicle: unknown;
      };

      expect(
        detail.items.map((item) => ({
          description: item.description,
          quantity: Number(item.quantity),
          unit: item.unit,
          unit_value: item.unit_value === null ? null : Number(item.unit_value),
        })),
      ).toEqual([
        { description: "Caixa", quantity: 2, unit: null, unit_value: 10.5 },
      ]);
      expect(detail.import).toBeNull();
      expect(detail.vehicle).toEqual({
        id: FIXTURE.vehicleA,
        license_plate: FIXTURE.plate,
      });

      expect(
        detail.events.map((event) => [
          event.type,
          event.reason?.name,
          event.reportedBy?.name,
        ]),
      ).toEqual([["STATUS_CHANGE", FIXTURE.reasonName, FIXTURE.userName]]);

      expect(
        detail.occurrences.map((occurrence) => ({
          id: occurrence.id,
          description: occurrence.description,
          photos: occurrence.photos,
          type: occurrence.occurrenceType.name,
          blocks: occurrence.occurrenceType.blocks_delivery,
          form: occurrence.occurrenceType.form_fields,
          reporter: occurrence.reportedBy?.name,
          decider: occurrence.authorizedBy?.name ?? null,
        })),
      ).toEqual([
        {
          id: h.occurrence("o-new"),
          description: "Lacre rompido",
          photos: [],
          type: FIXTURE.typeName,
          blocks: true,
          form: FIXTURE.formFields,
          reporter: FIXTURE.userName,
          decider: FIXTURE.deciderName,
        },
        {
          id: h.occurrence("o-old"),
          // An empty description is NULL, as the Prisma create stores it.
          description: null,
          photos: ["a.jpg", "b.jpg"],
          type: FIXTURE.typeName,
          blocks: true,
          form: FIXTURE.formFields,
          reporter: FIXTURE.userName,
          decider: null,
        },
      ]);
    });

    it("answers a missing delivery with null", async () => {
      expect(await harness().repo.findDeliveryDetailById(MISSING)).toBeNull();
    });
  });

  describe("occurrence and event writes", () => {
    it("refuse a delivery that does not exist (P2025)", async () => {
      const { repo } = harness();

      await expectPrismaCode(
        repo.createOccurrence({
          deliveryId: MISSING,
          occurrenceTypeId: FIXTURE.typeA,
          reportedById: FIXTURE.userA,
        }),
        "P2025",
      );
      await expectPrismaCode(
        repo.createDeliveryEvent({
          type: "STATUS_CHANGE",
          deliveryId: MISSING,
        }),
        "P2025",
      );
    });

    it("refuse a submission key already used (P2002) and find it only in its company", async () => {
      const h = harness();

      await expectPrismaCode(
        h.repo.createOccurrence({
          deliveryId: h.id("d2"),
          occurrenceTypeId: FIXTURE.typeA,
          reportedById: FIXTURE.userA,
          client_submission_id: "occ-sub-1",
        }),
        "P2002",
      );
      await expectPrismaCode(
        h.repo.createDeliveryEvent({
          type: "STATUS_CHANGE",
          deliveryId: h.id("d2"),
          client_submission_id: "evt-sub-1",
        }),
        "P2002",
      );

      expect(await h.repo.findOccurrenceBySubmissionId("occ-sub-1", A)).toEqual(
        {
          id: h.occurrence("o-new"),
          authorization_status: "APPROVED",
          category: "NOT_DELIVERED",
        },
      );
      expect(
        await h.repo.findOccurrenceBySubmissionId("occ-sub-1", B),
      ).toBeNull();
    });
  });

  describe("the exports", () => {
    const drain = async (rows: AsyncGenerator<Record<string, unknown>>) => {
      const out: Record<string, unknown>[] = [];
      for await (const row of rows) out.push(row);
      return out;
    };

    it("write the deliveries of the screen's filter in creation order, with names and the status in Portuguese", async () => {
      const h = harness();
      const rows = await drain(
        h.repo.streamDeliveriesForExport({
          businessId: A,
          search: "a",
          shipperIds: [FIXTURE.shipperA],
        }),
      );
      const tie = [h.id("d4"), h.id("d5")].sort();

      expect(rows.map((row) => row.id)).toEqual([
        ...ids(h, ["d1", "d3"]),
        ...tie,
      ]);
      expect(rows[0]).toEqual({
        id: h.id("d1"),
        code: "PED-1",
        invoice_key: SEED[0].data.invoice_key,
        invoice_number: "11",
        status: "Pendente",
        recipient_name: "Padaria Estrela",
        recipient_document: null,
        recipient_telephone: null,
        street: "Rua das Flores",
        address_number: null,
        neighborhood: null,
        city: "São Paulo",
        uf: "SP",
        cep: null,
        shipperName: "Alfa Embarcador",
        driverName: FIXTURE.driverName,
        vehiclePlate: FIXTURE.plate,
        routeCode: FIXTURE.routeCode,
        scheduled_date: null,
        delivered_at: null,
        received_by: null,
        notes: null,
      });
      expect(rows[1]).toMatchObject({
        driverName: FIXTURE.driverName,
        vehiclePlate: null,
        routeCode: null,
      });
    });

    it("never write another company's deliveries", async () => {
      const rows = await drain(
        harness().repo.streamDeliveriesForExport({ businessId: B }),
      );

      expect(rows.map((row) => row.recipient_name)).toEqual([
        "Padaria Estrela de B",
      ]);
    });

    it("write the occurrences in creation order with the type, the people and the decision", async () => {
      const h = harness();
      const rows = await drain(
        h.repo.streamOccurrencesForExport({ businessId: A, search: "avaria" }),
      );

      expect(rows).toEqual([
        {
          id: h.occurrence("o-old"),
          created_at: minute(10),
          typeName: FIXTURE.typeName,
          category: "Não entrega",
          blocking: "Sim",
          deliveryId: h.id("d1"),
          recipientName: "Padaria Estrela",
          city: "São Paulo",
          uf: "SP",
          reporterName: FIXTURE.userName,
          description: null,
          photoCount: 2,
          formAnswers: { fields: FIXTURE.formFields, answers: null },
          authorizationStatus: "NOT_REQUIRED",
          deciderName: null,
          decidedAt: null,
          decisionNote: null,
        },
        {
          id: h.occurrence("o-new"),
          created_at: minute(11),
          typeName: FIXTURE.typeName,
          category: "Não entrega",
          blocking: "Sim",
          deliveryId: h.id("d1"),
          recipientName: "Padaria Estrela",
          city: "São Paulo",
          uf: "SP",
          reporterName: FIXTURE.userName,
          description: "Lacre rompido",
          photoCount: 0,
          formAnswers: {
            fields: FIXTURE.formFields,
            answers: { lacre: "123" },
          },
          authorizationStatus: "APPROVED",
          deciderName: FIXTURE.deciderName,
          decidedAt: minute(12),
          decisionNote: null,
        },
      ]);

      expect(
        await drain(h.repo.streamOccurrencesForExport({ businessId: B })),
      ).toEqual([]);
    });
  });
}

export {
  FIXTURE as DELIVERY_FIXTURE,
  SEED as DELIVERY_SEED,
  deliveryRepositoryContract,
  seedThrough,
};
export type { DeliveryHarness };

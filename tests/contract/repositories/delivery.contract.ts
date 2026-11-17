import { describe, expect, it } from "vitest";

import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type {
  CreateDeliveryProps,
  CreateOccurrenceProps,
} from "@/modules/delivery/dtos/delivery-dto";
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { deliveryAddressKey } from "@/shared/delivery/address-key";
import { CLEARED_ADDRESS_POINT } from "@/shared/delivery/address-point";

import { expectPrismaCode, fixedId, minute, type Kind } from "../support";
import { withoutCreationLine } from "../../support/status-trail";

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
/** The point reuse's two companies, apart from the listing's seed. */
const C = fixedId("0d0a", 3);
const D = fixedId("0d0a", 4);

const FIXTURE = {
  A,
  B,
  C,
  D,
  shipperA: fixedId("0d5a", 1),
  shipperA2: fixedId("0d5a", 2),
  shipperB: fixedId("0d5b", 1),
  shipperC: fixedId("0d5c", 1),
  shipperD: fixedId("0d5d", 1),
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
        // The meeting of 14/10/2026: a stop to perform a service.
        kind: "SERVICE_ORDER",
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
      data: base({
        recipient_name: "Zebra Atacado",
        invoice_number: "",
        // A door of its own: at the others' they would take its point
        // (address-point-reuse.ts, 14/11/2026).
        address_number: "500",
        // Plan of 02/11/2026, E1: a point given at the create.
        latitude: -23.5505,
        longitude: -46.6333,
      }),
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

    it("stores a point given at the create as the MANUAL address point, and none otherwise", async () => {
      // Plan of 02/11/2026, E1: the geocoder's queue skips a row with a
      // point, so the source and the pair must be written together.
      const h = harness();
      const d4 = await h.repo.findDeliveryById(h.id("d4"));
      const d5 = await h.repo.findDeliveryById(h.id("d5"));

      expect(d5).toMatchObject({
        latitude: -23.5505,
        longitude: -46.6333,
        geo_source: "MANUAL",
        geo_precision: null,
      });
      expect(d5?.geo_updated_at).toBeInstanceOf(Date);
      expect(d4).toMatchObject({
        latitude: null,
        longitude: null,
        geo_source: null,
        geo_updated_at: null,
      });
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

    it("takes the point another delivery of the company has at the same door, as GEOCODER, never another company's", async () => {
      // Owner's report of 14/11/2026: the second delivery at an address the
      // company had located read "Sem localização".
      const { repo } = harness();
      const lipold = {
        recipient_name: "Destinatário",
        street: "Rua Doutor Lipold",
        address_number: "10",
        neighborhood: "Carangola",
        city: "Petrópolis",
        uf: "RJ",
        businessId: C,
        shipperId: FIXTURE.shipperC,
      };

      const pinned = await repo.createDelivery({
        ...lipold,
        latitude: -22.4561,
        longitude: -43.1702,
      });
      const second = await repo.createDelivery({
        ...lipold,
        street: "R. Dr. Lipold",
        cep: "25715000",
      });
      const elsewhere = await repo.createDelivery({
        ...lipold,
        businessId: D,
        shipperId: FIXTURE.shipperD,
      });

      expect(pinned).toMatchObject({
        geo_source: "MANUAL",
        address_key: deliveryAddressKey(lipold),
      });
      expect(await repo.findDeliveryById(second.id!)).toMatchObject({
        latitude: -22.4561,
        longitude: -43.1702,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
        geocode_status: "RESOLVED",
        address_key: deliveryAddressKey(lipold),
        // Where it came from: the pin's later changes reach it.
        geo_copied_from: pinned.id,
      });
      expect(pinned).toMatchObject({ geo_copied_from: null });
      expect(await repo.findDeliveryById(elsewhere.id!)).toMatchObject({
        latitude: null,
        geo_source: null,
        address_key: deliveryAddressKey(lipold),
      });
    });

    it("picks a pin over a newer point of the geocoder, leaves out the delivery being edited and never crosses companies", async () => {
      const { repo } = harness();
      const teresa = {
        recipient_name: "Destinatário",
        street: "Rua Teresa",
        address_number: "200",
        neighborhood: "Alto da Serra",
        city: "Petrópolis",
        uf: "RJ",
        businessId: C,
        shipperId: FIXTURE.shipperC,
      };
      const key = deliveryAddressKey(teresa)!;

      expect(await repo.findReusablePoint(C, key)).toBeNull();

      const found = await repo.createDelivery(teresa);

      await repo.updateDelivery(found.id!, {
        latitude: -22.5201,
        longitude: -43.1801,
        geo_source: "GEOCODER",
        geo_precision: "STREET",
        geocode_status: "RESOLVED",
        geo_updated_at: new Date("2030-01-01T00:00:00.000Z"),
      });

      expect(await repo.findReusablePoint(C, key)).toMatchObject({
        latitude: -22.5201,
        geo_source: "GEOCODER",
        geo_precision: "STREET",
        geocode_status: "RESOLVED",
      });

      const pinned = await repo.createDelivery({
        ...teresa,
        latitude: -22.5205,
        longitude: -43.1805,
      });

      expect(await repo.findReusablePoint(C, key)).toMatchObject({
        latitude: -22.5205,
        longitude: -43.1805,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
      });
      expect(await repo.findReusablePoint(C, key, pinned.id)).toMatchObject({
        latitude: -22.5201,
      });
      expect(await repo.findReusablePoint(D, key)).toBeNull();
    });

    it("names the root of a copy of a copy, takes its own point back as its own, and lends nothing its root dropped", async () => {
      // Pre-push review of the batch of 14/11/2026: a copy tied to nothing
      // stayed wrong for good once its source's pin moved or went.
      const { repo } = harness();
      const senna = {
        recipient_name: "Destinatário",
        street: "Avenida Ayrton Senna",
        address_number: "300",
        neighborhood: "Quitandinha",
        city: "Petrópolis",
        uf: "RJ",
        businessId: C,
        shipperId: FIXTURE.shipperC,
      };
      const key = deliveryAddressKey(senna)!;
      const found = {
        latitude: -22.5301,
        longitude: -43.2101,
        geo_source: "GEOCODER" as const,
        geo_precision: "STREET" as const,
        geocode_status: "RESOLVED" as const,
      };

      // The geocoder's own answer, older than the copies made from it.
      const root = await repo.createDelivery(senna);

      await repo.updateDelivery(root.id!, {
        ...found,
        geo_updated_at: new Date("2020-01-01T00:00:00.000Z"),
      });

      const copy = await repo.createDelivery(senna);
      // The newest point of the door is the copy's: still named by its root.
      const copyOfCopy = await repo.createDelivery(senna);

      for (const taken of [copy, copyOfCopy]) {
        expect(await repo.findDeliveryById(taken.id!)).toMatchObject({
          latitude: -22.5301,
          geo_source: "GEOCODER",
          geo_copied_from: root.id,
        });
      }

      // The root's address edited back to this door takes its own point.
      expect(await repo.findReusablePoint(C, key, root.id)).toMatchObject({
        latitude: -22.5301,
        geo_copied_from: null,
      });

      // The root's point gone: its copies lend nothing, and a write of one
      // of them as a copy is refused at the write.
      await repo.updateDelivery(root.id!, {
        latitude: null,
        longitude: null,
        geo_source: null,
      });

      expect(await repo.findReusablePoint(C, key)).toBeNull();
      expect(await repo.findReusablePoint(D, key)).toBeNull();

      const stale = await repo.createDelivery({
        ...senna,
        address_number: "302",
      });
      const asCopy = {
        ...CLEARED_ADDRESS_POINT,
        ...found,
        geo_precision: "ADDRESS" as const,
        geo_updated_at: new Date(),
        geo_copied_from: root.id!,
      };

      expect(await repo.updateDelivery(stale.id!, asCopy)).toMatchObject({
        latitude: null,
        geo_source: null,
        geo_copied_from: null,
      });

      // Back again: the write takes it, with its root.
      await repo.updateDelivery(root.id!, found);

      expect(await repo.updateDelivery(stale.id!, asCopy)).toMatchObject({
        latitude: -22.5301,
        geo_source: "GEOCODER",
        geo_copied_from: root.id,
      });
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
    // facets=skip (plano-escala F2-30): the same rows, nothing counted.
    it("with skipFacets returns the same page and no count", async () => {
      const counted = await list({ page: 2, pageSize: 2 });
      const skipped = await list({ page: 2, pageSize: 2, skipFacets: true });

      expect(skipped.data.map((row) => row.id)).toEqual(
        counted.data.map((row) => row.id),
      );
      expect(skipped).toMatchObject({
        statusCounts: [],
        shipperOptions: [],
        driverOptions: [],
        facetsSkipped: true,
      });
      expect(counted.facetsSkipped).toBeUndefined();
      expect(counted.statusCounts.length).toBeGreaterThan(0);
    });

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

    it("keeps [createdFrom, createdTo) of created_at, and counts only those rows", async () => {
      const h = harness();
      // d2 at minute 2 and d3 at minute 3; minute 4 is outside (exclusive).
      const page = await list({ createdFrom: minute(2), createdTo: minute(4) });

      expect(page.data.map((row) => row.id).sort()).toEqual(
        ids(h, ["d2", "d3"]).sort(),
      );
      expect(page.periodApplied).toBe(true);
      expect(page.statusCounts).toEqual([{ value: "PENDING", count: 2 }]);
      expect(
        [...page.shipperOptions].sort((x, y) => (x.value < y.value ? -1 : 1)),
      ).toEqual([
        { value: FIXTURE.shipperA, label: "Alfa Embarcador", count: 1 },
        { value: FIXTURE.shipperA2, label: "Alfa Filial", count: 1 },
      ]);
      // Without a period nothing is narrowed, and nothing says it was.
      expect((await list()).periodApplied).toBe(false);
    });

    it("sets the period aside for an exact id, order code or NF-e key, never for a partial term or another company's id", async () => {
      const h = harness();
      // d3, d4 and d5 only: d1 lies outside.
      const outside = { createdFrom: minute(3), createdTo: minute(5) };
      const found = async (search: string) => {
        const page = await list({ ...outside, search });
        return {
          ids: page.data.map((row) => row.id).sort(),
          periodApplied: page.periodApplied,
        };
      };

      for (const search of [
        h.id("d1"),
        h.id("d1").toUpperCase(),
        "ped-1",
        SEED[0].data.invoice_key!,
      ]) {
        expect(await found(search)).toEqual({
          ids: [h.id("d1")],
          periodApplied: false,
        });
      }

      expect(await found("Padaria")).toEqual({ ids: [], periodApplied: true });
      expect(await found(h.id("b1"))).toEqual({ ids: [], periodApplied: true });
    });

    it("filters by type, and a create without one is a delivery", async () => {
      const h = harness();

      expect(
        (await list({ kinds: ["SERVICE_ORDER"] })).data.map((row) => row.id),
      ).toEqual([h.id("d3")]);
      expect((await list({ kinds: ["PICKUP"] })).data).toEqual([]);
      expect(await h.repo.findDeliveryById(h.id("d1"))).toMatchObject({
        kind: "DELIVERY",
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

    it("reads back the item list as stored, and none for a delivery without items (K9)", async () => {
      const h = harness();

      expect(await h.repo.findDeliveryItems(h.id("d1"))).toEqual([
        { description: "Caixa", quantity: 2, unit: null, unit_value: 10.5 },
      ]);
      expect(await h.repo.findDeliveryItems(MISSING)).toEqual([]);
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
          status_from: string | null;
          status_to: string | null;
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

      // The creation line (F2-06), and the status change with its reason.
      expect(
        detail.events.filter(
          (event) =>
            event.type === "STATUS_CHANGE" &&
            event.status_from === null &&
            event.status_to === "PENDING",
        ),
      ).toHaveLength(1);
      expect(
        withoutCreationLine(detail.events).map((event) => [
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
          deliveryId: h.id("d1"),
          authorization_status: "APPROVED",
          category: "NOT_DELIVERED",
        },
      );
      expect(
        await h.repo.findOccurrenceBySubmissionId("occ-sub-1", B),
      ).toBeNull();
    });

    // plano-escala F2-14: the Prisma side answers from
    // delivery_event_submission, the twin from its own list; same answer.
    it("find an event by its submission key in its company only", async () => {
      const h = harness();

      expect(
        await h.repo.findEventBySubmissionId("evt-sub-1", A),
      ).toMatchObject({
        type: "STATUS_CHANGE",
        deliveryId: h.id("d1"),
        client_submission_id: "evt-sub-1",
      });
      expect(await h.repo.findEventBySubmissionId("evt-sub-1", B)).toBeNull();
      expect(await h.repo.findEventBySubmissionId("nope", A)).toBeNull();
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
        kind: "Entrega",
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
        kind: "Ordem de serviço",
        driverName: FIXTURE.driverName,
        vehiclePlate: null,
        routeCode: null,
      });
    });

    it("write only the period's rows, unless the search is exactly one document", async () => {
      const h = harness();
      const period = {
        businessId: A,
        createdFrom: minute(3),
        createdTo: minute(5),
      };

      const inPeriod = await drain(h.repo.streamDeliveriesForExport(period));
      const exact = await drain(
        h.repo.streamDeliveriesForExport({ ...period, search: "ped-1" }),
      );

      expect(inPeriod.map((row) => row.id).sort()).toEqual(
        ids(h, ["d3", "d4", "d5"]).sort(),
      );
      expect(exact.map((row) => row.id)).toEqual([h.id("d1")]);
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

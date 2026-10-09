import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";
import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import { ImportDeliveryXmlUseCase } from "@/modules/delivery/usecases/import-delivery-xml/import-delivery-xml-usecase";
import { AssignDeliveriesUseCase } from "@/modules/delivery/usecases/assign-deliveries/assign-deliveries-usecase";
import { ReportDeliveryOccurrenceUseCase } from "@/modules/delivery/usecases/report-delivery-occurrence/report-delivery-occurrence-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/in-memory/in-memory-occurrence-authorization-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { businessWithoutAI } from "../../support/delivery-proof-usecases";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { UploadService } from "@/shared/services/upload-service";

// The socket transport is a boundary these tests do not look at.
vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendDeliveryStatusToBusiness: vi.fn(),
  sendRouteEventToBusiness: vi.fn(),
  sendCatalogChangedEvent: vi.fn(),
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * The delivery writes check the caller's own company, not only the route.
 *
 * Each of these use cases compared the delivery's company with the company in
 * the request, and never the caller's company with either. An admin of
 * company B sending businessId=A (plus an id from A) was stopped only by the
 * preHandler guard: with that guard missing or regressed, B created, edited,
 * re-statused or imported deliveries inside A.
 */
const ALFA = "018f4100-0000-7000-8000-0000000000a0";
const BETA = "018f4100-0000-7000-8000-0000000000b0";
const ALFA_ADMIN = "018f4100-0000-7000-8000-0000000000a1";
const BETA_ADMIN = "018f4100-0000-7000-8000-0000000000b1";
const MASTER = "018f4100-0000-7000-8000-0000000000f1";
const SHIPPER = "018f4100-0000-7000-8000-0000000000c1";
const REASON = "018f4100-0000-7000-8000-0000000000e1";

const KEY = "35240612345678000199550010000012341000012345";

const DENIED = { statusCode: 403, code: "TENANT_ACCESS_DENIED" };

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let shippers: InMemoryShipperRepository;
let deliveries: InMemoryDeliveryRepository;
let imports: InMemoryImportRepository;

const notifications = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  shippers = new InMemoryShipperRepository();
  deliveries = new InMemoryDeliveryRepository();
  imports = new InMemoryImportRepository();

  users.user.push(
    { id: ALFA_ADMIN, role: "BUSINESS_ADMIN", businessId: ALFA } as User,
    { id: BETA_ADMIN, role: "BUSINESS_ADMIN", businessId: BETA } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );

  businesses.business.push(
    { ...BUSINESS_COLUMN_DEFAULTS, id: ALFA } as Business,
    { ...BUSINESS_COLUMN_DEFAULTS, id: BETA } as Business,
  );

  shippers.shippers.push({
    id: SHIPPER,
    name: "Indústria",
    businessId: ALFA,
    is_active: true,
  } as Shipper);
});

const createUseCase = () =>
  new CreateDeliveryUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    notifications,
    new InMemoryWebhookFanOutService().asService(),
  );

function statusUseCase() {
  const reasons = new InMemoryStatusChangeReasonRepository();

  reasons.statusChangeReasons.push({
    id: REASON,
    name: "Cliente desistiu",
    description: null,
    is_active: true,
    businessId: ALFA,
  });

  return new UpdateDeliveryStatusUseCase(
    users,
    deliveries,
    new InMemoryRouteRepository(),
    reasons,
    notifications,
    { publish: async () => undefined } as unknown as OutboxService,
    new InMemoryWebhookFanOutService().asService(),
  );
}

const importUseCase = () =>
  new ImportDeliveryXmlUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    notifications,
    new InMemoryWebhookFanOutService().asService(),
    imports,
  );

const deliveryOf = (businessId: string) =>
  ({
    businessId,
    shipperId: SHIPPER,
    recipient_name: "Mercado Central",
    city: "Campinas",
    uf: "SP",
    street: "Rua Um",
  }) as CreateDeliveryProps;

async function seedAlfaDelivery(): Promise<string> {
  const created = await deliveries.createDelivery(deliveryOf(ALFA));

  return created.id!;
}

function nfe(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>${accessKey.slice(-6)}</nNF></ide>
      <emit><CNPJ>12345678000199</CNPJ><xNome>Industria Alimentos LTDA</xNome></emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Central</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr><nro>450</nro><xBairro>Centro</xBairro>
          <xMun>Campinas</xMun><UF>SP</UF><CEP>13010000</CEP>
        </enderDest>
      </dest>
      <det nItem="1"><prod><xProd>Caixa</xProd><qCom>1.0000</qCom><uCom>CX</uCom><vUnCom>4.5000</vUnCom></prod></det>
    </infNFe>
  </NFe>
</nfeProc>`;
}

describe("CreateDeliveryUseCase", () => {
  it("refuses an admin of another company creating inside this one (403)", async () => {
    await expect(createUseCase().execute(deliveryOf(ALFA), BETA_ADMIN)).rejects.toMatchObject(DENIED);

    expect(deliveries.deliveries).toHaveLength(0);
  });

  it("lets the MASTER create in any company", async () => {
    const created = await createUseCase().execute(deliveryOf(ALFA), MASTER);

    expect(created.businessId).toBe(ALFA);
    expect(deliveries.deliveries).toHaveLength(1);
  });
});

describe("UpdateDeliveryUseCase", () => {
  const edit = (userId: string, deliveryId: string) =>
    new UpdateDeliveryUseCase(users, shippers, deliveries).execute({
      userId,
      businessId: ALFA,
      deliveryId,
      deliveryData: { street: "Rua Dois" },
    });

  it("refuses an admin of another company editing this company's delivery (403)", async () => {
    const id = await seedAlfaDelivery();

    await expect(edit(BETA_ADMIN, id)).rejects.toMatchObject(DENIED);

    expect(deliveries.deliveries[0].street).toBe("Rua Um");
  });

  it("lets the MASTER and the company's own admin edit", async () => {
    const id = await seedAlfaDelivery();

    await expect(edit(MASTER, id)).resolves.toMatchObject({ street: "Rua Dois" });
    await expect(edit(ALFA_ADMIN, id)).resolves.toMatchObject({ street: "Rua Dois" });
  });
});

describe("UpdateDeliveryStatusUseCase", () => {
  const cancel = (userId: string, deliveryId: string) =>
    statusUseCase().execute({
      userId,
      businessId: ALFA,
      deliveryId,
      status: "CANCELLED",
      reasonId: REASON,
    });

  it("refuses an admin of another company changing this company's delivery (403)", async () => {
    const id = await seedAlfaDelivery();

    await expect(cancel(BETA_ADMIN, id)).rejects.toMatchObject(DENIED);

    expect(deliveries.deliveries[0].status).toBe("PENDING");
  });

  it("lets the MASTER change the status", async () => {
    const id = await seedAlfaDelivery();

    await expect(cancel(MASTER, id)).resolves.toMatchObject({ status: "CANCELLED" });
  });
});

describe("ImportDeliveryXmlUseCase", () => {
  const importing = (userId: string) =>
    importUseCase().execute({
      userId,
      businessId: ALFA,
      files: [{ filename: `${KEY}.xml`, content: nfe(KEY) }],
    });

  it("refuses an admin of another company importing into this one (403)", async () => {
    await expect(importing(BETA_ADMIN)).rejects.toMatchObject(DENIED);

    expect(deliveries.deliveries).toHaveLength(0);
    expect(imports.imports).toHaveLength(0);
  });

  it("lets the MASTER import into any company", async () => {
    const summary = await importing(MASTER);

    expect(summary.importId).toBeDefined();
    expect(deliveries.deliveries).toHaveLength(1);
    expect(deliveries.deliveries[0].businessId).toBe(ALFA);
  });
});

describe("AssignDeliveriesUseCase", () => {
  // The refusal comes before any route is read or built, so the route
  // collaborators are never reached; the same-company path is the subject of
  // assign-deliveries.test.ts on the full in-memory stack.
  it("refuses an admin of another company assigning this company's deliveries (403)", async () => {
    const routes = new InMemoryRouteRepository();
    const id = await seedAlfaDelivery();
    const unreachable = {} as never;

    await expect(
      new AssignDeliveriesUseCase(users, routes, unreachable, unreachable, unreachable, unreachable).execute({
        userId: BETA_ADMIN,
        businessId: ALFA,
        deliveryIds: [id],
        driverId: "018f4100-0000-7000-8000-0000000000d1",
        vehicleId: "018f4100-0000-7000-8000-0000000000d2",
      }),
    ).rejects.toMatchObject(DENIED);

    expect(routes.routes).toHaveLength(0);
    expect(deliveries.deliveries[0].driverId ?? null).toBeNull();
  });
});

describe("ReportDeliveryOccurrenceUseCase", () => {
  it("refuses a dispatcher of another company reporting on this company's delivery (403)", async () => {
    const types = new InMemoryOccurrenceTypeRepository();
    const routes = new InMemoryRouteRepository();
    const type = await types.createOccurrenceType({
      businessId: ALFA,
      name: "Cliente ausente",
      blocks_delivery: false,
      requires_authorization: false,
      form_fields: [],
    });
    const id = await seedAlfaDelivery();

    deliveries.deliveries[0].status = "IN_TRANSIT";

    const report = new ReportDeliveryOccurrenceUseCase(
      users,
      types,
      deliveries,
      routes,
      notifications,
      {
        resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
          photos.map(({ key }) => ({ path: key })),
        getFileUrl: async (key: string) => `https://signed/${key}`,
      } as unknown as UploadService,
      { publish: async () => undefined } as unknown as OutboxService,
      new InMemoryWebhookFanOutService().asService(),
      new InMemoryOccurrenceAuthorizationRepository(deliveries, types, users),
      new InMemoryProofAuditRepository(),
      businessWithoutAI,
    );

    await expect(
      report.execute({
        userId: BETA_ADMIN,
        businessId: ALFA,
        deliveryId: id,
        occurrenceTypeId: type.id!,
        description: "Ninguém atendeu",
      }),
    ).rejects.toMatchObject(DENIED);

    expect(deliveries.occurrences).toHaveLength(0);
  });
});

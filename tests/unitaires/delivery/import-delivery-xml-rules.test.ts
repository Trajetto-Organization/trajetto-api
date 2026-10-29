import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import { ImportDeliveryXmlUseCase } from "@/modules/delivery/usecases/import-delivery-xml/import-delivery-xml-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const catalogChanged = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalogChanged }));

/**
 * The NF-e XML import (decisions 5.6 and 5.7).
 *
 * It used to write no Importações row (so it could not be listed, reported or
 * reversed), accepted a deactivated shipper forced or matched by CNPJ, merged
 * a matriz and a filial with the same corporate name, and lost a file to a
 * P2002 when two uploads created the same issuer at once.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000009b1";
const DISPATCHER = "018f0000-0000-7000-8000-0000000009a1";

const ISSUER_CNPJ = "12345678000199";

const KEY_ONE = "35240612345678000199550010000012341000012345";
const KEY_TWO = "35240612345678000199550010000012351000012346";

function nfe(accessKey: string, issuerCnpj = ISSUER_CNPJ): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>${accessKey.slice(-6)}</nNF></ide>
      <emit>
        <CNPJ>${issuerCnpj}</CNPJ>
        <xNome>Industria Alimentos LTDA</xNome>
      </emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Central</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr>
          <nro>450</nro>
          <xBairro>Centro</xBairro>
          <xMun>Campinas</xMun>
          <UF>SP</UF>
          <CEP>13010000</CEP>
        </enderDest>
      </dest>
      <det nItem="1">
        <prod>
          <xProd>Caixa de leite integral 1L</xProd>
          <qCom>120.0000</qCom>
          <uCom>CX</uCom>
          <vUnCom>4.5000</vUnCom>
        </prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>`;
}

let shippers: InMemoryShipperRepository;
let deliveries: InMemoryDeliveryRepository;
let imports: InMemoryImportRepository;
let importXml: ImportDeliveryXmlUseCase;

beforeEach(() => {
  catalogChanged.mockReset();

  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();

  shippers = new InMemoryShipperRepository();
  deliveries = new InMemoryDeliveryRepository();
  imports = new InMemoryImportRepository();

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
  } as Business);

  importXml = new ImportDeliveryXmlUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
    new InMemoryWebhookFanOutService().asService(),
    imports,
  );
});

function importing(keys: string[], extra: { shipperId?: string } = {}) {
  return importXml.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    files: keys.map((key) => ({ filename: `${key}.xml`, content: nfe(key) })),
    ...extra,
  });
}

describe("an XML upload is an Importações row", () => {
  it("records the upload as NFE_XML, closed with a per-file report", async () => {
    const summary = await importing([KEY_ONE, KEY_TWO]);

    expect(imports.imports).toHaveLength(1);

    const [record] = imports.imports;

    expect(summary.importId).toBe(record.id);
    expect(record).toMatchObject({
      source: "NFE_XML",
      status: "COMPLETED",
      filename: `${KEY_ONE}.xml e mais 1 arquivo`,
      imported: 2,
      duplicated: 0,
      invalid: 0,
      businessId: BUSINESS,
      performedById: DISPATCHER,
    });

    expect(record.report.rows.map((row) => row.reference)).toEqual([
      KEY_ONE,
      KEY_TWO,
    ]);
  });

  it("stamps the upload on every delivery it created, so it can be reversed", async () => {
    const summary = await importing([KEY_ONE, KEY_TWO]);

    expect(deliveries.deliveries).toHaveLength(2);

    for (const delivery of deliveries.deliveries) {
      expect(delivery.importId).toBe(summary.importId);
    }
  });

  it("records an upload that created nothing too (the operator needs the report)", async () => {
    await importing([KEY_ONE]);
    await importing([KEY_ONE]);

    expect(imports.imports).toHaveLength(2);
    expect(imports.imports[1]).toMatchObject({ imported: 0, duplicated: 1 });
  });
});

describe("a deactivated shipper takes no new notes", () => {
  it("refuses the whole upload when the forced shipper is deactivated", async () => {
    shippers.shippers.push({
      id: "018f0000-0000-7000-8000-0000000009f1",
      name: "Embarcador antigo",
      businessId: BUSINESS,
      is_active: false,
    } as Shipper);

    await expect(
      importing([KEY_ONE], {
        shipperId: "018f0000-0000-7000-8000-0000000009f1",
      }),
    ).rejects.toMatchObject({ code: "SHIPPER_INACTIVE" });

    expect(deliveries.deliveries).toEqual([]);
    expect(imports.imports).toEqual([]);
  });

  it("marks the note invalid when its issuer is a deactivated shipper", async () => {
    shippers.shippers.push({
      id: "018f0000-0000-7000-8000-0000000009f2",
      name: "Industria Alimentos LTDA",
      cnpj: ISSUER_CNPJ,
      businessId: BUSINESS,
      is_active: false,
    } as Shipper);

    const summary = await importing([KEY_ONE]);

    expect(summary.invalid).toBe(1);
    expect(summary.results[0].message).toContain("está desativado");
    expect(deliveries.deliveries).toEqual([]);

    // Not created again under the same name either.
    expect(shippers.shippers).toHaveLength(1);
  });
});

describe("matching the issuer", () => {
  it("does not merge a filial into a shipper of the same name with another CNPJ", async () => {
    shippers.shippers.push({
      id: "018f0000-0000-7000-8000-0000000009f3",
      name: "Industria Alimentos LTDA",
      cnpj: "11222333000181",
      businessId: BUSINESS,
      is_active: true,
    } as Shipper);

    const summary = await importing([KEY_ONE]);

    // The name is taken by another fiscal identity: the operator chooses.
    expect(summary.invalid).toBe(1);
    expect(summary.results[0].message).toContain("outro CNPJ");
    expect(deliveries.deliveries).toEqual([]);
  });

  it("uses a same-name shipper registered without a CNPJ", async () => {
    shippers.shippers.push({
      id: "018f0000-0000-7000-8000-0000000009f4",
      name: "Industria Alimentos LTDA",
      cnpj: null,
      businessId: BUSINESS,
      is_active: true,
    } as Shipper);

    const summary = await importing([KEY_ONE]);

    expect(summary.imported).toBe(1);
    expect(deliveries.deliveries[0].shipperId).toBe(
      "018f0000-0000-7000-8000-0000000009f4",
    );
  });

  it("keeps the file when a concurrent upload created the issuer first (P2002)", async () => {
    const winner = {
      id: "018f0000-0000-7000-8000-0000000009f5",
      name: "Industria Alimentos LTDA",
      cnpj: ISSUER_CNPJ,
      businessId: BUSINESS,
      is_active: true,
    } as Shipper;

    // The read sees nothing; by the insert, the other replica committed.
    vi.spyOn(shippers, "createShipper").mockImplementationOnce(async () => {
      shippers.shippers.push(winner);

      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["businessId", "cnpj"] },
      });
    });

    const summary = await importing([KEY_ONE]);

    expect(summary.imported).toBe(1);
    expect(deliveries.deliveries[0].shipperId).toBe(winner.id);
  });

  it("tells the open screens when it created a shipper", async () => {
    await importing([KEY_ONE]);

    expect(catalogChanged).toHaveBeenCalledWith(BUSINESS, "shipper");
  });

  it("stays quiet when every issuer already existed", async () => {
    shippers.shippers.push({
      id: "018f0000-0000-7000-8000-0000000009f6",
      name: "Industria Alimentos LTDA",
      cnpj: ISSUER_CNPJ,
      businessId: BUSINESS,
      is_active: true,
    } as Shipper);

    await importing([KEY_ONE]);

    expect(catalogChanged).not.toHaveBeenCalled();
  });
});

/**
 * Decision 14.8: the proof document prints the issuer's legal name
 * ("Razão Social Emitente"). The NF-e's emit/xNome IS that name, so a
 * shipper created from a note keeps it; until then the PDF falls back to
 * the shipper's display name.
 */
describe("a shipper created from a note", () => {
  it("keeps the issuer's legal name from emit/xNome", async () => {
    await importing([KEY_ONE]);

    expect(shippers.shippers).toHaveLength(1);
    expect(shippers.shippers[0]).toMatchObject({
      name: "Industria Alimentos LTDA",
      corporate_reason: "Industria Alimentos LTDA",
    });
  });
});

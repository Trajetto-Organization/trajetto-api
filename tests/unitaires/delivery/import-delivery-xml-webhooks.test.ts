import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * The NF-e import is how most documents enter the operation, and it never
 * told anybody: `delivery.created` was announced by the single-delivery form
 * only. A carrier importing three hundred invoices left the ERP subscribed to
 * `delivery.created` with nothing — no id to match, no event to act on.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000040a";
const DISPATCHER = "018f0000-0000-7000-8000-0000000004a1";

const notificationService = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

/** The Sefaz layout, one invoice per key. */
function nfe(accessKey: string, recipient: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>${accessKey.slice(-6)}</nNF></ide>
      <emit>
        <CNPJ>12345678000199</CNPJ>
        <xNome>Industria Alimentos LTDA</xNome>
      </emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>${recipient}</xNome>
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

const KEY_ONE = "35240612345678000199550010000012341000012345";
const KEY_TWO = "35240612345678000199550010000012351000012346";

let webhooks: InMemoryWebhookFanOutService;
let deliveries: InMemoryDeliveryRepository;
let importXml: ImportDeliveryXmlUseCase;

beforeEach(() => {
  webhooks = new InMemoryWebhookFanOutService();
  deliveries = new InMemoryDeliveryRepository();

  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const shippers = new InMemoryShipperRepository();

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
    notificationService,
    webhooks.asService(),
    new InMemoryImportRepository(),
  );
});

function importing(files: Array<[string, string]>) {
  return importXml.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    files: files.map(([key, recipient]) => ({
      filename: `${key}.xml`,
      content: nfe(key, recipient),
    })),
  });
}

describe("importing NF-e files", () => {
  it("announces each delivery it creates, with the key, in the write's transaction", async () => {
    const summary = await importing([
      [KEY_ONE, "Mercado Central ME"],
      [KEY_TWO, "Padaria Estrela"],
    ]);

    expect(summary.imported).toBe(2);

    const created = webhooks.forTopic("delivery.created");

    expect(created).toHaveLength(2);

    expect(created.map((event) => event.payload.invoice_key).sort()).toEqual(
      [KEY_ONE, KEY_TWO].sort(),
    );

    const ids = deliveries.deliveries.map((delivery) => delivery.id).sort();

    expect(created.map((event) => event.payload.delivery_id).sort()).toEqual(
      ids,
    );

    for (const event of created) {
      expect(event.businessId).toBe(BUSINESS);
      expect(event.transactional).toBe(true);
    }
  });

  it("announces nothing for a file it did not create a delivery from", async () => {
    await importing([[KEY_ONE, "Mercado Central ME"]]);

    webhooks.reset();

    // The same note again, and a file that is not an NF-e.
    const summary = await importXml.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      files: [
        { filename: "again.xml", content: nfe(KEY_ONE, "Mercado Central ME") },
        { filename: "broken.xml", content: "<nada/>" },
      ],
    });

    expect(summary.duplicated).toBe(1);
    expect(summary.invalid).toBe(1);

    expect(webhooks.forTopic("delivery.created")).toHaveLength(0);
  });
});

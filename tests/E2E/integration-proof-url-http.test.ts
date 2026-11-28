import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { generateApiKey } from "@/shared/integration/api-key-rules";
import { proofLinkToken, proofLinkUrl } from "@/shared/integration/proof-link";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * `proof_url` end to end (plan of 02/11/2026, L7; ADR 0009): the public read
 * hands it out once the delivery ended, and opening it — no login, no key —
 * produces the very document the panel would, then redirects to the file.
 * Every link that is not genuine, current and for an ended delivery is the
 * same 404, and a link signed for another company opens nothing.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe510-0000-7000-8000-00000000000a";
const OTHER = "018fe510-0000-7000-8000-00000000000b";
const SHIPPER = "018fe510-0000-7000-8000-0000000000e1";

let readKey = "";
let deliveredId = "";
let inTransitId = "";

async function seedBusiness(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(60000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `proof-url-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["deliveries:read"],
      businessId: CARRIER,
    },
  });

  readKey = key.token;

  const delivered = await prisma.delivery.create({
    data: {
      recipient_name: "Padaria Central Ltda",
      invoice_number: "777",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      status: "DELIVERED",
      delivered_at: new Date(),
      received_by: "Maria Souza",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  deliveredId = delivered.id;

  await prisma.deliveryEvent.create({
    data: {
      type: "PROOF",
      deliveryId: delivered.id,
      businessId: CARRIER,
      actor: "DRIVER_APP",
      received_by: "Maria Souza",
      client_submission_id: randomUUID(),
    },
  });

  const inTransit = await prisma.delivery.create({
    data: {
      recipient_name: "Ainda na rua",
      city: "São Paulo",
      uf: "SP",
      street: "Avenida Paulista",
      status: "IN_TRANSIT",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  inTransitId = inTransit.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const readDelivery = (id: string) =>
  app.inject({
    method: "GET",
    url: `/integration/v1/deliveries/${id}`,
    headers: { authorization: `Bearer ${readKey}` },
  });

/** The path of a proof link on this API, whatever origin it was minted with. */
const openLink = (url: string) =>
  app.inject({ method: "GET", url: new URL(url).pathname });

describe("proof_url on the public read", () => {
  it("is the delivery's link once it ended, and null while it is open", async () => {
    const delivered = await readDelivery(deliveredId);

    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json().proof_url).toBe(proofLinkUrl(deliveredId, CARRIER));

    const open = await readDelivery(inTransitId);

    expect(open.json().proof_url).toBeNull();

    // Stable: the same link on every read, so a diffing ERP sees no change.
    expect((await readDelivery(deliveredId)).json().proof_url).toBe(
      delivered.json().proof_url,
    );
  });
});

describe("opening proof_url", () => {
  it("produces the document on the first opening and redirects to the file", async () => {
    const { proof_url } = (await readDelivery(deliveredId)).json();

    const response = await openLink(proof_url);

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBeTruthy();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");

    const stored = await prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId: deliveredId },
    });

    expect(stored.businessId).toBe(CARRIER);

    // The second opening reuses it: no new render, the same document.
    const again = await openLink(proof_url);

    expect(again.statusCode).toBe(302);
    expect(
      (
        await prisma.deliveryProofDocument.findUniqueOrThrow({
          where: { deliveryId: deliveredId },
        })
      ).sha256,
    ).toBe(stored.sha256);
  }, 60_000);

  it("answers the same 404 to a forged, foreign, malformed or premature link", async () => {
    const links = [
      // Signed for another company: never opens this company's document.
      `/public/delivery-proof/${proofLinkToken(deliveredId, OTHER)}`,
      // A genuine link of a delivery that has not ended.
      `/public/delivery-proof/${proofLinkToken(inTransitId, CARRIER)}`,
      // A delivery that does not exist.
      `/public/delivery-proof/${proofLinkToken(randomUUID(), CARRIER)}`,
      "/public/delivery-proof/lixo",
      `/public/delivery-proof/${deliveredId}.${"A".repeat(43)}`,
    ];

    for (const url of links) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode, url).toBe(404);
      expect(response.json().code, url).toBe("PROOF_NOT_FOUND");
    }

    expect(
      await prisma.deliveryProofDocument.count({
        where: { deliveryId: inTransitId },
      }),
    ).toBe(0);
  });
});

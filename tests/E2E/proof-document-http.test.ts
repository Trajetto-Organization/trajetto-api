import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The receipt, end to end: generated on first request, stored, hashed, and
 * confirmed by a stranger holding the printed code.
 *
 * What only this file can prove is that the hash means anything. The unit
 * suite renders bytes and hashes them in the same breath, which would pass
 * even if nothing were ever written anywhere — here the file goes to storage,
 * comes back out of storage, and the public page compares what it found
 * against what was recorded. That comparison is the whole feature.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f4000-0000-7000-8000-00000000000a";
const OTHER = "018f4000-0000-7000-8000-00000000000b";

const SHIPPER = "018f4000-0000-7000-8000-0000000000f1";
const DRIVER = "018f4000-0000-7000-8000-0000000000d1";

let token: string;
let otherToken: string;

let deliveredId: string;
let pendingId: string;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      fantasy_name: "Silva Log",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(11222777000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedUser(businessId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${DRIVER}-cnh`,
      cpf: `${DRIVER}-cpf`,
      rg: `${DRIVER}-rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Distribuidora Norte", businessId: CARRIER },
  });

  token = await seedUser(CARRIER);
  otherToken = await seedUser(OTHER);

  const delivered = await prisma.delivery.create({
    data: {
      recipient_name: "Padaria Central Ltda",
      invoice_number: "12345",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      address_number: "100",
      status: "DELIVERED",
      delivered_at: new Date(),
      received_by: "Maria Souza",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: DRIVER,
    },
  });

  deliveredId = delivered.id;

  // The proof event the document describes. No photo key: the bucket is not
  // seeded here, and a missing picture must not cost the customer the receipt.
  await prisma.deliveryEvent.create({
    data: {
      type: "PROOF",
      deliveryId: delivered.id,
      actor: "DRIVER_APP",
      device: "Moto G84 (Android 14)",
      latitude: -23.550519,
      longitude: -46.633308,
      received_by: "Maria Souza",
      client_submission_id: randomUUID(),
    },
  });

  const pending = await prisma.delivery.create({
    data: {
      recipient_name: "Ainda na rua",
      city: "São Paulo",
      uf: "SP",
      street: "Avenida Paulista",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  pendingId = pending.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function fetchProof(deliveryId: string, as = token, query = "") {
  return app.inject({
    method: "GET",
    url: `/delivery/proof-document/${deliveryId}/business/${
      as === otherToken ? OTHER : CARRIER
    }${query}`,
    headers: { authorization: `Bearer ${as}` },
  });
}

describe("producing the receipt", () => {
  it("generates it on the first request and stores the hash", async () => {
    const response = await fetchProof(deliveredId);

    expect(response.statusCode).toBe(200);

    const { data } = response.json();

    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.size_bytes).toBeGreaterThan(1000);

    expect(data.version).toBe(1);
    expect(data.filename).toContain("12345");

    const stored = await prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId: deliveredId },
    });

    expect(stored.sha256).toBe(data.sha256);
  }, 60_000);

  it("reuses it on the second request instead of rendering again", async () => {
    // Lazy generation only pays for itself if the second reader is free.
    const first = await fetchProof(deliveredId);
    const second = await fetchProof(deliveredId);

    expect(second.json().data.sha256).toBe(first.json().data.sha256);
    expect(second.json().data.version).toBe(first.json().data.version);
  }, 60_000);

  it("keeps the verification token across a regeneration", async () => {
    // A customer holding a printed QR from last week must still reach the
    // page. The version is what tells them their copy is not the current one.
    const before = await fetchProof(deliveredId);
    const after = await fetchProof(deliveredId, token, "?regenerate=true");

    expect(after.json().data.verificationUrl).toBe(
      before.json().data.verificationUrl,
    );

    expect(after.json().data.version).toBeGreaterThan(
      before.json().data.version,
    );
  }, 60_000);

  it("refuses a delivery that has not ended yet", async () => {
    // A receipt for a delivery in transit would assert something that has not
    // happened.
    const response = await fetchProof(pendingId);

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("ainda está em andamento");
  });

  it("answers 404 for another carrier's delivery, not 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/delivery/proof-document/${deliveredId}/business/${OTHER}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("is refused without a token", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/delivery/proof-document/${deliveredId}/business/${CARRIER}`,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("the page the QR code lands on", () => {
  async function verify(token: string) {
    return app.inject({ method: "GET", url: `/public/verify-proof/${token}` });
  }

  async function currentToken(): Promise<string> {
    await fetchProof(deliveredId);

    const stored = await prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId: deliveredId },
    });

    return stored.verification_token;
  }

  it("confirms the file still matches its hash, with no login at all", async () => {
    const response = await verify(await currentToken());

    expect(response.statusCode).toBe(200);

    const { data } = response.json();

    expect(data.intact).toBe(true);
    expect(data.storedSha256).toBe(data.summary.sha256);

    expect(data.summary.recipientName).toBe("Padaria Central Ltda");
    expect(data.summary.carrierName).toBe("Silva Log");
  }, 60_000);

  it("says nothing about the carrier's operation", async () => {
    // A leaked link shows that ONE receipt is genuine. It must not become a
    // window on the route, the shipper, the driver's document or any other
    // stop.
    const response = await verify(await currentToken());

    const body = JSON.stringify(response.json());

    expect(body).not.toContain("Distribuidora Norte");
    expect(body).not.toContain("João Motorista");
    expect(body).not.toContain(DRIVER);
    expect(body).not.toContain(SHIPPER);
  }, 60_000);

  it("reports tampering when the stored bytes stop matching", async () => {
    // The assertion the whole feature exists for. The row keeps saying one
    // hash; the file on disk says another.
    const verificationToken = await currentToken();

    await prisma.deliveryProofDocument.update({
      where: { verification_token: verificationToken },
      data: { sha256: "0".repeat(64) },
    });

    const response = await verify(verificationToken);

    expect(response.json().data.intact).toBe(false);

    // And it distinguishes the two failures: the file is there, it simply
    // does not match.
    expect(response.json().data.storedSha256).not.toBeNull();
  }, 60_000);

  it("answers the same 404 for an unknown code", async () => {
    const response = await verify("a".repeat(64));

    expect(response.statusCode).toBe(404);
  });

  it("refuses a code that is not even the right shape", async () => {
    // A public endpoint that forwards arbitrary strings to a lookup is one
    // somebody will use to measure timing.
    const response = await verify("nao-e-um-token");

    expect(response.statusCode).toBe(400);
  });
});


describe("the link the customer receives", () => {
  /**
   * The portal, over real HTTP. The privacy rules are proven field by field in
   * the unit suite; what only this can prove is that the endpoint is WIRED
   * without a session — that the token really is the whole authorisation, and
   * that nothing in the stack quietly requires a bearer.
   */
  async function seedRecipient(deliveryId: string): Promise<string> {
    // Upsert with a fresh token: a delivery has at most one recipient row —
    // the unique key is the whole point, since a second row would mean a
    // second link and the customer's first one going dark halfway through.
    const access_token =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const recipient = await prisma.externalRecipient.upsert({
      where: { deliveryId },
      create: {
        deliveryId,
        businessId: CARRIER,
        name: "Maria Souza",
        email: "maria@exemplo.com.br",
        telephone: "11999999999",
        access_token,
      },
      update: { access_token, opted_out_at: null },
    });

    return recipient.access_token;
  }

  it("opens with no login at all", async () => {
    const token = await seedRecipient(pendingId);

    const response = await app.inject({
      method: "GET",
      url: `/public/track/${token}`,
    });

    expect(response.statusCode).toBe(200);

    const { data } = response.json();

    expect(data.recipientName).toBe("Ainda na rua");
    expect(data.statusLabel).toBe("Pendente");
  });

  it("never carries the recipient's own contact details back out", async () => {
    // The link is forwarded. The phone number the carrier holds on file is not
    // the forwarder's to give away.
    const token = await seedRecipient(pendingId);

    const response = await app.inject({
      method: "GET",
      url: `/public/track/${token}`,
    });

    const body = JSON.stringify(response.json());

    expect(body).not.toContain("11999999999");
    expect(body).not.toContain("maria@exemplo.com.br");

    expect(body).not.toContain(token);
    expect(body).not.toContain(CARRIER);
  });

  it("answers the same 404 for a token nobody holds", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/public/track/${"c".repeat(64)}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("lets somebody stop the messages without logging in", async () => {
    // Asking a person to authenticate in order to be left alone is how a
    // company earns a spam complaint.
    const token = await seedRecipient(pendingId);

    const response = await app.inject({
      method: "POST",
      url: `/public/track/${token}/opt-out`,
    });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.externalRecipient.findUniqueOrThrow({
      where: { access_token: token },
    });

    expect(stored.opted_out_at).not.toBeNull();
  });

  it("answers the same sentence for a token that was never real", async () => {
    // A different answer would turn this into an oracle for which links exist.
    const real = await seedRecipient(pendingId);

    const known = await app.inject({
      method: "POST",
      url: `/public/track/${real}/opt-out`,
    });

    const unknown = await app.inject({
      method: "POST",
      url: `/public/track/${"d".repeat(64)}/opt-out`,
    });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json().message).toBe(known.json().message);
  });

  it("shows the receipt link once the document exists", async () => {
    await fetchProof(deliveredId);

    const token = await seedRecipient(deliveredId);

    const response = await app.inject({
      method: "GET",
      url: `/public/track/${token}`,
    });

    expect(response.json().data.proofUrl).toContain("/verificar/");
  }, 60_000);
});

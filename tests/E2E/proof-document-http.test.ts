import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import { createHash, randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { ProofDocumentRepository } from "@/modules/delivery/repositories/proof-document-repository";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { buildProofDocumentModel } from "@/shared/delivery/proof-document";
import type { UploadService } from "@/shared/services/upload-service";

import {
  testCertificateSigning,
  unsignedSigning,
} from "../support/proof-services";

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

async function seedUser(
  businessId: string | null,
  extra: {
    role?: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
    profileAccessId?: string;
    driverId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: extra.role ?? "BUSINESS_ADMIN",
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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
      businessId: CARRIER,
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
    // The declared 401 schema must still serialize the real refusal.
    expect(response.json().message).toEqual(expect.any(String));
  });

  it("documents every refusal of the route, 401 included", () => {
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };

    const route =
      document.paths[
        "/delivery/proof-document/{deliveryId}/business/{businessId}"
      ].get;

    expect(Object.keys(route.responses)).toEqual(
      expect.arrayContaining([
        "200",
        "400",
        "401",
        "403",
        "404",
        "409",
        "429",
        "503",
      ]),
    );
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

describe("the carrier's clock, on the receipt and on its public page", () => {
  /**
   * The PDF prints its moments in Business.timezone, labelled; the public
   * page printed a fixed São Paulo clock. For a carrier in Manaus the paper
   * and the page disagreed by an hour about the same delivery (review of
   * DLVP-PROOF-4). The zone now comes from the same column on both.
   */
  const setZone = (timezone: string) =>
    prisma.business.update({ where: { id: CARRIER }, data: { timezone } });

  afterAll(async () => {
    await setZone("America/Sao_Paulo");
  });

  async function verificationToken(): Promise<string> {
    await fetchProof(deliveredId);

    return (
      await prisma.deliveryProofDocument.findUniqueOrThrow({
        where: { deliveryId: deliveredId },
      })
    ).verification_token;
  }

  it("reads the company's zone with the document, so the PDF prints its clock", async () => {
    await setZone("America/Manaus");

    const loaded = await new ProofDocumentRepository(prisma).loadSource(
      deliveredId,
      CARRIER,
    );

    expect(loaded?.business.timezone).toBe("America/Manaus");

    const model = buildProofDocumentModel(loaded!, {
      verificationBaseUrl: "https://app.trajetto.com.br",
      verificationToken: "t",
    });

    const hora = model.sections.delivery.blocks[0].lines
      .flat()
      .find((field) => field.label === "Hora");

    expect(hora?.value).toContain("(horário de Manaus, UTC-4)");
  });

  it("gives the public page the same zone the PDF uses", async () => {
    await setZone("America/Manaus");

    const manaus = await app.inject({
      method: "GET",
      url: `/public/verify-proof/${await verificationToken()}`,
    });

    expect(manaus.statusCode).toBe(200);
    expect(manaus.json().data.summary.timeZone).toBe("America/Manaus");

    await setZone("America/Sao_Paulo");

    const saoPaulo = await app.inject({
      method: "GET",
      url: `/public/verify-proof/${await verificationToken()}`,
    });

    expect(saoPaulo.json().data.summary.timeZone).toBe("America/Sao_Paulo");
  }, 60_000);
});

describe("what the repository reads for the receipt, and its twin", () => {
  it("prints, for a FAILED delivery, the blocking occurrence that happened last — offline ones by when they happened", async () => {
    // The driver's app queues an occurrence without signal and uploads it
    // later: its moment (occurred_at) is earlier than one uploaded before it.
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Mercado da Esquina",
        city: "São Paulo",
        uf: "SP",
        street: "Rua do Mercado",
        status: "FAILED",
        delivered_at: new Date("2026-09-16T15:00:00.000Z"),
        businessId: CARRIER,
        shipperId: SHIPPER,
        driverId: DRIVER,
      },
    });

    const blocking = await prisma.occurrenceType.create({
      data: {
        name: `Portaria ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
        blocks_delivery: true,
      },
    });
    const delivered = await prisma.occurrenceType.create({
      data: {
        name: `Entregue ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
        category: "DELIVERED",
      },
    });

    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    for (const [type, category, createdAt, occurredAt, latitude] of [
      [
        blocking.id,
        "NOT_DELIVERED",
        "2026-09-16T12:00:00.000Z",
        "2026-09-16T12:00:00.000Z",
        -23.1,
      ],
      // Uploaded half an hour later, recorded an hour earlier.
      [
        blocking.id,
        "NOT_DELIVERED",
        "2026-09-16T12:30:00.000Z",
        "2026-09-16T11:00:00.000Z",
        -23.2,
      ],
      // A "delivered" occurrence (decision 14.3) is not a problem: never read here.
      [
        delivered.id,
        "DELIVERED",
        "2026-09-16T13:00:00.000Z",
        "2026-09-16T13:00:00.000Z",
        -23.3,
      ],
    ] as const) {
      await prisma.deliveryOccurrence.create({
        data: {
          deliveryId: delivery.id,
          businessId: CARRIER,
          occurrenceTypeId: type,
          category,
          reportedById: reporter.id,
          description: category,
          latitude,
          longitude: -46.6,
          created_at: new Date(createdAt),
          occurred_at: new Date(occurredAt),
        },
      });
    }

    const loaded = await new ProofDocumentRepository(prisma).loadSource(
      delivery.id,
      CARRIER,
    );

    expect(
      loaded!.occurrences.map((occurrence) => occurrence.latitude),
    ).toEqual([-23.1, -23.2]);

    const model = buildProofDocumentModel(loaded!, {
      verificationBaseUrl: "https://app.trajetto.com.br",
      verificationToken: "t",
    });

    // 12:00 UTC is the latest MOMENT, though 12:30 was the latest upload.
    expect(model.map).toEqual({ latitude: -23.1, longitude: -46.6 });
    expect(
      model.sections.delivery.blocks[0].lines
        .flat()
        .find((field) => field.label === "Hora")?.value,
    ).toBe("09:00:00 (horário de Brasília, UTC-3)");
  });

  it("reads, for a FAILED delivery without a blocking occurrence, the latest status change to FAILED and its reason", async () => {
    // A panel override: delivered_at is cleared, no occurrence blocks it.
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Padaria do Bairro",
        city: "São Paulo",
        uf: "SP",
        street: "Rua do Pão",
        status: "FAILED",
        delivered_at: null,
        businessId: CARRIER,
        shipperId: SHIPPER,
        driverId: DRIVER,
      },
    });
    const sibling = await prisma.delivery.create({
      data: {
        recipient_name: "Outra",
        city: "São Paulo",
        uf: "SP",
        street: "Rua Outra",
        status: "FAILED",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    const reason = await prisma.statusChangeReason.create({
      data: {
        name: `Cancelado ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
      },
    });
    const older = await prisma.statusChangeReason.create({
      data: { name: `Antigo ${randomUUID().slice(0, 8)}`, businessId: CARRIER },
    });
    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    const event = (
      deliveryId: string,
      reasonId: string,
      to: "FAILED" | "PENDING",
      at: string,
    ) =>
      prisma.deliveryEvent.create({
        data: {
          type: "STATUS_CHANGE",
          deliveryId,
          businessId: CARRIER,
          reportedById: reporter.id,
          actor: "USER",
          status_from: "PENDING",
          status_to: to,
          reasonId,
          created_at: new Date(at),
        },
      });

    await event(delivery.id, older.id, "FAILED", "2026-09-16T10:00:00.000Z");
    await event(delivery.id, reason.id, "FAILED", "2026-09-16T18:45:10.000Z");
    // Not to FAILED, and another delivery's: neither is this record.
    await event(delivery.id, older.id, "PENDING", "2026-09-16T19:00:00.000Z");
    await event(sibling.id, older.id, "FAILED", "2026-09-16T20:00:00.000Z");

    const loaded = await new ProofDocumentRepository(prisma).loadSource(
      delivery.id,
      CARRIER,
    );

    expect(loaded!.failure).toEqual({
      occurred_at: new Date("2026-09-16T18:45:10.000Z"),
      reasonName: reason.name,
      occurrenceId: null,
    });

    const fields = buildProofDocumentModel(loaded!, {
      verificationBaseUrl: "https://app.trajetto.com.br",
      verificationToken: "t",
    }).sections.delivery.blocks[0].lines.flat();

    expect(fields.find((field) => field.label === "Ocorrência")?.value).toBe(
      reason.name,
    );
    expect(fields.find((field) => field.label === "Hora")?.value).toBe(
      "15:45:10 (horário de Brasília, UTC-3)",
    );

    // A delivered one never pays for the extra read.
    expect(
      (await new ProofDocumentRepository(prisma).loadSource(
        deliveredId,
        CARRIER,
      ))!.failure,
    ).toBeNull();
  });

  it("prints the later manual FAILED over a stale occurrence, but never an approval's own change", async () => {
    // Regression: the blocking occurrence always won, so a delivery reopened
    // and failed again from the panel printed the old occurrence.
    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER },
    });
    const type = await prisma.occurrenceType.create({
      data: {
        name: `Ausente ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
        blocks_delivery: true,
      },
    });
    const reason = await prisma.statusChangeReason.create({
      data: {
        name: `Cliente cancelou ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
      },
    });

    const failedDelivery = () =>
      prisma.delivery.create({
        data: {
          recipient_name: "Mercado Central",
          city: "São Paulo",
          uf: "SP",
          street: "Rua A",
          status: "FAILED",
          businessId: CARRIER,
          shipperId: SHIPPER,
          driverId: DRIVER,
        },
      });
    const occurrenceOn = (deliveryId: string) =>
      prisma.deliveryOccurrence.create({
        data: {
          deliveryId,
          businessId: CARRIER,
          occurrenceTypeId: type.id,
          category: "NOT_DELIVERED",
          reportedById: reporter.id,
          latitude: -23.5,
          longitude: -46.6,
          created_at: new Date("2026-09-16T13:00:00.000Z"),
          occurred_at: new Date("2026-09-16T13:00:00.000Z"),
        },
      });
    const toFailed = (
      deliveryId: string,
      at: string,
      extra: { reasonId?: string; occurrenceId?: string },
    ) =>
      prisma.deliveryEvent.create({
        data: {
          type: "STATUS_CHANGE",
          deliveryId,
          businessId: CARRIER,
          reportedById: reporter.id,
          actor: "USER",
          status_from: "PENDING",
          status_to: "FAILED",
          created_at: new Date(at),
          ...extra,
        },
      });
    const occurrenceField = async (deliveryId: string) => {
      const loaded = await new ProofDocumentRepository(prisma).loadSource(
        deliveryId,
        CARRIER,
      );
      const fields = buildProofDocumentModel(loaded!, {
        verificationBaseUrl: "https://app.trajetto.com.br",
        verificationToken: "t",
      }).sections.delivery.blocks[0].lines.flat();

      return {
        loaded: loaded!,
        occurrence: fields.find((field) => field.label === "Ocorrência")?.value,
        hora: fields.find((field) => field.label === "Hora")?.value,
      };
    };

    // Reopened and failed again from the panel at 18:00 local: the reason wins.
    const reopened = await failedDelivery();
    await occurrenceOn(reopened.id);
    await toFailed(reopened.id, "2026-09-16T21:00:00.000Z", {
      reasonId: reason.id,
    });

    const late = await occurrenceField(reopened.id);
    expect(late.occurrence).toBe(reason.name);
    expect(late.hora).toBe("18:00:00 (horário de Brasília, UTC-3)");

    // The tower approving the occurrence writes its own, later change that
    // points at it: the occurrence is still the fact.
    const approved = await failedDelivery();
    const occurrence = await occurrenceOn(approved.id);
    await toFailed(approved.id, "2026-09-16T13:05:00.000Z", {
      occurrenceId: occurrence.id,
    });

    const tower = await occurrenceField(approved.id);
    expect(tower.loaded.failure?.occurrenceId).toBe(occurrence.id);
    expect(tower.occurrence).toBe(type.name);
    expect(tower.hora).toBe("10:00:00 (horário de Brasília, UTC-3)");
  });

  it("reads another company's delivery as absent, in the repository and in its twin", async () => {
    const real = new ProofDocumentRepository(prisma);

    const mine = await real.loadSource(deliveredId, CARRIER);

    expect(mine).not.toBeNull();
    expect(await real.loadSource(deliveredId, OTHER)).toBeNull();

    // The twin holds the same source, owned by the same company.
    const twin = new InMemoryProofDocumentRepository();

    twin.addSource(CARRIER, mine!);

    expect(await twin.loadSource(deliveredId, OTHER)).toBeNull();
    expect(await twin.loadSource(deliveredId, CARRIER)).toEqual(mine);
  });
});

describe("regenerating is a write (decisions 4.1 and 4.2)", () => {
  /**
   * `regenerate=true` renders again, stores a new object, points the row at
   * it and bumps the version: every copy a customer already holds then reads
   * as superseded on /verificar. The route is guarded for reading, and the
   * regeneration used to ride on that guard: a read-only profile, or the
   * back office at a switched-off company, could supersede any receipt.
   */
  const INACTIVE = "018f4000-0000-7000-8000-00000000000c";
  const COLLEAGUE = "018f4000-0000-7000-8000-0000000000d2";

  let readOnlyToken: string;
  let writerToken: string;
  let colleagueToken: string;
  let masterToken: string;

  let inactiveDeliveryId: string;

  async function officeProfile(canWrite: boolean): Promise<string> {
    const profile = await prisma.profileAccess.create({
      data: {
        name: `Perfil ${randomUUID().slice(0, 8)}`,
        businessId: CARRIER,
        permissions: {
          create: [
            {
              permissionKey: "delivery_manage",
              action: "delivery_manage",
              canRead: true,
              canWrite,
              businessId: CARRIER,
            },
          ],
        },
      },
    });

    return profile.id;
  }

  function requestProof(
    deliveryId: string,
    businessId: string,
    as: string,
    query = "",
  ) {
    return app.inject({
      method: "GET",
      url: `/delivery/proof-document/${deliveryId}/business/${businessId}${query}`,
      headers: { authorization: `Bearer ${as}` },
    });
  }

  function storedRow(deliveryId: string) {
    return prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId },
      select: { version: true, storage_key: true, sha256: true },
    });
  }

  beforeAll(async () => {
    readOnlyToken = await seedUser(CARRIER, {
      role: "BUSINESS_USER",
      profileAccessId: await officeProfile(false),
    });

    writerToken = await seedUser(CARRIER, {
      role: "BUSINESS_USER",
      profileAccessId: await officeProfile(true),
    });

    // Another driver of the same company. Drivers hold delivery_manage:write,
    // so only the delivery's own scope keeps this one out.
    await prisma.driver.create({
      data: {
        id: COLLEAGUE,
        name: "Pedro Motorista",
        birth_date: new Date("1991-01-01"),
        cnh: `${COLLEAGUE}-cnh`,
        cpf: `${COLLEAGUE}-cpf`,
        rg: `${COLLEAGUE}-rg`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "2",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: CARRIER,
      },
    });

    colleagueToken = await seedUser(CARRIER, {
      role: "BUSINESS_USER",
      driverId: COLLEAGUE,
    });

    masterToken = await seedUser(null, { role: "MASTER" });

    // A company switched off after its delivery ended, module still hired:
    // the MASTER's module gate lets that through, so only the write's own
    // guard can refuse the regeneration.
    await seedBusiness(INACTIVE);

    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador Parado", businessId: INACTIVE },
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Loja Fechada Ltda",
        city: "São Paulo",
        uf: "SP",
        street: "Rua Encerrada",
        address_number: "9",
        status: "DELIVERED",
        delivered_at: new Date(),
        received_by: "Ana Lima",
        businessId: INACTIVE,
        shipperId: shipper.id,
      },
    });

    inactiveDeliveryId = delivery.id;

    await prisma.business.update({
      where: { id: INACTIVE },
      data: { is_active: false },
    });

    // The document every test below starts from.
    expect((await fetchProof(deliveredId)).statusCode).toBe(200);
  }, 60_000);

  it("lets a read-only profile read the receipt but not regenerate it", async () => {
    const before = await storedRow(deliveredId);

    const read = await requestProof(deliveredId, CARRIER, readOnlyToken);

    expect(read.statusCode).toBe(200);
    expect(read.json().data.version).toBe(before.version);

    const regenerate = await requestProof(
      deliveredId,
      CARRIER,
      readOnlyToken,
      "?regenerate=true",
    );

    expect(regenerate.statusCode).toBe(403);
    expect(regenerate.json().code).toBe("PERMISSION_DENIED");

    // Nothing written: the customer's copy is still the current one.
    expect(await storedRow(deliveredId)).toEqual(before);
  }, 60_000);

  it("lets a profile that writes deliveries regenerate it", async () => {
    const before = await storedRow(deliveredId);

    const response = await requestProof(
      deliveredId,
      CARRIER,
      writerToken,
      "?regenerate=true",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data.version).toBe(before.version + 1);
    expect((await storedRow(deliveredId)).version).toBe(before.version + 1);
  }, 60_000);

  it("still answers 404 to a driver asking for a colleague's receipt, regenerating or not", async () => {
    const before = await storedRow(deliveredId);

    for (const query of ["", "?regenerate=true"]) {
      const response = await requestProof(
        deliveredId,
        CARRIER,
        colleagueToken,
        query,
      );

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("DELIVERY_NOT_FOUND");
    }

    expect(await storedRow(deliveredId)).toEqual(before);
  }, 60_000);

  it("lets the back office regenerate an active company's receipt", async () => {
    const before = await storedRow(deliveredId);

    const response = await requestProof(
      deliveredId,
      CARRIER,
      masterToken,
      "?regenerate=true",
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data.version).toBe(before.version + 1);
  }, 60_000);

  it("refuses to regenerate a switched-off company's receipt, which it can still read", async () => {
    const read = await requestProof(inactiveDeliveryId, INACTIVE, masterToken);

    expect(read.statusCode).toBe(200);

    const before = await storedRow(inactiveDeliveryId);

    const regenerate = await requestProof(
      inactiveDeliveryId,
      INACTIVE,
      masterToken,
      "?regenerate=true",
    );

    expect(regenerate.statusCode).toBe(403);
    expect(regenerate.json().code).toBe("TENANT_INACTIVE");

    expect(await storedRow(inactiveDeliveryId)).toEqual(before);
  }, 60_000);

  it("refuses another company's user without touching the receipt", async () => {
    const before = await storedRow(deliveredId);

    const response = await requestProof(
      deliveredId,
      CARRIER,
      otherToken,
      "?regenerate=true",
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");

    expect(await storedRow(deliveredId)).toEqual(before);
  });
});

describe("the validated model and its signature (decision 14.8)", () => {
  /**
   * The document's layout and signature, through the real route, the real
   * repository and the real storage. The certificate is generated by the
   * test (tests/support/test-signing-certificate.ts) and registered in place
   * of the platform's — never a real one.
   */
  const uploads = () => container.resolve<UploadService>("UploadService");

  afterAll(() => {
    container.registerInstance("ProofSigningService", unsignedSigning());
  });

  async function settledDelivery(extra: Record<string, unknown> = {}) {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Supermercado Cabral Ltda",
        recipient_document: "30970502000106",
        invoice_number: String(Math.floor(Math.random() * 1e6)),
        city: "Vila Velha",
        uf: "ES",
        street: "Rua Alberto de Oliveira Santos",
        address_number: "494",
        status: "DELIVERED",
        delivered_at: new Date(),
        businessId: CARRIER,
        shipperId: SHIPPER,
        driverId: DRIVER,
      },
    });

    const event = await prisma.deliveryEvent.create({
      data: {
        type: "PROOF",
        deliveryId: delivery.id,
        businessId: CARRIER,
        actor: "DRIVER_APP",
        latitude: -20.3502181,
        longitude: -40.3038332,
        client_submission_id: randomUUID(),
        ...extra,
      },
    });

    return { deliveryId: delivery.id, eventId: event.id };
  }

  it("answers the layout and an honest UNSIGNED state without a certificate", async () => {
    container.registerInstance("ProofSigningService", unsignedSigning());

    const { deliveryId } = await settledDelivery();
    const response = await fetchProof(deliveryId);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      layout_version: 2,
      signature: {
        status: "UNSIGNED",
        profile: null,
        signer_name: null,
        signer_cnpj: null,
        cert_not_after: null,
        signed_at: null,
        unsigned_reason: "NO_CERTIFICATE",
      },
      signing_available: false,
    });

    const row = await prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId },
    });

    expect(row).toMatchObject({
      layout_version: 2,
      signature_status: "UNSIGNED",
      unsigned_reason: "NO_CERTIFICATE",
    });

    const bytes = await uploads().readObject(row.storage_key);
    expect(bytes!.toString("latin1")).not.toContain("/ByteRange");
  }, 60_000);

  it("signs with the configured certificate, stores the signed bytes and says who signed", async () => {
    container.registerInstance("ProofSigningService", testCertificateSigning());

    const { deliveryId } = await settledDelivery();
    const response = await fetchProof(deliveryId);

    expect(response.statusCode).toBe(200);

    const { data } = response.json();

    expect(data.signature).toMatchObject({
      status: "SIGNED",
      profile: "PADES_AD_RB",
      signer_name: "TRAJETTO SISTEMAS TESTE LTDA",
      signer_cnpj: "11222333000181",
      unsigned_reason: null,
    });
    expect(data.signing_available).toBe(true);

    const row = await prisma.deliveryProofDocument.findUniqueOrThrow({
      where: { deliveryId },
    });
    const bytes = (await uploads().readObject(row.storage_key))!;

    // The stored file is the signed one, and the recorded hash is of it.
    expect(bytes.toString("latin1")).toMatch(/\/ByteRange \[0 \d+ \d+ \d+/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);

    // The public page: intact, and what we recorded about the signature.
    const page = await app.inject({
      method: "GET",
      url: `/public/verify-proof/${row.verification_token}`,
    });

    expect(page.json().data.intact).toBe(true);
    expect(page.json().data.summary.signature).toMatchObject({
      status: "SIGNED",
      profile: "PADES_AD_RB",
      signerName: "TRAJETTO SISTEMAS TESTE LTDA",
    });
    // Narrow on purpose: no serial and no certificate bytes on the public page.
    expect(JSON.stringify(page.json())).not.toContain("0a1b2c3d4e5f");
  }, 60_000);

  it("answers 503 PROOF_SIGNING_FAILED and writes no row when signing fails", async () => {
    container.registerInstance(
      "ProofSigningService",
      testCertificateSigning({ signatureLength: 64 }),
    );

    const { deliveryId } = await settledDelivery();
    const response = await fetchProof(deliveryId);

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("PROOF_SIGNING_FAILED");
    expect(
      await prisma.deliveryProofDocument.findUnique({ where: { deliveryId } }),
    ).toBeNull();
  }, 60_000);

  it("replaces the signature on a regeneration, keeping the token", async () => {
    container.registerInstance("ProofSigningService", testCertificateSigning());

    const { deliveryId } = await settledDelivery();
    const first = (await fetchProof(deliveryId)).json().data;

    container.registerInstance("ProofSigningService", unsignedSigning());

    const second = (
      await fetchProof(deliveryId, token, "?regenerate=true")
    ).json().data;

    expect(second.verificationUrl).toBe(first.verificationUrl);
    expect(second.version).toBe(first.version + 1);
    expect(second.signature).toMatchObject({
      status: "UNSIGNED",
      unsigned_reason: "NO_CERTIFICATE",
      signer_name: null,
    });
  }, 60_000);

  it("reads the phone, the photo time, the route and the delivered type with the proof", async () => {
    const route = await prisma.route.create({
      data: {
        businessId: CARRIER,
        code: 900_000 + Math.floor(Math.random() * 90_000),
        name: "Rota do comprovante",
        scheduled_date: new Date("2026-09-30"),
        driverId: DRIVER,
      },
    });

    const type = await prisma.occurrenceType.create({
      data: {
        name: `Entrega normal ${randomUUID().slice(0, 6)}`,
        businessId: CARRIER,
        category: "DELIVERED",
      },
    });

    await prisma.shipper.update({
      where: { id: SHIPPER },
      data: { corporate_reason: "Distribuidora Norte Comércio Ltda" },
    });

    const { deliveryId, eventId } = await settledDelivery({
      device_id: "23be03c084165505",
      photo_taken_at: new Date("2026-09-30T16:30:08.000Z"),
      occurred_at: new Date("2026-09-30T16:30:26.000Z"),
      routeId: route.id,
    });

    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER },
    });
    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId,
        businessId: CARRIER,
        occurrenceTypeId: type.id,
        category: "DELIVERED",
        reportedById: reporter.id,
      },
    });

    await prisma.deliveryEvent.update({
      where: { id: eventId },
      data: { occurrenceId: occurrence.id },
    });

    const loaded = (await new ProofDocumentRepository(prisma).loadSource(
      deliveryId,
      CARRIER,
    ))!;

    expect(loaded.proof).toMatchObject({
      eventId,
      device_id: "23be03c084165505",
      photo_taken_at: new Date("2026-09-30T16:30:08.000Z"),
      created_at: new Date("2026-09-30T16:30:26.000Z"),
    });
    expect(loaded.deliveredTypeName).toBe(type.name);
    expect(loaded.delivery.shipper?.corporate_reason).toBe(
      "Distribuidora Norte Comércio Ltda",
    );
    // The proof's own route, read through the event (design §3 #4).
    expect(loaded.route?.code).toBe(route.code);
  }, 60_000);

  it("caches the GPS address on the company's own event only", async () => {
    const { deliveryId, eventId } = await settledDelivery();
    const repository = new ProofDocumentRepository(prisma);
    const address = {
      line: "Rua A, 1",
      district: "Centro",
      city: "Vila Velha",
      state: "ES",
      cep: "29100000",
    };

    // Another company naming this event changes nothing.
    await repository.saveGpsAddress(eventId, OTHER, {
      gps_address: address,
      gps_address_source: "PROVIDER",
      gps_geocoded_at: new Date(),
    });

    expect(
      (await repository.loadSource(deliveryId, CARRIER))!.proof!
        .gps_address_source,
    ).toBeNull();

    await repository.saveGpsAddress(eventId, CARRIER, {
      gps_address: address,
      gps_address_source: "PROVIDER",
      gps_geocoded_at: new Date(),
    });

    const loaded = (await repository.loadSource(deliveryId, CARRIER))!;

    expect(loaded.proof!.gps_address_source).toBe("PROVIDER");
    expect(loaded.proof!.gps_address).toEqual(address);

    // UNAVAILABLE stores no address at all.
    await repository.saveGpsAddress(eventId, CARRIER, {
      gps_address: null,
      gps_address_source: "UNAVAILABLE",
      gps_geocoded_at: new Date(),
    });

    expect(
      (await repository.loadSource(deliveryId, CARRIER))!.proof!.gps_address,
    ).toBeNull();
  }, 60_000);

  it("never shows another company the new fields: the same 404", async () => {
    const { deliveryId } = await settledDelivery({
      device_id: "23be03c084165505",
    });

    const response = await app.inject({
      method: "GET",
      url: `/delivery/proof-document/${deliveryId}/business/${OTHER}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("23be03c084165505");
  });
});

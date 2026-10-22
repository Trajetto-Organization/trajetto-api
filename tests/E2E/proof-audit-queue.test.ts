import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import type {
  ListProofAuditsProps,
  ProofAuditRecord,
  ProofAuditSuggestion,
} from "@/modules/delivery/dtos/proof-audit-dto";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * Auditoria de comprovantes over real HTTP and a real database (Entregas 10).
 *
 * - DLVB-03: on /dashboard the panel sent `businessId=` and got a 400 it
 *   showed as an empty queue; the session's company is what a BUSINESS_ADMIN
 *   and a dispatcher list and approve.
 * - DLVB-02: every tab was oldest-first and the screen asked for page 1 only,
 *   so a receipt approved now never showed under Aprovados.
 * - DLVB-04: the agreement rate loaded every reviewed card with its JSON.
 * - DLVB-08: the rejection's occurrence was written after the verdict's
 *   commit.
 *
 * The ordering and the rate are also run against the in-memory twin with the
 * same rows, so the two cannot drift (decision 13.2).
 */
const prisma = new PrismaClient();

const COMPANY = "018fd990-0000-7000-8000-00000000000a";
const OTHER = "018fd990-0000-7000-8000-00000000000b";

let app: Awaited<typeof import("@/http")>["app"];

let company: FleetDriverSeed;
let other: FleetDriverSeed;

let adminId = "";
let dispatcherToken = "";
let readOnlyToken = "";
let clerkToken = "";

let shipperId = "";

const DAY = 24 * 60 * 60 * 1000;

/**
 * How a driver is refused here: a permission 403, never "module not
 * enabled". The proof routes pass `allowDriver: false` to verifyPermission,
 * as /message-templates does, so the middleware answers PERMISSION_DENIED
 * (decision 4.1) before the use case's dispatcher guard is reached.
 */
const DRIVER_REFUSALS = ["PERMISSION_DENIED"] as const;

async function tokenFor(userId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: userId,
      expiresIn: "30m",
    },
  );
}

/**
 * A BUSINESS_USER whose profile grants `permissionKey`: read and write, or
 * read only when `canWrite` is false.
 */
async function officeUser(
  businessId: string,
  permissionKey: string,
  canWrite = true,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  const id = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Despachante",
      email: `${id}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId,
      profileAccessId: profile.id,
    },
  });

  return tokenFor(id);
}

async function delivered(
  businessId: string,
  recipient = "Destinatário",
): Promise<string> {
  const shipper =
    businessId === COMPANY
      ? shipperId
      : (
          await prisma.shipper.create({
            data: {
              name: `Embarcador ${randomUUID().slice(0, 6)}`,
              businessId,
            },
          })
        ).id;

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: recipient,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId,
      shipperId: shipper,
      status: "DELIVERED",
      delivered_at: new Date(),
    },
  });

  return delivery.id;
}

function suggestion(
  kind: "looks_good" | "needs_review" | "looks_wrong",
  reviewPriority: number,
): ProofAuditSuggestion {
  return {
    reading: {
      legible: "yes",
      hasSignature: "yes",
      dateVisible: "yes",
      documentMatches: "yes",
      photoQuality: 0.9,
      confidence: 0.9,
      observation: "",
    },
    assessment: { suggestion: kind, failed: [], uncertain: [], reviewPriority },
  };
}

interface CardSeed {
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: Date;
  reviewedAt?: Date;
  suggestion?: ProofAuditSuggestion;
  recipient?: string;
}

/** Writes one card straight to the table and returns the row as stored. */
async function card(
  businessId: string,
  seed: CardSeed,
): Promise<ProofAuditRecord> {
  const deliveryId = await delivered(businessId, seed.recipient);

  const row = await prisma.deliveryProofAudit.create({
    data: {
      deliveryId,
      businessId,
      status: seed.status,
      created_at: seed.createdAt,
      ai_suggestion: seed.suggestion
        ? (seed.suggestion as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      reviewed_at:
        seed.status === "PENDING" ? null : (seed.reviewedAt ?? new Date()),
      reviewedById: seed.status === "PENDING" ? null : adminId,
      rejection_reason: seed.status === "REJECTED" ? "Sem assinatura" : null,
    },
  });

  return row as unknown as ProofAuditRecord;
}

const list = (token: string, query: string) =>
  app.inject({
    method: "GET",
    url: `/delivery/proof-audits?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

/** The NDJSON body: an envelope line, then one card per line. */
function parse(body: string): { meta: any; cards: any[] } {
  const [envelope, ...lines] = body.trim().split("\n").filter(Boolean);

  return {
    meta: JSON.parse(envelope).meta,
    cards: lines.map((line) => JSON.parse(line)),
  };
}

const review = (
  token: string,
  auditId: string,
  businessId: string,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: "PATCH",
    url: `/delivery/proof-audit/${auditId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

/** The same rows in the twin, so each ordering is asserted on both. */
function twinWith(rows: ProofAuditRecord[]): InMemoryProofAuditRepository {
  const twin = new InMemoryProofAuditRepository();

  twin.audits = rows.map((row) => ({
    ...row,
    ai_suggestion: (row.ai_suggestion ?? null) as ProofAuditSuggestion | null,
  }));

  return twin;
}

async function bothRepositories(
  rows: ProofAuditRecord[],
  props: ListProofAuditsProps,
) {
  const real = await new ProofAuditRepository(prisma).listQueue(props);
  const twin = await twinWith(rows).listQueue(props);

  return { real, twin };
}

beforeAll(async () => {
  company = await seedFleetDriver(prisma, {
    businessId: COMPANY,
    cnpj: "71222333000181",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "72222333000181",
  });

  adminId = (
    await prisma.user.findFirstOrThrow({
      where: { businessId: COMPANY, role: "BUSINESS_ADMIN" },
    })
  ).id;

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: COMPANY },
    })
  ).id;

  dispatcherToken = await officeUser(COMPANY, "delivery_manage");
  readOnlyToken = await officeUser(COMPANY, "delivery_manage", false);
  clerkToken = await officeUser(COMPANY, "fuel_manage");

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the dashboard queue, with the company from the session (DLVB-03)", () => {
  it("lists and approves for a BUSINESS_ADMIN and for a dispatcher, without a businessId", async () => {
    const mine = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
      recipient: "Mercado do Painel",
    });

    for (const token of [company.managerToken, dispatcherToken]) {
      const response = await list(token, "status=PENDING&page=1&pageSize=20");

      expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
      expect(parse(response.body).cards.map((entry) => entry.id)).toContain(
        mine.id,
      );
    }

    const approved = await review(dispatcherToken, mine.id, COMPANY, {
      status: "APPROVED",
    });

    expect(approved.statusCode, approved.body).toBe(200);

    const history = parse(
      (await list(company.managerToken, "status=APPROVED&page=1&pageSize=20"))
        .body,
    );

    expect(history.cards[0].id).toBe(mine.id);
  });

  it("refuses an empty businessId, which is why the screen must never send one", async () => {
    // The tenant guard answers before the schema: 403 TENANT_ACCESS_DENIED
    // today, the uuid check's 400 VALIDATION_ERROR if the order ever flips.
    // Either is a coded refusal the panel used to draw as "Nenhum
    // comprovante esperando revisão"; anything else is a regression.
    const response = await list(
      company.managerToken,
      "businessId=&status=PENDING&page=1&pageSize=20",
    );

    expect([
      [403, "TENANT_ACCESS_DENIED"],
      [400, "VALIDATION_ERROR"],
    ]).toContainEqual([response.statusCode, response.json().code]);
  });

  it("refuses a colleague without delivery_manage and the driver", async () => {
    const colleague = await list(
      clerkToken,
      "status=PENDING&page=1&pageSize=20",
    );

    expect(colleague.statusCode).toBe(403);
    // Decision 4.1: a permission refusal says so, not "module not enabled".
    expect(colleague.json().code).toBe("PERMISSION_DENIED");

    const driver = await list(
      company.driverToken,
      "status=PENDING&page=1&pageSize=20",
    );

    expect(driver.statusCode).toBe(403);
    expect(DRIVER_REFUSALS).toContain(driver.json().code);

    const pending = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const refused = await review(clerkToken, pending.id, COMPANY, {
      status: "APPROVED",
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("PERMISSION_DENIED");
  });

  it("lets a read-only dispatcher see the queue but not decide, and never the driver", async () => {
    const pending = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const listed = await list(
      readOnlyToken,
      "status=PENDING&page=1&pageSize=100",
    );

    expect(listed.statusCode, listed.body.slice(0, 300)).toBe(200);
    expect(parse(listed.body).cards.map((entry) => entry.id)).toContain(
      pending.id,
    );

    for (const [token, codes] of [
      [readOnlyToken, ["PERMISSION_DENIED"]],
      [company.driverToken, DRIVER_REFUSALS],
    ] as const) {
      for (const body of [
        { status: "APPROVED" },
        { status: "REJECTED", rejection_reason: "Canhoto de outra entrega" },
      ]) {
        const response = await review(token, pending.id, COMPANY, body);

        expect(response.statusCode, response.body).toBe(403);
        expect(codes).toContain(response.json().code);
      }
    }

    const after = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { id: pending.id },
    });

    expect(after.status).toBe("PENDING");
    expect(
      await prisma.deliveryOccurrence.count({
        where: { deliveryId: pending.deliveryId },
      }),
    ).toBe(0);
  });

  it("never lists or decides another company's cards", async () => {
    const theirs = await card(OTHER, {
      status: "PENDING",
      createdAt: new Date(),
    });

    // Their company in the query: refused, not an empty list.
    expect(
      (
        await list(
          company.managerToken,
          `businessId=${OTHER}&status=PENDING&page=1&pageSize=20`,
        )
      ).statusCode,
    ).toBe(403);

    // Their company in the path: refused.
    expect(
      (
        await review(company.managerToken, theirs.id, OTHER, {
          status: "APPROVED",
        })
      ).statusCode,
    ).toBe(403);

    // Their card under our company: the same 404 as a card that does not exist.
    expect(
      (
        await review(company.managerToken, theirs.id, COMPANY, {
          status: "APPROVED",
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await prisma.deliveryProofAudit.findUniqueOrThrow({
          where: { id: theirs.id },
        })
      ).status,
    ).toBe("PENDING");

    const mineOnly = parse(
      (await list(other.managerToken, "status=PENDING&page=1&pageSize=100"))
        .body,
    );

    expect(mineOnly.cards.every((entry) => entry.businessId === OTHER)).toBe(
      true,
    );
  });
});

describe("the order and the pages of each tab (DLVB-02)", () => {
  it("lists Aprovados by decision, newest first, across pages — the same in the twin", async () => {
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "73222333000181",
    });

    const rows: ProofAuditRecord[] = [];
    const now = Date.now();

    // 25 decisions; the one decided last was proven the longest ago.
    for (let index = 0; index < 25; index += 1) {
      rows.push(
        await card(business, {
          status: "APPROVED",
          createdAt: new Date(now - (index === 24 ? 60 : 30 - index) * DAY),
          reviewedAt: new Date(now - (25 - index) * 60_000),
        }),
      );
    }

    const newestFirst = [...rows]
      .sort(
        (left, right) =>
          +new Date(right.reviewed_at!) - +new Date(left.reviewed_at!),
      )
      .map((row) => row.id);

    const props = (page: number): ListProofAuditsProps => ({
      businessId: business,
      status: "APPROVED",
      page,
      pageSize: 20,
      agreementSince: new Date(now - 90 * DAY),
    });

    const first = await bothRepositories(rows, props(1));
    const second = await bothRepositories(rows, props(2));

    expect(first.real.data.map((row) => row.id)).toEqual(
      newestFirst.slice(0, 20),
    );
    expect(second.real.data.map((row) => row.id)).toEqual(
      newestFirst.slice(20),
    );

    // The one approved last is on top of page 1, however old its proof.
    expect(first.real.data[0].id).toBe(rows[24].id);

    expect(first.real.total).toBe(25);
    expect(first.real.meta.approved).toBe(25);

    expect(first.twin.data.map((row) => row.id)).toEqual(
      first.real.data.map((row) => row.id),
    );
    expect(second.twin.data.map((row) => row.id)).toEqual(
      second.real.data.map((row) => row.id),
    );
  });

  it("places a decided card with no decision time where Postgres does, the same in the twin", async () => {
    // Not a state the use cases write, but the twin must not order it where
    // the database would not (decision 13.2): plain DESC puts nulls first.
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "78222333000181",
    });

    const now = Date.now();

    const decided = await card(business, {
      status: "APPROVED",
      createdAt: new Date(now - 2 * DAY),
      reviewedAt: new Date(now - DAY),
    });
    const undated = await card(business, {
      status: "APPROVED",
      createdAt: new Date(now - 3 * DAY),
    });

    await prisma.deliveryProofAudit.update({
      where: { id: undated.id },
      data: { reviewed_at: null },
    });

    const rows = [decided, { ...undated, reviewed_at: null }];

    const { real, twin } = await bothRepositories(rows, {
      businessId: business,
      status: "APPROVED",
      page: 1,
      pageSize: 10,
      agreementSince: new Date(now - 90 * DAY),
    });

    expect(real.data.map((row) => row.id)).toEqual([undated.id, decided.id]);
    expect(twin.data.map((row) => row.id)).toEqual(
      real.data.map((row) => row.id),
    );
  });

  it("orders Na fila by the model's priority across pages, then oldest first — the same in the twin", async () => {
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "74222333000181",
    });

    const now = Date.now();

    const clean = await card(business, {
      status: "PENDING",
      createdAt: new Date(now - 5 * DAY),
      suggestion: suggestion("looks_good", 10),
    });
    const unsureOld = await card(business, {
      status: "PENDING",
      createdAt: new Date(now - 4 * DAY),
      suggestion: suggestion("needs_review", 3),
    });
    const unsureNew = await card(business, {
      status: "PENDING",
      createdAt: new Date(now - 1 * DAY),
      suggestion: suggestion("needs_review", 3),
    });
    const unread = await card(business, {
      status: "PENDING",
      createdAt: new Date(now - 2 * DAY),
    });

    const rows = [clean, unsureOld, unsureNew, unread];
    const expected = [unread.id, unsureOld.id, unsureNew.id, clean.id];

    const seen: string[] = [];
    const twinSeen: string[] = [];

    for (const page of [1, 2]) {
      const { real, twin } = await bothRepositories(rows, {
        businessId: business,
        status: "PENDING",
        page,
        pageSize: 2,
        agreementSince: new Date(now - 90 * DAY),
      });

      seen.push(...real.data.map((row) => row.id));
      twinSeen.push(...twin.data.map((row) => row.id));
    }

    expect(seen).toEqual(expected);
    expect(twinSeen).toEqual(expected);
  });
});

describe("the page numbers the queue accepts (review of DLVB-02)", () => {
  it("answers 400 VALIDATION_ERROR for a page or page size that is not a whole number", async () => {
    // page=2.5 became skip 4.5 (Prisma) or OFFSET 4.5 (the queue's SQL): a
    // 500 for a request that was simply malformed.
    for (const query of [
      "status=APPROVED&page=2.5&pageSize=3",
      "status=PENDING&page=2.5&pageSize=3",
      "status=APPROVED&page=1&pageSize=2.5",
      "status=APPROVED&page=-1&pageSize=3",
      "status=APPROVED&page=1000001&pageSize=100",
    ]) {
      const response = await list(company.managerToken, query);

      expect(
        response.statusCode,
        `${query}: ${response.body.slice(0, 200)}`,
      ).toBe(400);
      expect(response.json().code, query).toBe("VALIDATION_ERROR");
    }
  });

  it("still reads an empty, zero or non-numeric page as the default, like every offset list", async () => {
    const response = await list(
      company.managerToken,
      "status=APPROVED&page=abc&pageSize=0",
    );

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
    expect(parse(response.body).meta).toMatchObject({ page: 1, pageSize: 10 });
  });
});

describe("what a card shows about its proof and its reviewer, the same in the twin", () => {
  it("carries the latest proof's paths and the reviewer's name", async () => {
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "79222333000181",
    });

    const now = Date.now();

    const decided = await card(business, {
      status: "APPROVED",
      createdAt: new Date(now - 2 * DAY),
      reviewedAt: new Date(now - DAY),
    });
    const bare = await card(business, {
      status: "APPROVED",
      createdAt: new Date(now - 3 * DAY),
      reviewedAt: new Date(now - 2 * DAY),
    });

    // Two proofs: the card shows the one that stands, the latest.
    for (const [photo, signature, at] of [
      [`deliveryPhotos/${business}/old.jpg`, null, now - 3 * DAY],
      [
        `deliveryPhotos/${business}/canhoto.jpg`,
        `deliverySignatures/${business}/assinatura.png`,
        now - 2 * DAY,
      ],
    ] as const) {
      await prisma.deliveryEvent.create({
        data: {
          type: "PROOF",
          deliveryId: decided.deliveryId,
          businessId: business,
          actor: "DRIVER_APP",
          photo,
          signature,
          created_at: new Date(at),
        },
      });
    }

    const props: ListProofAuditsProps = {
      businessId: business,
      status: "APPROVED",
      page: 1,
      pageSize: 10,
      agreementSince: new Date(now - 90 * DAY),
    };

    const real = await new ProofAuditRepository(prisma).listQueue(props);

    const twin = twinWith([decided, bare]);
    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { id: adminId },
    });

    twin.reviewers.set(reviewer.id, reviewer.name);
    twin.proofs.set(decided.deliveryId, {
      photo: `deliveryPhotos/${business}/canhoto.jpg`,
      signature: `deliverySignatures/${business}/assinatura.png`,
    });

    const mirrored = await twin.listQueue(props);

    const shown = (rows: typeof real.data) =>
      rows.map((row) => ({
        id: row.id,
        photoUrl: row.photoUrl,
        signatureUrl: row.signatureUrl,
        reviewerName: row.reviewerName,
      }));

    expect(shown(real.data)).toEqual([
      {
        id: decided.id,
        photoUrl: `deliveryPhotos/${business}/canhoto.jpg`,
        signatureUrl: `deliverySignatures/${business}/assinatura.png`,
        reviewerName: reviewer.name,
      },
      {
        id: bare.id,
        photoUrl: null,
        signatureUrl: null,
        reviewerName: reviewer.name,
      },
    ]);
    expect(shown(mirrored.data)).toEqual(shown(real.data));
  });
});

describe("the agreement rate (DLVB-04)", () => {
  it("is counted in SQL over the window only, and matches the twin", async () => {
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "75222333000181",
    });

    const now = Date.now();

    const rows = [
      // Agreed: the model said fine, the person approved.
      await card(business, {
        status: "APPROVED",
        createdAt: new Date(now - 3 * DAY),
        reviewedAt: new Date(now - 2 * DAY),
        suggestion: suggestion("looks_good", 10),
      }),
      // Agreed: the model doubted, the person rejected.
      await card(business, {
        status: "REJECTED",
        createdAt: new Date(now - 3 * DAY),
        reviewedAt: new Date(now - 2 * DAY),
        suggestion: suggestion("looks_wrong", 1),
      }),
      // Disagreed: the model said fine, the person rejected.
      await card(business, {
        status: "REJECTED",
        createdAt: new Date(now - 3 * DAY),
        reviewedAt: new Date(now - 1 * DAY),
        suggestion: suggestion("looks_good", 10),
      }),
      // Outside the window: not counted, however it went.
      await card(business, {
        status: "REJECTED",
        createdAt: new Date(now - 200 * DAY),
        reviewedAt: new Date(now - 150 * DAY),
        suggestion: suggestion("looks_good", 10),
      }),
      // No suggestion: not a disagreement.
      await card(business, {
        status: "APPROVED",
        createdAt: new Date(now - 3 * DAY),
        reviewedAt: new Date(now - 1 * DAY),
      }),
    ];

    const { real, twin } = await bothRepositories(rows, {
      businessId: business,
      status: "PENDING",
      page: 1,
      pageSize: 10,
      agreementSince: new Date(now - 90 * DAY),
    });

    expect(real.meta.agreementRate).toBeCloseTo(2 / 3, 10);
    expect(twin.meta.agreementRate).toBeCloseTo(real.meta.agreementRate!, 10);
  });

  it("opens the window at the same instant whatever the connection's TimeZone", async () => {
    // reviewed_at is a naive UTC timestamp and Prisma binds a Date as
    // timestamptz; compared as they came, Postgres read the column in the
    // session's zone. On a São Paulo session a decision made an hour BEFORE
    // the window counted as three hours later, inside it.
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "70222333000181",
    });

    const since = new Date(Date.now() - 10 * DAY);
    const HOUR = 60 * 60 * 1000;

    const rows = [
      // Inside, agreed: the model doubted, the person rejected.
      await card(business, {
        status: "REJECTED",
        createdAt: new Date(since.getTime() - DAY),
        reviewedAt: new Date(since.getTime() + HOUR),
        suggestion: suggestion("looks_wrong", 1),
      }),
      // An hour outside, disagreed: must not be counted.
      await card(business, {
        status: "REJECTED",
        createdAt: new Date(since.getTime() - DAY),
        reviewedAt: new Date(since.getTime() - HOUR),
        suggestion: suggestion("looks_good", 10),
      }),
    ];

    const url = new URL(process.env.DATABASE_URL!);

    url.searchParams.set("connection_limit", "1");

    const zoned = new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });

    try {
      // One connection, so the SET is the zone of every query below.
      await zoned.$executeRawUnsafe(`SET TIME ZONE 'America/Sao_Paulo'`);

      const [{ TimeZone }] =
        await zoned.$queryRawUnsafe<Array<{ TimeZone: string }>>(
          "SHOW TIME ZONE",
        );

      expect(TimeZone).toBe("America/Sao_Paulo");

      const props: ListProofAuditsProps = {
        businessId: business,
        status: "PENDING",
        page: 1,
        pageSize: 1,
        agreementSince: since,
      };

      const onUtc = await new ProofAuditRepository(prisma).listQueue(props);
      const onSaoPaulo = await new ProofAuditRepository(zoned).listQueue(props);
      const mirrored = await twinWith(rows).listQueue(props);

      expect(onUtc.meta.agreementRate).toBe(1);
      expect(onSaoPaulo.meta.agreementRate).toBe(1);
      expect(mirrored.meta.agreementRate).toBe(1);
    } finally {
      await zoned.$disconnect();
    }
  });

  it("is published with its window over HTTP", async () => {
    const response = await list(
      company.managerToken,
      "status=PENDING&page=1&pageSize=1",
    );

    expect(parse(response.body).meta.searchMeta.agreementWindowDays).toBe(90);
  });
});

describe("what a card says about the automatic reading (DLVP-PROOF-4)", () => {
  it("follows the latest reading request of the delivery, and the company's plan", async () => {
    const business = randomUUID();

    const seed = await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "76222333000181",
    });

    const failed = await card(business, {
      status: "PENDING",
      createdAt: new Date(),
    });
    const running = await card(business, {
      status: "PENDING",
      createdAt: new Date(),
    });
    const quota = await card(business, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const period = await prisma.aIUsagePeriod.create({
      data: {
        businessId: business,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    const request = (
      recordId: string,
      status: "FAILED" | "PROCESSING" | "SKIPPED",
    ) =>
      prisma.aIAnalysisRequest.create({
        data: {
          idempotencyKey: randomUUID(),
          type: "DELIVERY_PROOF",
          recordId,
          businessId: business,
          periodId: period.id,
          requestedById: randomUUID(),
          input: {},
          status,
        },
      });

    await request(failed.deliveryId, "FAILED");
    await request(running.deliveryId, "PROCESSING");
    await request(quota.deliveryId, "SKIPPED");

    const withoutPlan = parse(
      (await list(seed.managerToken, "status=PENDING&page=1&pageSize=20")).body,
    );

    const stateOf = (cards: any[], id: string) =>
      cards.find((entry) => entry.id === id)?.aiState;

    expect(stateOf(withoutPlan.cards, failed.id)).toBe("failed");
    expect(stateOf(withoutPlan.cards, running.id)).toBe("analyzing");
    expect(stateOf(withoutPlan.cards, quota.id)).toBe("quota_exceeded");

    // Nothing was ever asked for this one, and the company has no reading.
    const never = await card(business, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const now = parse(
      (await list(seed.managerToken, "status=PENDING&page=1&pageSize=20")).body,
    );

    expect(stateOf(now.cards, never.id)).toBe("not_contracted");

    await prisma.business.update({
      where: { id: business },
      data: { ai_analysis_limit: 50 },
    });

    const contracted = parse(
      (await list(seed.managerToken, "status=PENDING&page=1&pageSize=20")).body,
    );

    expect(stateOf(contracted.cards, never.id)).toBe("analyzing");
  });

  it("resolves two requests created in the same instant by id, the same in the twin", async () => {
    const business = randomUUID();

    await seedFleetDriver(prisma, {
      businessId: business,
      cnpj: "77222333000181",
    });

    const pending = await card(business, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const period = await prisma.aIUsagePeriod.create({
      data: {
        businessId: business,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    // Written in id order: the twin used to keep the first one inserted,
    // Postgres breaks the tie with id DESC and answers the second.
    const [lowId, highId] = [randomUUID(), randomUUID()].sort();
    const sameInstant = new Date("2026-09-20T12:00:00.000Z");

    const requests = [];

    for (const [id, status] of [
      [lowId, "FAILED"],
      [highId, "PROCESSING"],
    ] as const) {
      requests.push(
        await prisma.aIAnalysisRequest.create({
          data: {
            id,
            idempotencyKey: randomUUID(),
            type: "DELIVERY_PROOF",
            recordId: pending.deliveryId,
            businessId: business,
            periodId: period.id,
            requestedById: randomUUID(),
            input: {},
            status,
            created_at: sameInstant,
          },
        }),
      );
    }

    const twin = twinWith([pending]);

    twin.analysisRequests = requests.map((request) => ({
      id: request.id,
      recordId: request.recordId,
      businessId: request.businessId,
      status: request.status,
      created_at: request.created_at,
    }));

    const props: ListProofAuditsProps = {
      businessId: business,
      status: "PENDING",
      page: 1,
      pageSize: 10,
      agreementSince: new Date(0),
    };

    const real = await new ProofAuditRepository(prisma).listQueue(props);
    const mirrored = await twin.listQueue(props);

    expect(real.data[0].analysisStatus).toBe("PROCESSING");
    expect(mirrored.data[0].analysisStatus).toBe(real.data[0].analysisStatus);
  });
});

describe("rejecting a receipt (DLVB-08)", () => {
  it("records the verdict and its occurrence together, or neither", async () => {
    const pending = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
    });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "refuse_rejection_occurrence_for_test"() RETURNS trigger AS $$
      BEGIN
        IF NEW."deliveryId" = '${pending.deliveryId}' THEN
          RAISE EXCEPTION 'occurrence refused by the test';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "refuse_rejection_occurrence_for_test"
        BEFORE INSERT ON "delivery_occurrence"
        FOR EACH ROW EXECUTE FUNCTION "refuse_rejection_occurrence_for_test"()
    `);

    let statusCode = 0;

    try {
      statusCode = (
        await review(company.managerToken, pending.id, COMPANY, {
          status: "REJECTED",
          rejection_reason: "Canhoto de outra entrega",
        })
      ).statusCode;
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "refuse_rejection_occurrence_for_test" ON "delivery_occurrence"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "refuse_rejection_occurrence_for_test"()`,
      );
    }

    expect(statusCode).toBeGreaterThanOrEqual(500);

    // The assertion this test exists for: no REJECTED card without its
    // occurrence. The card is still in the queue, so the person can retry.
    const after = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { id: pending.id },
    });

    expect(after.status).toBe("PENDING");
    expect(
      await prisma.deliveryOccurrence.count({
        where: { deliveryId: pending.deliveryId },
      }),
    ).toBe(0);

    const retry = await review(company.managerToken, pending.id, COMPANY, {
      status: "REJECTED",
      rejection_reason: "Canhoto de outra entrega",
    });

    expect(retry.statusCode, retry.body).toBe(200);

    const occurrence = await prisma.deliveryOccurrence.findFirstOrThrow({
      where: { deliveryId: pending.deliveryId },
      include: { occurrenceType: true },
    });

    expect(occurrence.description).toBe("Canhoto de outra entrega");
    expect(occurrence.occurrenceType.name).toBe("Comprovante rejeitado");
  });

  it("refuses a reason that breaks the text rules, and decides nothing", async () => {
    const pending = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
    });

    // One rule, one answer: "abc" was refused by the schema (VALIDATION_ERROR,
    // counted untrimmed) while "   abcd   " reached the use case.
    for (const rejection_reason of [
      "abc",
      "   abcd   ",
      "Foto  ilegível",
      "x".repeat(501),
    ]) {
      const response = await review(company.managerToken, pending.id, COMPANY, {
        status: "REJECTED",
        rejection_reason,
      });

      expect(response.statusCode, rejection_reason).toBe(400);
      expect(response.json().code, rejection_reason).toBe(
        "INVALID_REJECTION_REASON",
      );
    }

    for (const rejection_reason of [undefined, "", "     "]) {
      const response = await review(company.managerToken, pending.id, COMPANY, {
        status: "REJECTED",
        ...(rejection_reason === undefined ? {} : { rejection_reason }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("REJECTION_REASON_REQUIRED");
    }

    expect(
      (
        await prisma.deliveryProofAudit.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("judges the length after trimming, so a padded 498-character reason is accepted", async () => {
    // The schema counted the blanks and refused this as over 500.
    const pending = await card(COMPANY, {
      status: "PENDING",
      createdAt: new Date(),
    });

    const reason = `Canhoto ilegível: ${"a".repeat(480)}`;

    expect(reason).toHaveLength(498);

    const response = await review(company.managerToken, pending.id, COMPANY, {
      status: "REJECTED",
      rejection_reason: `     ${reason}     `,
    });

    expect(response.statusCode, response.body).toBe(200);

    const stored = await prisma.deliveryProofAudit.findUniqueOrThrow({
      where: { id: pending.id },
    });

    expect(stored.status).toBe("REJECTED");
    expect(stored.rejection_reason).toBe(reason);
  });
});

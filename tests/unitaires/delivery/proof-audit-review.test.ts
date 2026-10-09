import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewProofAuditUseCase } from "@/modules/delivery/usecases/review-proof-audit/review-proof-audit-usecase";
import { ListProofAuditsUseCase } from "@/modules/delivery/usecases/list-proof-audits/list-proof-audits-usecase";

import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { UploadService } from "@/shared/services/upload-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { ProofAuditSuggestion } from "@/modules/delivery/dtos/proof-audit-dto";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

// The use cases now wrap their write and the webhook they announce in one
// transaction. Against in-memory repositories the transaction is a plain
// passthrough — what it proves here is that the event is queued in the same
// unit of work, not that Postgres rolled anything back.
// The transaction client handed to the callback is a sentinel, so a test can
// tell a write made INSIDE the unit of work from one made after it.
const TX = vi.hoisted(() => ({ transaction: "proof-audit-review" }));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(TX),
  },
}));

// The socket is the delivery mechanism, not what is proven: the use case
// asking for the catalogue hint is.
const catalogChanged = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalogChanged }));


// Nothing here asserts on webhooks; the use cases simply require one.
const webhookStub = new InMemoryWebhookFanOutService();

/**
 * A person's verdict on a receipt photo.
 *
 * The audit that produced this slice recorded why this exists: an AI verdict
 * with nobody behind it does not close a probative cycle. So the machine
 * suggests and a human decides, and the two live in separate columns — which
 * is also the only reason it is possible to ask, later, how often the machine
 * was right.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const REVIEWER = "018f0000-0000-7000-8000-0000000000a1";
const SECOND_REVIEWER = "018f0000-0000-7000-8000-0000000000a3";

const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

let audits: InMemoryProofAuditRepository;
let deliveries: InMemoryDeliveryRepository;
let occurrenceTypes: InMemoryOccurrenceTypeRepository;

let review: ReviewProofAuditUseCase;
let list: ListProofAuditsUseCase;

let activity: string[];

beforeEach(() => {
  catalogChanged.mockReset();

  const users = new InMemoryUserRepository();

  audits = new InMemoryProofAuditRepository();
  deliveries = new InMemoryDeliveryRepository();

  occurrenceTypes = new InMemoryOccurrenceTypeRepository();

  users.user.push(
    { id: REVIEWER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: SECOND_REVIEWER,
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: "018f0000-0000-7000-8000-0000000000d1",
    } as User,
  );

  activity = [];

  const notifications = {
    createActivityIfEnabled: async (entry: { description: string }) => {
      activity.push(entry.description);
    },
  } as unknown as NotificationService;

  review = new ReviewProofAuditUseCase(
    users,
    audits,
    deliveries,
    occurrenceTypes,
    notifications,
    webhookStub.asService(),
  );

  list = new ListProofAuditsUseCase(users, audits, {
    getFileUrl: async (path: string) => `https://bucket.test/${path}`,
  } as unknown as UploadService);
});

/**
 * What the AI pipeline writes onto a PENDING card (ai-record-store's fenced
 * attachProofSuggestion, covered by the AI pipeline E2E), seeded directly.
 */
function seedSuggestion(
  deliveryId: string,
  businessId: string,
  value: ProofAuditSuggestion,
  confidence: number,
): void {
  const card = audits.audits.find(
    (entry) =>
      entry.deliveryId === deliveryId &&
      entry.businessId === businessId &&
      entry.status === "PENDING",
  );

  if (!card) return;

  card.ai_suggestion = value;
  card.ai_confidence = confidence;
  card.ai_analyzed_at = new Date();
}

function suggestion(
  kind: "looks_good" | "looks_wrong" | "needs_review",
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
    assessment: {
      suggestion: kind,
      failed: [],
      uncertain: [],
      reviewPriority: kind === "looks_good" ? 10 : 2,
    },
  };
}

async function enqueue(deliveryId = DELIVERY, businessId = BUSINESS) {
  // A card is about a delivery that exists: the rejection's occurrence copies
  // its tenant, and the twin answers P2025 for a missing one, like Prisma.
  if (!deliveries.deliveries.some((delivery) => delivery.id === deliveryId)) {
    deliveries.deliveries.push({
      id: deliveryId,
      businessId,
      shipperId: "shipper-1",
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "DELIVERED",
    });
  }

  return audits.enqueue(deliveryId, businessId);
}

describe("deciding on a receipt", () => {
  it("records who approved it and when", async () => {
    const card = await enqueue();

    const reviewed = await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    expect(reviewed.status).toBe("APPROVED");
    expect(reviewed.reviewedById).toBe(REVIEWER);

    expect(reviewed.reviewed_at).not.toBeNull();
  });

  it("refuses a rejection with no reason", async () => {
    // A receipt refused with no reason is a receipt nobody can act on: the
    // dispatcher cannot decide whether to send it back out, and the shipper
    // asking why gets silence.
    const card = await enqueue();

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "REJECTION_REASON_REQUIRED",
    });

    expect(audits.audits[0].status).toBe("PENDING");
  });

  it("leaves the rejection where the operation already looks", async () => {
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "REJECTED",
      rejection_reason: "Assinatura ilegível e sem data",
    });

    // The occurrence machinery, not a parallel record: the rejection lands in
    // the delivery's timeline, the occurrence listing and the occurrence
    // export the carrier sends its shipper.
    expect(deliveries.occurrences).toHaveLength(1);

    expect(deliveries.occurrences[0].description).toBe(
      "Assinatura ilegível e sem data",
    );

    expect(occurrenceTypes.occurrenceTypes[0].name).toBe(
      "Comprovante rejeitado",
    );
  });

  it("does not make the rejection flip the delivery to failed", async () => {
    // Whether the load goes back out is the dispatcher's call — they may have
    // a verbal confirmation the photo does not show. Doing it automatically on
    // the word of a queue takes that decision away.
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "REJECTED",
      rejection_reason: "Canhoto de outra entrega",
    });

    expect(occurrenceTypes.occurrenceTypes[0].blocks_delivery).toBe(false);
  });

  it("creates the occurrence type once, however many rejections there are", async () => {
    for (const deliveryId of ["d1", "d2", "d3"]) {
      const card = await enqueue(deliveryId);

      await review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Foto ilegível",
      });
    }

    expect(occurrenceTypes.occurrenceTypes).toHaveLength(1);
    expect(deliveries.occurrences).toHaveLength(3);
  });

  it("tells open catalogue screens once, when the first rejection creates the type", async () => {
    // "Comprovante rejeitado" shows up in the company's occurrence types;
    // without the hint a second dispatcher's screen missed it until F5.
    const approved = await enqueue("d0");

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: approved.id,
      status: "APPROVED",
    });

    expect(catalogChanged).not.toHaveBeenCalled();

    for (const deliveryId of ["d1", "d2"]) {
      const card = await enqueue(deliveryId);

      await review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Foto ilegível",
      });
    }

    expect(catalogChanged).toHaveBeenCalledTimes(1);
    expect(catalogChanged).toHaveBeenCalledWith(BUSINESS, "occurrence_type");
  });

  it("adds nothing to the catalogue for a card that was already decided", async () => {
    // A double click or a second reviewer on a stale screen: the card is
    // decided before the request arrives, so the rejection was impossible
    // from the start and must not leave a type or a hint behind.
    const card = await enqueue();

    await review.execute({
      userId: SECOND_REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Canhoto de outra entrega",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PROOF_AUDIT_ALREADY_REVIEWED",
    });

    expect(occurrenceTypes.occurrenceTypes).toHaveLength(0);
    expect(catalogChanged).not.toHaveBeenCalled();
    expect(deliveries.occurrences).toEqual([]);
  });

  it("still tells them when the verdict loses a race that began after the card was read", async () => {
    // The type is committed before the verdict's transaction, so when the
    // other decision lands between the read and the transaction, the 409
    // leaves a new catalogue entry that open screens must learn.
    const card = await enqueue();

    const ensure = occurrenceTypes.ensureByName.bind(occurrenceTypes);

    occurrenceTypes.ensureByName = async (...args) => {
      // The other reviewer's approval, through the same twin, mid-request.
      await audits.review({
        auditId: card.id,
        businessId: BUSINESS,
        reviewedById: SECOND_REVIEWER,
        status: "APPROVED",
        rejection_reason: null,
      });

      return ensure(...args);
    };

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Canhoto de outra entrega",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PROOF_AUDIT_ALREADY_REVIEWED",
    });

    expect(occurrenceTypes.occurrenceTypes).toHaveLength(1);
    expect(catalogChanged).toHaveBeenCalledWith(BUSINESS, "occurrence_type");
    expect(audits.audits[0].reviewedById).toBe(SECOND_REVIEWER);
    expect(deliveries.occurrences).toEqual([]);
  });

  it("names the decision in the activity trail", async () => {
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "REJECTED",
      rejection_reason: "Sem assinatura",
    });

    expect(activity[0]).toContain("rejeitado");
    expect(activity[0]).toContain("Sem assinatura");
  });
});

describe("two people opening the same card", () => {
  it("tells the second that somebody got there first", async () => {
    // Not a silent overwrite: the record of WHO decided is the point of the
    // queue, and the second reviewer must not quietly replace the first name
    // on it.
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    await expect(
      review.execute({
        userId: SECOND_REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Discordo do primeiro",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PROOF_AUDIT_ALREADY_REVIEWED",
    });

    expect(audits.audits[0].reviewedById).toBe(REVIEWER);
  });

  it("records no occurrence for the refused second verdict", async () => {
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    await expect(
      review.execute({
        userId: SECOND_REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Discordo",
      }),
    ).rejects.toBeTruthy();

    expect(deliveries.occurrences).toEqual([]);
  });
});

describe("who may review", () => {
  it("refuses a driver", async () => {
    // Auditing receipts is the office's job. A driver reviewing their own
    // proof is the one reviewer whose verdict means nothing.
    const card = await enqueue();

    await expect(
      review.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CANNOT_MANAGE_DELIVERIES" });
  });

  it("answers 404 USER_NOT_FOUND when the session's user row is gone", async () => {
    // Decision 11.3: not found is a 404 with a code. The controllers turned
    // this into a bare 400 { message }.
    const card = await enqueue();
    const ghost = "018f0000-0000-7000-8000-0000000000ff";

    await expect(
      review.execute({
        userId: ghost,
        businessId: BUSINESS,
        auditId: card.id,
        status: "APPROVED",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    await expect(
      list.execute({ userId: ghost, status: "PENDING", page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    expect(audits.audits[0].status).toBe("PENDING");
  });

  it("answers 404 for another company's card", async () => {
    const card = await enqueue(DELIVERY, OTHER_BUSINESS);

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "APPROVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PROOF_AUDIT_NOT_FOUND",
    });
  });
});

describe("a delivery proven again", () => {
  it("reopens the card and drops the old suggestion", async () => {
    // A re-proof is a new photo. The old verdict and the old suggestion are
    // about a picture that is no longer the one on file.
    const card = await enqueue();

    seedSuggestion(
      DELIVERY,
      BUSINESS,
      suggestion("looks_good"),
      0.9,
    );

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    await enqueue();

    expect(audits.audits).toHaveLength(1);

    expect(audits.audits[0].status).toBe("PENDING");
    expect(audits.audits[0].ai_suggestion).toBeNull();
    expect(audits.audits[0].reviewedById).toBeNull();
  });
});

describe("the queue a person opens", () => {
  it("puts the cards a human adds most to first", async () => {
    const clean = await enqueue("clean", BUSINESS);
    const unsure = await enqueue("unsure", BUSINESS);

    seedSuggestion(
      "clean",
      BUSINESS,
      suggestion("looks_good"),
      0.95,
    );

    seedSuggestion(
      "unsure",
      BUSINESS,
      suggestion("needs_review"),
      0.4,
    );

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    expect(result.data[0].id).toBe(unsure.id);
    expect(result.data[1].id).toBe(clean.id);
  });

  it("signs the proof's photo and signature and names who decided", async () => {
    // Through the twin, which used to answer null for all three: the signing
    // and the reviewer's name were invisible to every use-case test.
    const card = await enqueue(DELIVERY, BUSINESS);

    audits.proofs.set(DELIVERY, {
      photo: `deliveryPhotos/${BUSINESS}/canhoto.jpg`,
      signature: `deliverySignatures/${BUSINESS}/assinatura.png`,
    });
    audits.reviewers.set(REVIEWER, "Ana Revisora");

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "APPROVED",
      page: 1,
      pageSize: 10,
    });

    expect(result.data[0]).toMatchObject({
      id: card.id,
      photoUrl: `https://bucket.test/deliveryPhotos/${BUSINESS}/canhoto.jpg`,
      signatureUrl: `https://bucket.test/deliverySignatures/${BUSINESS}/assinatura.png`,
      reviewerName: "Ana Revisora",
    });
  });

  it("reports how often the machine and the person agreed", async () => {
    // The only number that answers whether the AI is worth paying for.
    const agreed = await enqueue("agreed", BUSINESS);
    const disagreed = await enqueue("disagreed", BUSINESS);

    seedSuggestion(
      "agreed",
      BUSINESS,
      suggestion("looks_good"),
      0.9,
    );

    seedSuggestion(
      "disagreed",
      BUSINESS,
      suggestion("looks_good"),
      0.9,
    );

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: agreed.id,
      status: "APPROVED",
    });

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: disagreed.id,
      status: "REJECTED",
      rejection_reason: "A máquina não viu que é de outra entrega",
    });

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "APPROVED",
      page: 1,
      pageSize: 10,
    });

    expect(result.meta.agreementRate).toBe(0.5);
  });

  it("has no agreement rate before anything was reviewed", async () => {
    await enqueue();

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    // Null, not zero: "nobody has reviewed anything" and "the machine is
    // always wrong" are different facts, and a zero would read as the second.
    expect(result.meta.agreementRate).toBeNull();
  });

  it("never shows another company's queue", async () => {
    await enqueue("mine", BUSINESS);
    await enqueue("theirs", OTHER_BUSINESS);

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].deliveryId).toBe("mine");
  });
});

describe("the rejection and its occurrence (DLVB-08)", () => {
  it("writes the occurrence inside the verdict's transaction", async () => {
    // It was written after the commit: a crash in between left a REJECTED
    // card with no occurrence on the delivery, and nothing retried it.
    const card = await enqueue();
    const create = vi.spyOn(deliveries, "createOccurrence");

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "REJECTED",
      rejection_reason: "Canhoto de outra entrega",
    });

    expect(create).toHaveBeenCalledTimes(1);
    // The in-memory signature omits `tx`; the use case passes it anyway.
    expect((create.mock.calls[0] as unknown[])[1]).toBe(TX);
  });

  it("judges the length of the reason after trimming it", async () => {
    const card = await enqueue();

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "   abcd   ",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REJECTION_REASON" });

    expect(audits.audits[0].status).toBe("PENDING");
    expect(deliveries.occurrences).toEqual([]);
  });

  it("refuses consecutive spaces inside a line, like every text field", async () => {
    const card = await enqueue();

    await expect(
      review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: card.id,
        status: "REJECTED",
        rejection_reason: "Foto  ilegível",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REJECTION_REASON" });

    expect(audits.audits[0].status).toBe("PENDING");
  });

  it("keeps the line breaks of a multi-line reason (decision 5.5)", async () => {
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "REJECTED",
      rejection_reason: "  Foto ilegível.\n\nSem data no canhoto.  ",
    });

    expect(audits.audits[0].rejection_reason).toBe(
      "Foto ilegível.\n\nSem data no canhoto.",
    );
    expect(deliveries.occurrences[0].description).toBe(
      "Foto ilegível.\n\nSem data no canhoto.",
    );
  });
});

describe("the order of each tab (DLVB-02)", () => {
  async function decided(
    deliveryId: string,
    status: "APPROVED" | "REJECTED",
    reviewedAt: string,
    createdAt: string,
  ) {
    const card = await enqueue(deliveryId, BUSINESS);

    card.created_at = new Date(createdAt);

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status,
      rejection_reason: status === "REJECTED" ? "Sem assinatura" : undefined,
    });

    card.reviewed_at = new Date(reviewedAt);

    return card;
  }

  it("lists the history by decision, newest first", async () => {
    // Oldest-first put a receipt approved just now on the last page, and the
    // screen only ever asked for the first one.
    const old = await decided("old", "APPROVED", "2026-09-20T10:00:00Z", "2026-09-01T10:00:00Z");
    const recent = await decided("recent", "APPROVED", "2026-09-28T10:00:00Z", "2026-08-01T10:00:00Z");
    const middle = await decided("middle", "APPROVED", "2026-09-25T10:00:00Z", "2026-09-10T10:00:00Z");

    const first = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "APPROVED",
      page: 1,
      pageSize: 2,
    });

    expect(first.data.map((card) => card.id)).toEqual([recent.id, middle.id]);
    expect(first.total).toBe(3);

    const second = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "APPROVED",
      page: 2,
      pageSize: 2,
    });

    expect(second.data.map((card) => card.id)).toEqual([old.id]);
  });

  it("does not reorder the history by the model's priority", async () => {
    const confident = await decided("confident", "REJECTED", "2026-09-28T10:00:00Z", "2026-09-01T10:00:00Z");
    const unsure = await decided("unsure", "REJECTED", "2026-09-27T10:00:00Z", "2026-09-02T10:00:00Z");

    confident.ai_suggestion = suggestion("looks_good");
    unsure.ai_suggestion = suggestion("needs_review");

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "REJECTED",
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((card) => card.id)).toEqual([confident.id, unsure.id]);
  });

  it("orders the queue by priority across pages, then oldest first", async () => {
    // Sorting inside a page made page 2 start with cards more urgent than
    // the end of page 1.
    const clean = await enqueue("clean", BUSINESS);
    const unsure = await enqueue("unsure", BUSINESS);
    const unread = await enqueue("unread", BUSINESS);

    clean.created_at = new Date("2026-09-01T10:00:00Z");
    unsure.created_at = new Date("2026-09-02T10:00:00Z");
    unread.created_at = new Date("2026-09-03T10:00:00Z");

    clean.ai_suggestion = suggestion("looks_good");
    unsure.ai_suggestion = suggestion("needs_review");

    const pages = [];

    for (const page of [1, 2, 3]) {
      const result = await list.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        status: "PENDING",
        page,
        pageSize: 1,
      });

      pages.push(result.data[0]?.id);
    }

    // No reading first, then the least sure, then the clean one.
    expect(pages).toEqual([unread.id, unsure.id, clean.id]);
  });
});

describe("the agreement rate's window (DLVB-04)", () => {
  it("counts only the decisions of the last 90 days, and says so", async () => {
    const recent = await enqueue("recent", BUSINESS);
    const ancient = await enqueue("ancient", BUSINESS);

    recent.ai_suggestion = suggestion("looks_good");
    ancient.ai_suggestion = suggestion("looks_good");

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: recent.id,
      status: "APPROVED",
    });

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: ancient.id,
      status: "REJECTED",
      rejection_reason: "Canhoto de outra entrega",
    });

    // Decided long before the window.
    ancient.reviewed_at = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    const result = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    expect(result.meta.agreementRate).toBe(1);
    expect(result.meta.agreementWindowDays).toBe(90);
  });

  it("starts the window at midnight in the company's zone, not São Paulo's or UTC's", async () => {
    // 28/09 12:00 in Manaus (UTC-4). The 90 days, today included, start on
    // 01/07 00:00 Manaus = 04:00 UTC. A decision at 03:30 UTC is 30/06 23:30
    // there, outside; São Paulo's midnight (03:00 UTC) or UTC's would count it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T16:00:00.000Z"));

    try {
      audits.businesses.set(BUSINESS, {
        timezone: "America/Manaus",
        ai_analysis_limit: 100,
      });

      const inside = await enqueue("inside", BUSINESS);
      const justBefore = await enqueue("just-before", BUSINESS);

      inside.ai_suggestion = suggestion("looks_good");
      justBefore.ai_suggestion = suggestion("looks_good");

      await review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: inside.id,
        status: "APPROVED",
      });

      await review.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        auditId: justBefore.id,
        status: "REJECTED",
        rejection_reason: "Canhoto de outra entrega",
      });

      inside.reviewed_at = new Date("2026-07-01T04:30:00.000Z");
      justBefore.reviewed_at = new Date("2026-07-01T03:30:00.000Z");

      const inManaus = await list.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        status: "PENDING",
        page: 1,
        pageSize: 10,
      });

      // Only the agreeing decision is inside the window.
      expect(inManaus.meta.agreementRate).toBe(1);

      // The same rows for a company in São Paulo: both decisions count.
      audits.businesses.set(BUSINESS, {
        timezone: "America/Sao_Paulo",
        ai_analysis_limit: 100,
      });

      const inSaoPaulo = await list.execute({
        userId: REVIEWER,
        businessId: BUSINESS,
        status: "PENDING",
        page: 1,
        pageSize: 10,
      });

      expect(inSaoPaulo.meta.agreementRate).toBe(0.5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the card says about the automatic reading (DLVP-PROOF-4)", () => {
  it("tells a company without the reading apart from a reading that failed", async () => {
    await enqueue("mine", BUSINESS);

    audits.businesses.set(BUSINESS, {
      timezone: "America/Sao_Paulo",
      ai_analysis_limit: 0,
    });

    const without = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    expect(without.data[0].aiState).toBe("not_contracted");

    audits.businesses.set(BUSINESS, {
      timezone: "America/Sao_Paulo",
      ai_analysis_limit: 100,
    });

    audits.analysisRequests.push({
      id: "018f0000-0000-7000-8000-0000000000f1",
      recordId: "mine",
      businessId: BUSINESS,
      status: "FAILED",
      created_at: new Date(),
    });

    const failed = await list.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      status: "PENDING",
      page: 1,
      pageSize: 10,
    });

    expect(failed.data[0].aiState).toBe("failed");
  });
});

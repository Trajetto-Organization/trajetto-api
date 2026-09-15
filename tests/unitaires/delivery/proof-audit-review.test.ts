import { beforeEach, describe, expect, it } from "vitest";

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
  );

  list = new ListProofAuditsUseCase(users, audits, {
    getFileUrl: async (path: string) => `https://bucket.test/${path}`,
  } as unknown as UploadService);
});

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

    await audits.attachSuggestion(
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

  it("ignores a model answer that lands after a person decided", async () => {
    // The model was thinking while somebody reviewed. A late answer must not
    // drag a decided card back into the queue.
    const card = await enqueue();

    await review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId: card.id,
      status: "APPROVED",
    });

    await audits.attachSuggestion(
      DELIVERY,
      BUSINESS,
      suggestion("looks_wrong"),
      0.9,
    );

    expect(audits.audits[0].status).toBe("APPROVED");
    expect(audits.audits[0].ai_suggestion).toBeNull();
  });
});

describe("the queue a person opens", () => {
  it("puts the cards a human adds most to first", async () => {
    const clean = await audits.enqueue("clean", BUSINESS);
    const unsure = await audits.enqueue("unsure", BUSINESS);

    await audits.attachSuggestion(
      "clean",
      BUSINESS,
      suggestion("looks_good"),
      0.95,
    );

    await audits.attachSuggestion(
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

  it("reports how often the machine and the person agreed", async () => {
    // The only number that answers whether the AI is worth paying for.
    const agreed = await audits.enqueue("agreed", BUSINESS);
    const disagreed = await audits.enqueue("disagreed", BUSINESS);

    await audits.attachSuggestion(
      "agreed",
      BUSINESS,
      suggestion("looks_good"),
      0.9,
    );

    await audits.attachSuggestion(
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
    await audits.enqueue("mine", BUSINESS);
    await audits.enqueue("theirs", OTHER_BUSINESS);

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

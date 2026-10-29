import { describe, expect, it } from "vitest";

import {
  assessProof,
  describeAssessment,
  describeProblems,
  driverFeedbackFor,
} from "@/shared/ai/proof-criteria";
import { getNotificationPolicy } from "@/shared/notifications/notification-policy";
import {
  proofAIFeedbackPolicy,
  renderProofFeedbackInApp,
  renderProofFeedbackPush,
} from "@/shared/notifications/policies/proof-ai-feedback-policy";

/**
 * The driver hears that the receipt they sent looks wrong (decision 6.9):
 * push and in-app, a suggestion and not a verdict.
 */
// Built the way the pipeline builds it (publishProofFeedback): the failed
// criteria of a real assessment, as problems.
const assessment = assessProof({
  isReceipt: "yes",
  legible: "yes",
  hasSignature: "no",
  documentMatches: "no",
  dateVisible: "yes",
  photoQuality: 0.9,
  confidence: 0.9,
  observation: "Sem assinatura; número diferente.",
});

const payload = {
  businessId: "biz-1",
  deliveryId: "del-1",
  driverUserId: "driver-user-1",
  recipientName: "Mercado Central",
  problems: describeProblems(assessment.failed),
  summary: describeAssessment(assessment),
};

const users = (user: Record<string, unknown> | null) =>
  ({
    userRepository: { findUserById: async () => user },
  }) as never;

describe("delivery-proof.ai-flagged", () => {
  it("is a registered topic", () => {
    expect(getNotificationPolicy("delivery-proof.ai-flagged")).toBe(
      proofAIFeedbackPolicy,
    );
  });

  it("reaches the driver who proved it, by push and in the app, never by e-mail", async () => {
    const driver = {
      id: "driver-user-1",
      businessId: "biz-1",
      role: "BUSINESS_USER",
    };

    expect(
      await proofAIFeedbackPolicy.resolveRecipients(payload, users(driver)),
    ).toEqual([driver]);

    expect(proofAIFeedbackPolicy.renderPush).toBeDefined();
    expect(proofAIFeedbackPolicy.renderInApp).toBeDefined();
    expect(proofAIFeedbackPolicy.suppressEmail).toBe(true);
    expect(proofAIFeedbackPolicy.mandatory).toBe(true);
  });

  it("reaches nobody when that user is no longer in the company", async () => {
    expect(
      await proofAIFeedbackPolicy.resolveRecipients(
        payload,
        users({ id: "driver-user-1", businessId: "biz-2" }),
      ),
    ).toEqual([]);
  });

  it("says what looked wrong, for which delivery, and that the office decides", () => {
    const push = renderProofFeedbackPush(payload);

    expect(push.title).toBe("Comprovante com possível problema");
    expect(push.body).toContain("Entrega para Mercado Central.");
    // Red before: "apontou: tem assinatura; o número da NF-e confere." —
    // the positive labels, the opposite of what was wrong.
    expect(push.body).toContain(
      "A leitura automática apontou: não foi encontrada assinatura; " +
        "o número da NF-e lido não é o desta entrega.",
    );
    expect(push.body).not.toContain("tem assinatura");
    expect(push.body).not.toContain("confere");
    expect(push.body).toContain("A equipe vai revisar o comprovante.");
    expect(push.data).toMatchObject({
      url: "/deliveries",
      type: "delivery-proof.ai-flagged",
      entityId: "del-1",
    });

    const inApp = renderProofFeedbackInApp(payload, {
      baseUrl: "https://app.trajetto.com",
    });

    expect(inApp).toMatchObject({
      title: "Comprovante com possível problema",
      message: push.body,
      entityId: "del-1",
    });
  });

  it("says the photo could not be read, when it could not", () => {
    const unreadable = {
      isReceipt: "unknown",
      legible: "unknown",
      hasSignature: "unknown",
      documentMatches: "unknown",
      dateVisible: "unknown",
      photoQuality: 0.1,
      confidence: 0.2,
      observation: "Foto borrada.",
    } as const;

    const feedback = driverFeedbackFor(unreadable, assessProof(unreadable));

    expect(feedback).not.toBeNull();

    const push = renderProofFeedbackPush({ ...payload, ...feedback! });

    expect(push.body).toBe(
      "Entrega para Mercado Central. A leitura automática apontou: a foto está " +
        "ruim demais para leitura. Se ainda estiver no local, confira o canhoto " +
        "com o destinatário. A equipe vai revisar o comprovante.",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  masterUserWelcomedPolicy,
  masterUserCreatedPolicy,
  masterUserUpdatedPolicy,
  masterUserAccountUpdatedPolicy,
} from "@/shared/notifications/policies/master-user-policies";

const ctx = { baseUrl: "https://app.trajetto.com" };
const recipient = { id: "u1", role: "MASTER", driverId: null };

/**
 * Each master operation speaks to two people through two topics. These tests
 * pin the seams: who each topic addresses, and that the welcome stays out of
 * the inbox (its real content — the credentials — already went as e-mail).
 */
describe("master-user topics", () => {
  it("welcome suppresses e-mail and has no WhatsApp", () => {
    expect(masterUserWelcomedPolicy.suppressEmail).toBe(true);
    expect(masterUserWelcomedPolicy.renderWhatsApp).toBeUndefined();
    expect(masterUserWelcomedPolicy.renderActivity).toBeUndefined();
  });

  it("created speaks to the performer, welcomed to the new master", () => {
    const created = masterUserCreatedPolicy.renderInApp!(
      {
        masterUserId: "m1",
        masterName: "Novo Master",
        masterEmail: "novo@trajetto.com",
        actorUserId: "u1",
      },
      ctx,
      recipient,
    );

    expect(created.message).toContain("Você criou");
    expect(created.link).toContain("/admin/master-users?search=m1");

    const welcomed = masterUserWelcomedPolicy.renderInApp!(
      {
        masterUserId: "m1",
        performingUserName: "Gabriel",
        performingUserEmail: "gabriel@trajetto.com",
      },
      ctx,
      recipient,
    );

    expect(welcomed.title).toBe("Bem-vindo ao Trajetto");
    expect(welcomed.message).toContain("Gabriel");
  });

  /**
   * The use case mails the edited master directly, with the old and new
   * name or e-mail (update-master-user-usecase.ts), so the pipeline's copy
   * of the same event was a second e-mail in the same inbox (decision
   * D-52). The notice itself stays: bell and phone cannot be silenced.
   */
  it("account-updated sends no second e-mail, and stays mandatory with its WhatsApp", () => {
    expect(masterUserAccountUpdatedPolicy.suppressEmail).toBe(true);
    expect(masterUserAccountUpdatedPolicy.mandatory).toBe(true);
    expect(masterUserAccountUpdatedPolicy.renderWhatsApp).toBeDefined();
  });

  it("keeps the confirmations of the master's own act as they were (decision D-49)", () => {
    for (const policy of [masterUserCreatedPolicy, masterUserUpdatedPolicy]) {
      expect(policy.suppressEmail).toBeUndefined();
      expect(policy.renderWhatsApp).toBeDefined();
    }
  });

  it("account-updated tells the affected master who changed what", () => {
    const rendered = masterUserAccountUpdatedPolicy.renderInApp!(
      {
        masterUserId: "m1",
        masterName: "Master Alvo",
        changesNotificationText: "nome: A → B, senha",
        performingUserName: "Gabriel",
        performingUserEmail: "gabriel@trajetto.com",
      },
      ctx,
      recipient,
    );

    expect(rendered.title).toBe("Sua Conta Foi Atualizada");
    expect(rendered.message).toContain("nome: A → B, senha");
    expect(rendered.link).toBe("https://app.trajetto.com/profile");
  });
});

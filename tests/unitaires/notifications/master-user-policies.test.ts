import { describe, expect, it } from "vitest";

import {
  masterUserWelcomedPolicy,
  masterUserCreatedPolicy,
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

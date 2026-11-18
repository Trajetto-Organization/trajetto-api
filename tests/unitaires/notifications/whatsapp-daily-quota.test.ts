import { describe, expect, it } from "vitest";

import { InMemoryProviderQuotaRepository } from "@/shared/services/provider-quota/in-memory-provider-quota-repository";
import { createWhatsAppDailyQuota } from "@/shared/notifications/whatsapp-daily-quota";
import { whatsAppQuotaReachedPolicy } from "@/shared/notifications/policies/whatsapp-quota-policy";

/**
 * Each company's daily WhatsApp quota (plano-escala F3-15b; decision D46):
 * counted per company and business day, in the company's own time zone;
 * past it, the wait runs to the start of the company's next business day;
 * off, or for the platform's own messages, nothing is counted.
 */
function quotaWith(limit: number, now: Date, timeZone = "America/Sao_Paulo") {
  const repository = new InMemoryProviderQuotaRepository();

  return {
    repository,
    quota: createWhatsAppDailyQuota({
      quota: repository,
      limit: () => limit,
      timeZoneOf: async () => timeZone,
      now: () => now,
    }),
  };
}

describe("the company's daily WhatsApp quota", () => {
  it("lets three through and holds the fourth until the company's next day", async () => {
    const { quota } = quotaWith(3, new Date("2026-11-18T15:00:00Z"));

    for (let n = 0; n < 3; n += 1) {
      expect(await quota.take("empresa-a")).toEqual({ allowed: true });
    }

    expect(await quota.take("empresa-a")).toEqual({
      allowed: false,
      day: "2026-11-18",
      limit: 3,
      // Midnight in São Paulo (UTC−3).
      until: new Date("2026-11-19T03:00:00Z"),
    });

    // Another company's day is its own.
    expect(await quota.take("empresa-b")).toEqual({ allowed: true });
  });

  it("counts by the company's business day, not the server's UTC day", async () => {
    // 01:30 UTC on the 19th is still the 18th in São Paulo.
    const { quota, repository } = quotaWith(
      1,
      new Date("2026-11-19T01:30:00Z"),
    );

    await quota.take("empresa-a");

    expect([...repository.rows.keys()]).toEqual([
      "whatsapp|whatsapp:empresa-a|2026-11-18",
    ]);
  });

  it("counts nothing with the quota off, nor for the platform's own messages", async () => {
    const off = quotaWith(0, new Date());

    expect(await off.quota.take("empresa-a")).toEqual({ allowed: true });
    expect(off.repository.rows.size).toBe(0);

    const platform = quotaWith(3, new Date());

    expect(await platform.quota.take(null)).toEqual({ allowed: true });
    expect(platform.repository.rows.size).toBe(0);
  });
});

describe("the admins' notice", () => {
  it("goes to the bell only, and says when the held messages go out", () => {
    expect(whatsAppQuotaReachedPolicy.mandatory).toBe(true);
    expect(whatsAppQuotaReachedPolicy.suppressEmail).toBe(true);
    expect(whatsAppQuotaReachedPolicy.renderWhatsApp).toBeUndefined();

    const rendered = whatsAppQuotaReachedPolicy.renderInApp!(
      {
        businessId: "empresa-a",
        day: "2026-11-18",
        limit: 3,
        resumesOn: "2026-11-19",
      },
      { baseUrl: "https://app.example.com" },
      { id: "admin" },
    );

    expect(rendered.title).toBe("Cota diária de WhatsApp atingida");
    expect(rendered.message).toContain("as 3 mensagens");
    expect(rendered.message).toContain("a partir de 19/11/2026");
    expect(rendered.message).toContain("nenhuma vai por e-mail");
  });
});

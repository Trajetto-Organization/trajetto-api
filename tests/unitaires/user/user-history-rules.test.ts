import { describe, expect, it } from "vitest";

import {
  describeUserHistory,
  NO_USER_HISTORY,
  userHistoryRefusal,
} from "@/modules/user/user-history-rules";

/**
 * Deleting a login is for one made by mistake (batch of 14/11/2026): the
 * refusal says what holds the login and points to "Revogar acesso". The
 * delete used to count only service orders and payables; every other record
 * the person authored reached the database's RESTRICT key and came back as a
 * generic "por exemplo" with no count.
 */
describe("userHistoryRefusal", () => {
  it("answers nothing for a login without history", () => {
    expect(userHistoryRefusal(NO_USER_HISTORY)).toBeNull();
  });

  it("puts service orders first, then payables, with their own codes and counts", () => {
    const orders = userHistoryRefusal({
      ...NO_USER_HISTORY,
      serviceOrders: 2,
      accountPayables: 1,
      deliveryEvents: 9,
    });

    expect(orders?.code).toBe("USER_HAS_SERVICE_ORDERS");
    expect(orders?.statusCode).toBe(409);
    expect(orders?.message).toContain("2 ordem(ns) de serviço");

    const payables = userHistoryRefusal({
      ...NO_USER_HISTORY,
      accountPayables: 3,
      chatMessages: 1,
    });

    expect(payables?.code).toBe("USER_HAS_ACCOUNT_PAYABLES");
    expect(payables?.message).toContain("3 conta(s) a pagar");
  });

  // Finishing an order or paying a bill frees nothing: the finished order
  // keeps its responsible. Only handing it over or revoking does.
  it("offers only what frees the login for orders and payables", () => {
    for (const counts of [
      { ...NO_USER_HISTORY, serviceOrders: 1 },
      { ...NO_USER_HISTORY, accountPayables: 1 },
    ]) {
      const message = userHistoryRefusal(counts)?.message ?? "";

      expect(message).toMatch(/transferir a responsabilidade/i);
      expect(message).toMatch(/revogar o acesso/i);
      expect(message).not.toMatch(/finalizar|cancelar|quitar/i);
    }
  });

  it("counts every kind of record in one sentence that points to revoking", () => {
    const refusal = userHistoryRefusal({
      ...NO_USER_HISTORY,
      deliveryEvents: 12,
      chatMessages: 3,
    });

    expect(refusal?.code).toBe("USER_HAS_RECORDS");
    expect(refusal?.statusCode).toBe(409);
    expect(refusal?.message).toContain(
      "12 evento(s) de entrega e 3 mensagem(ns) no chat",
    );
    expect(refusal?.message).toContain('"Revogar acesso"');
    expect(refusal?.message).not.toContain("por exemplo");
  });
});

describe("describeUserHistory", () => {
  it("names nothing without history", () => {
    expect(describeUserHistory(NO_USER_HISTORY)).toBeNull();
  });

  it("lists the kinds in a fixed order, joined with commas and a final 'e'", () => {
    expect(
      describeUserHistory({
        ...NO_USER_HISTORY,
        imports: 1,
        occurrences: 2,
        proofReviews: 4,
        deliveryEvents: 5,
      }),
    ).toBe(
      "5 evento(s) de entrega, 2 ocorrência(s), 4 revisão(ões) de comprovante e 1 importação(ões)",
    );
  });

  it("says a single kind alone", () => {
    expect(describeUserHistory({ ...NO_USER_HISTORY, imports: 1 })).toBe(
      "1 importação(ões)",
    );
  });
});

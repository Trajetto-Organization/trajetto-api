import { describe, expect, it } from "vitest";

import {
  DELIVERY_STATUS_LABELS,
  canTransitionDelivery,
  isDeliveryEditable,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";

/**
 * The delivery status machine as a whole table (mutation run 06/10: single
 * entries of DELIVERY_TRANSITIONS and of the labels could change with every
 * test green). Every pair is asserted, so a move added or dropped by accident
 * is caught here before any E2E.
 */

const STATUSES: DeliveryStatus[] = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
];

const ALLOWED: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "FAILED", "PENDING", "CANCELLED"],
  FAILED: ["PENDING", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

describe("canTransitionDelivery, every pair", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;

      const allowed = ALLOWED[from].includes(to);

      it(`${from} → ${to} is ${allowed ? "allowed" : "refused"}`, () => {
        expect(canTransitionDelivery(from, to)).toEqual(
          allowed
            ? { allowed: true, reason: null }
            : {
                allowed: false,
                reason: `Não é possível mudar a entrega de "${DELIVERY_STATUS_LABELS[from]}" para "${DELIVERY_STATUS_LABELS[to]}".`,
              },
        );
      });
    }
  }
});

describe("labels and editability", () => {
  it("names every status in pt-BR", () => {
    expect(DELIVERY_STATUS_LABELS).toEqual({
      PENDING: "Pendente",
      IN_TRANSIT: "Em rota",
      DELIVERED: "Entregue",
      FAILED: "Insucesso",
      CANCELLED: "Cancelada",
    });
  });

  it("lets the panel edit only pending and failed deliveries", () => {
    expect(STATUSES.filter(isDeliveryEditable)).toEqual(["PENDING", "FAILED"]);
  });
});

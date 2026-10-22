import { describe, expect, it } from "vitest";

import { buildTrackingView } from "@/shared/delivery/customer-tracking";
import type { TrackingSource } from "@/modules/delivery/repositories/IExternal-recipient-repository";

/**
 * What a stranger holding the link can see.
 *
 * The link is the authorisation — no login, no session — and it gets forwarded
 * in family groups and pasted into chats. So the tests that matter here are
 * the NEGATIVE ones: the page has to answer "where is my thing" without ever
 * becoming a window on the carrier's operation.
 *
 * This is a security decision, which is why it lives in a pure function. A
 * security decision that needs a database to test is one nobody tests.
 */
const PUBLIC_BASE = "https://app.trajetto.com.br";

function source(overrides: Partial<TrackingSource> = {}): TrackingSource {
  return {
    recipient: {
      id: "018f0000-0000-7000-8000-0000000000r1",
      name: "Maria Souza",
      email: "maria@exemplo.com.br",
      telephone: "11999999999",
      access_token: "a".repeat(64),
      expires_at: null,
      opted_out_at: null,
      deliveryId: "018f0000-0000-7000-8000-0000000000e1",
      businessId: "018f0000-0000-7000-8000-00000000000b",
      created_at: new Date("2026-09-16T09:00:00.000Z"),
    },

    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-4471",
      status: "IN_TRANSIT",
      invoice_number: "12345",
      recipient_name: "Padaria Central Ltda",
      city: "São Paulo",
      uf: "SP",
      scheduled_date: new Date("2026-09-16T12:00:00.000Z"),
      delivered_at: null,
      received_by: null,
      business: {
        corporate_reason: "Transportes Silva Ltda",
        fantasy_name: "Silva Log",
      },
    },

    events: [
      {
        created_at: new Date("2026-09-16T11:00:00.000Z"),
        type: "ARRIVAL",
        note: "portaria mandou esperar, cliente é chato",
      },
    ],

    occurrences: [
      {
        created_at: new Date("2026-09-16T11:30:00.000Z"),
        typeName: "Destinatário ausente",
        description: "ninguém atende, prédio parece abandonado",
      },
    ],

    proofToken: null,

    ...overrides,
  };
}

function build(overrides: Partial<TrackingSource> = {}) {
  return buildTrackingView(source(overrides), { publicBaseUrl: PUBLIC_BASE });
}

describe("what the customer gets to know", () => {
  it("answers where their delivery is and when it was promised", () => {
    const view = build();

    expect(view.statusLabel).toBe("Em rota");
    expect(view.recipientName).toBe("Padaria Central Ltda");

    expect(view.invoiceNumber).toBe("12345");
    expect(view.scheduledDate).toBeTruthy();
  });

  it("names the carrier, because that is who they will call", () => {
    expect(build().carrierName).toBe("Silva Log");
  });

  it("tells them the driver arrived, in their words", () => {
    const [newest] = build().events;

    expect(newest.title).toBe("Destinatário ausente");
    expect(build().events[1].title).toBe("O entregador chegou ao endereço");
  });

  it("orders the events newest first", () => {
    const stamps = build().events.map((event) => new Date(event.at).getTime());

    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it("links the receipt once it exists, and the public page rather than the file", () => {
    // One door, one story about whether the document is genuine.
    const token = "b".repeat(64);

    expect(build({ proofToken: token }).proofUrl).toBe(
      `${PUBLIC_BASE}/verificar/${token}`,
    );

    expect(build().proofUrl).toBeNull();
  });
});

describe("what never crosses", () => {
  it("does not carry the note the driver wrote to the office", () => {
    // Written by somebody in the street, to their own company, and regularly
    // blunt. The customer is not the audience.
    const printed = JSON.stringify(build());

    expect(printed).not.toContain("portaria mandou esperar");
    expect(printed).not.toContain("cliente é chato");
  });

  it("does not carry the free text of an occurrence either", () => {
    const printed = JSON.stringify(build());

    // The TYPE crosses — it is exactly what they need to hear.
    expect(printed).toContain("Destinatário ausente");

    // The description does not.
    expect(printed).not.toContain("prédio parece abandonado");
    expect(printed).not.toContain("ninguém atende");
  });

  it("does not expose any internal identifier", () => {
    // A leaked link must show a delivery's progress, not hand somebody ids to
    // walk.
    const printed = JSON.stringify(build());

    expect(printed).not.toContain(source().delivery.id);
    expect(printed).not.toContain(source().recipient.businessId);
    expect(printed).not.toContain(source().recipient.id);
  });

  it("does not leak the recipient's own contact details back out", () => {
    // The token is forwarded; the phone number of whoever the carrier holds on
    // file is not the forwarder's to give away.
    const printed = JSON.stringify(build());

    expect(printed).not.toContain("11999999999");
    expect(printed).not.toContain("maria@exemplo.com.br");
  });

  it("does not carry the token itself", () => {
    expect(JSON.stringify(build())).not.toContain("a".repeat(64));
  });

  it("shows only the city, not the street they live on", () => {
    const view = build();

    expect(view.city).toBe("São Paulo");

    // There is no street field at all — the person already knows where they
    // live, and a forwarded link should not print it for everybody else.
    expect(Object.keys(view)).not.toContain("street");
    expect(Object.keys(view)).not.toContain("address_number");
  });
});

describe("a delivery that ended", () => {
  it("says when and to whom", () => {
    const view = build({
      delivery: {
        ...source().delivery,
        status: "DELIVERED",
        delivered_at: new Date("2026-09-16T13:30:00.000Z"),
        received_by: "Maria Souza",
      },
    });

    expect(view.statusLabel).toBe("Entregue");
    expect(view.receivedBy).toBe("Maria Souza");
    expect(view.deliveredAt).toBeTruthy();
  });

  it("falls back to the corporate name when there is no trading name", () => {
    const view = build({
      delivery: {
        ...source().delivery,
        business: {
          corporate_reason: "Transportes Silva Ltda",
          fantasy_name: null,
        },
      },
    });

    expect(view.carrierName).toBe("Transportes Silva Ltda");
  });
});

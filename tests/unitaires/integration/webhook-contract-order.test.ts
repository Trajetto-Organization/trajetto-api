import { describe, expect, it } from "vitest";

import { buildPublicApiDocument } from "@/shared/integration/public-docs";

/**
 * What the public reference says about order, duplicates and refusing one
 * event — the three things a receiver gets wrong when the text is silent.
 *
 * - Order: delivery is concurrent and retried, so an ERP that applied the
 *   last event it received moved a delivered order back to "in transit".
 * - Duplicates: the cause a receiver cannot guess (our process dying between
 *   their 200 and our record of it) is the one worth naming.
 * - 410: it switches off the WHOLE endpoint, which a receiver using it to
 *   refuse one event would not expect.
 */
const document = buildPublicApiDocument({});

const description = String(document.info?.description);

const envelope = (
  document.components as {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  }
).schemas.WebhookEnvelope;

describe("the order of events", () => {
  it("is carried by `sequence`, which the envelope publishes", () => {
    expect(envelope.properties).toHaveProperty("sequence");
    expect(description).toContain("{ id, sequence, topic, created_at, data }");
  });

  it("is explained: not in order, apply only a greater sequence", () => {
    expect(description).toMatch(/não chegam em ordem/);
    expect(description).toMatch(/sequence` dele for\s+maior/);
  });
});

describe("duplicates and refusals", () => {
  it("names a crash between the answer and our record as a cause of duplicates", () => {
    expect(description).toMatch(/processo cai entre a sua resposta e o nosso\s+registro/);
  });

  it("says a 410 switches the whole endpoint off, and how to refuse one event", () => {
    expect(description).toMatch(/410 Gone[\s\S]*endpoint inteiro/);
    expect(description).toMatch(/responda 2xx e ignore-o/);
  });

  it("says what happens to events while the endpoint is switched off", () => {
    // They used to be dropped while the breaker was open; they are held now,
    // and an integrator needs to know saving the endpoint releases them.
    expect(description).toMatch(/ficam guardados por até 30 dias/);
    expect(description).toMatch(/salvo ativo de novo/);
  });

  it("does not promise to keep what happens while the customer paused it", () => {
    // Pausing is unsubscribing: the fan-out writes no row for a paused
    // endpoint, and only what was already queued waits for it. A reference
    // saying "desligado ou pausado, os eventos ficam guardados" had an
    // integrator pause for a migration and expect the gap to be replayed.
    expect(description).not.toMatch(/desligado ou pausado, os eventos ficam guardados/);
    expect(description).toMatch(/eventos gerados durante a pausa não são guardados/);
  });
});

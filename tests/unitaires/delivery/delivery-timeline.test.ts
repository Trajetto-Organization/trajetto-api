import { describe, expect, it } from "vitest";

import {
  buildDeliveryTimeline,
  type TimelineSources,
} from "@/shared/delivery/delivery-timeline";

/**
 * What the SAC reads when somebody asks "onde está a nota X, e por que ela
 * está assim?".
 *
 * The timeline MERGES the tables that already own these facts — an arrival in
 * delivery_event, a typed occurrence in delivery_occurrence, a message in
 * chat_message — rather than copying them into a table of its own. Two writers
 * for one fact is how a fact starts disagreeing with itself.
 *
 * So what there is to get wrong is the merge, and the merge is pure. No
 * database here, on purpose: what support sees is a product decision, and a
 * product decision that needs a database to test is one nobody tests.
 */
const AT = (iso: string) => new Date(iso);

function sources(overrides: Partial<TimelineSources> = {}): TimelineSources {
  return { events: [], occurrences: [], messages: [], ...overrides };
}

describe("the order it comes back in", () => {
  it("puts the newest first, whatever table it came from", () => {
    const timeline = buildDeliveryTimeline(
      sources({
        events: [
          {
            id: "e1",
            type: "ARRIVAL",
            created_at: AT("2026-09-15T10:00:00Z"),
          },
        ],
        occurrences: [
          {
            id: "o1",
            created_at: AT("2026-09-15T12:00:00Z"),
            occurrenceType: { name: "Cliente ausente" },
          },
        ],
        messages: [
          {
            id: "m1",
            kind: "TEXT",
            body: "Já passei lá",
            created_at: AT("2026-09-15T11:00:00Z"),
          },
        ],
      }),
    );

    expect(timeline.map((entry) => entry.id)).toEqual(["o1", "m1", "e1"]);
  });

  it("breaks a tie the same way every time", () => {
    // A proof and the status it stamped are written in one transaction and
    // can share a timestamp. Without a deterministic tiebreak the support
    // screen reorders itself on refresh, which is a screen nobody trusts.
    const same = AT("2026-09-15T10:00:00Z");

    const first = buildDeliveryTimeline(
      sources({
        events: [
          { id: "a", type: "PROOF", created_at: same },
          { id: "b", type: "STATUS_CHANGE", created_at: same },
        ],
      }),
    );

    const second = buildDeliveryTimeline(
      sources({
        events: [
          { id: "b", type: "STATUS_CHANGE", created_at: same },
          { id: "a", type: "PROOF", created_at: same },
        ],
      }),
    );

    expect(first.map((entry) => entry.id)).toEqual(
      second.map((entry) => entry.id),
    );
  });

  it("accepts dates that arrived as strings", () => {
    // A cached or serialised payload carries ISO strings, not Date objects.
    const timeline = buildDeliveryTimeline(
      sources({
        events: [
          { id: "e1", type: "ARRIVAL", created_at: "2026-09-15T10:00:00.000Z" },
          { id: "e2", type: "PROOF", created_at: "2026-09-15T11:00:00.000Z" },
        ],
      }),
    );

    expect(timeline.map((entry) => entry.id)).toEqual(["e2", "e1"]);
  });

  it("answers an empty list for a delivery nothing happened to", () => {
    expect(buildDeliveryTimeline(sources())).toEqual([]);
    expect(buildDeliveryTimeline({})).toEqual([]);
  });
});

describe("a status moved by hand", () => {
  const override = sources({
    events: [
      {
        id: "e1",
        type: "STATUS_CHANGE",
        created_at: AT("2026-09-15T10:00:00Z"),
        actor: "USER",
        status_from: "IN_TRANSIT",
        status_to: "FAILED",
        reason: { name: "Cliente recusou a mercadoria" },
        note: "Cliente ligou às 14h.",
        reportedBy: { name: "Operadora do SAC" },
      },
    ],
  });

  it("says both ends of the move in Portuguese", () => {
    const [entry] = buildDeliveryTimeline(override);

    expect(entry.title).toContain("Em rota");
    expect(entry.title).toContain("Insucesso");
  });

  it("puts the reason in the title, not buried in the detail", () => {
    // It is the sentence support is scanning for. Under a note that may not
    // exist, the answer would be hidden half the time.
    const [entry] = buildDeliveryTimeline(override);

    expect(entry.title).toContain("Cliente recusou a mercadoria");
    expect(entry.detail).toBe("Cliente ligou às 14h.");
  });

  it("keeps both ends machine-readable too", () => {
    const [entry] = buildDeliveryTimeline(override);

    expect(entry.statusFrom).toBe("IN_TRANSIT");
    expect(entry.statusTo).toBe("FAILED");
    expect(entry.reason).toBe("Cliente recusou a mercadoria");
  });

  it("names who did it", () => {
    const [entry] = buildDeliveryTimeline(override);

    expect(entry.author).toEqual({
      kind: "USER",
      name: "Operadora do SAC",
      device: null,
    });
  });
});

describe("what the driver did", () => {
  it("names the phone on an app event, because support is asked which one", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        events: [
          {
            id: "e1",
            type: "ARRIVAL",
            created_at: AT("2026-09-15T10:00:00Z"),
            actor: "DRIVER_APP",
            device: "Moto G84 · 3f9a",
            latitude: -23.55,
            longitude: -46.63,
            reportedBy: { name: "João" },
          },
        ],
      }),
    );

    expect(entry.author).toEqual({
      kind: "DRIVER_APP",
      name: "João",
      device: "Moto G84 · 3f9a",
    });

    expect(entry.location).toEqual({ latitude: -23.55, longitude: -46.63 });
  });

  it("carries the receipt photo and the signature together", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        events: [
          {
            id: "e1",
            type: "PROOF",
            created_at: AT("2026-09-15T10:00:00Z"),
            photo: "https://signed/canhoto.jpg",
            signature: "https://signed/assinatura.png",
            received_by: "Porteiro",
          },
        ],
      }),
    );

    expect(entry.photos).toEqual([
      "https://signed/canhoto.jpg",
      "https://signed/assinatura.png",
    ]);

    // Who took delivery belongs in the line support reads, not two clicks in.
    expect(entry.title).toContain("Porteiro");
  });

  it("reads an event written before the actor column as a person", () => {
    // Every source was a person when those rows were written; saying
    // "integração" about them would be inventing history.
    const [entry] = buildDeliveryTimeline(
      sources({
        events: [
          {
            id: "e1",
            type: "ARRIVAL",
            created_at: AT("2026-09-15T10:00:00Z"),
            reportedBy: { name: "João" },
          },
        ],
      }),
    );

    expect(entry.author.kind).toBe("USER");
  });

  it("survives an event with no author at all", () => {
    // An integration has no User behind it. A timeline that threw here would
    // take the whole support screen down over one row.
    const [entry] = buildDeliveryTimeline(
      sources({
        events: [
          {
            id: "e1",
            type: "NOTE",
            created_at: AT("2026-09-15T10:00:00Z"),
            actor: "INTEGRATION",
            note: "Recebido do ERP",
          },
        ],
      }),
    );

    expect(entry.author).toEqual({
      kind: "INTEGRATION",
      name: null,
      device: null,
    });
  });
});

describe("occurrences and messages, as the trail shows them", () => {
  it("flags a blocking occurrence, which is the one that changed the outcome", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        occurrences: [
          {
            id: "o1",
            created_at: AT("2026-09-15T10:00:00Z"),
            description: "Ninguém atendeu",
            photos: ["https://signed/foto.jpg"],
            occurrenceType: { name: "Cliente ausente", blocks_delivery: true },
            reportedBy: { name: "João" },
          },
        ],
      }),
    );

    expect(entry.kind).toBe("OCCURRENCE");
    expect(entry.title).toBe("Cliente ausente");
    expect(entry.blocking).toBe(true);
    expect(entry.photos).toEqual(["https://signed/foto.jpg"]);
  });

  it("does not flag an informational one", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        occurrences: [
          {
            id: "o1",
            created_at: AT("2026-09-15T10:00:00Z"),
            occurrenceType: { name: "Trânsito intenso" },
          },
        ],
      }),
    );

    expect(entry.blocking).toBe(false);
  });

  it("shows what an attachment was, rather than an empty row", () => {
    const timeline = buildDeliveryTimeline(
      sources({
        messages: [
          {
            id: "m1",
            kind: "AUDIO",
            created_at: AT("2026-09-15T11:00:00Z"),
            sender: { name: "Despachante" },
          },
          {
            id: "m2",
            kind: "IMAGE",
            created_at: AT("2026-09-15T10:00:00Z"),
            sender: { name: "João" },
          },
        ],
      }),
    );

    expect(timeline[0].detail).toBe("Mensagem de voz");
    expect(timeline[1].detail).toBe("Foto");
  });

  it("prefers the caption when the attachment has one", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        messages: [
          {
            id: "m1",
            kind: "IMAGE",
            body: "Portão fechado",
            created_at: AT("2026-09-15T10:00:00Z"),
            sender: { name: "João" },
          },
        ],
      }),
    );

    expect(entry.detail).toBe("Portão fechado");
  });

  it("leaves a text message with no body as an empty detail, not as “Foto”", () => {
    const [entry] = buildDeliveryTimeline(
      sources({
        messages: [
          {
            id: "m1",
            kind: "TEXT",
            body: null,
            created_at: AT("2026-09-15T10:00:00Z"),
            sender: { name: "João" },
          },
        ],
      }),
    );

    expect(entry.detail).toBeNull();
  });
});

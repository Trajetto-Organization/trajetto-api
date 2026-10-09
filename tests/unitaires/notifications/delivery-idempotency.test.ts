import { describe, expect, it } from "vitest";

import {
  buildMessageId,
  senderDomain,
} from "@/shared/providers/mail-provider/message-id";

import { InMemoryMailProvider } from "@/shared/providers/mail-provider/in-memory/in-memory-mail-provider";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

/**
 * The pipeline calls a provider and then marks the row DELIVERED. Nothing can
 * make those two steps atomic across a network, so a crash in between — a
 * deploy, an OOM, a lease lapsing under a slow send — means the item is
 * claimed again and sent again. `@@unique([outboxEventId, userId, channel])`
 * stops a second ROW; it has never stopped a second SEND.
 *
 * What each channel can actually have is different, and these tests are
 * written to keep the difference honest rather than to claim exactly-once:
 *
 *   IN_APP, ACTIVITY  our own tables — a duplicate is preventable outright.
 *   EMAIL             deduplicated by Resend for 24 h (Resend-Idempotency-Key
 *                     = delivery id); Message-ID is the fallback mitigation.
 *   PUSH, WHATSAPP    no key exists at that layer. Only auditable — through
 *                     the provider receipts ledger.
 */

const DELIVERY_A = "018f0000-0000-7000-8000-0000000000a1";
const DELIVERY_B = "018f0000-0000-7000-8000-0000000000b2";

describe("the identity of an e-mail", () => {
  it("is the same every time the same delivery is sent", () => {
    // This is the whole mitigation: RFC 5322 makes Message-ID the identity of
    // a MESSAGE, not of a transmission, so two sends carrying the same one
    // are the same message arriving twice — and Gmail and most large
    // providers suppress the copy.
    expect(buildMessageId(DELIVERY_A, "intrajetto.com")).toBe(
      buildMessageId(DELIVERY_A, "intrajetto.com"),
    );
  });

  it("differs between two deliveries of the same event", () => {
    // One event fans out to many recipients. Sharing a Message-ID between
    // them would have receivers suppressing notifications meant for
    // different people — the failure mode of over-correcting.
    expect(buildMessageId(DELIVERY_A, "intrajetto.com")).not.toBe(
      buildMessageId(DELIVERY_B, "intrajetto.com"),
    );
  });

  it("is a well-formed header value", () => {
    const messageId = buildMessageId(DELIVERY_A, "intrajetto.com");

    expect(messageId).toMatch(/^<[A-Za-z0-9._-]+@intrajetto\.com>$/);
  });

  it("strips anything an SMTP header would not survive", () => {
    // A header value that breaks parsing is worse than no header: it can
    // truncate the ones after it.
    const messageId = buildMessageId("a b\r\nc<>@d", "intrajetto.com");

    expect(messageId).toBe("<abcd@intrajetto.com>");

    // A CRLF inside a header value ends the header and starts a new one, so
    // anything surviving here could truncate or forge the headers after it.
    expect(messageId).not.toMatch(/[\r\n]/);
  });
});

describe("the sender domain", () => {
  it("is read out of a plain address", () => {
    expect(senderDomain("noreply@intrajetto.com")).toBe("intrajetto.com");
  });

  it("is read out of a display-name address", () => {
    expect(senderDomain("Trajetto <noreply@intrajetto.com>")).toBe(
      "intrajetto.com",
    );
  });

  it("falls back rather than producing a broken header", () => {
    expect(senderDomain(undefined)).toBe("intrajetto.com");
    expect(senderDomain("not-an-address")).toBe("intrajetto.com");
  });
});

describe("a redelivery of the same e-mail", () => {
  it("reaches the transport with the identity of the first attempt", async () => {
    const mailProvider = new InMemoryMailProvider();

    const send = () =>
      mailProvider.sendMail({
        to: "motorista@transportadora.com.br",
        subject: "Trajetto - Nova entrega",
        path: "notification.hbs",
        variables: {},
        referenceId: DELIVERY_A,
      });

    const first = await send();
    const second = await send();

    expect(first.messageId).toBeDefined();
    expect(second.messageId).toBe(first.messageId);
  });

  it("reports the id back so the send is auditable", async () => {
    // What gets written to notificationDelivery.providerMessageId. Without
    // it, a customer reporting a duplicate leaves nothing to check: there is
    // no way to tell "we sent it twice" from "their client showed it twice".
    const mailProvider = new InMemoryMailProvider();

    const result = await mailProvider.sendMail({
      to: "gestor@transportadora.com.br",
      subject: "Trajetto - Ocorrência",
      path: "notification.hbs",
      variables: {},
      referenceId: DELIVERY_B,
    });

    expect(result.messageId).toBe(buildMessageId(DELIVERY_B, "intrajetto.com"));
  });

  it("carries no identity when there is no reference to build one from", () => {
    // Transactional mail outside the pipeline (password reset, 2FA) has no
    // delivery row. A constant Message-ID there would be far worse than none:
    // every reset e-mail would look like the same message.
    const mailProvider = new InMemoryMailProvider();

    return mailProvider
      .sendMail({
        to: "alguem@transportadora.com.br",
        subject: "Trajetto",
        path: "notification.hbs",
        variables: {},
      })
      .then((result) => expect(result.messageId).toBeUndefined());
  });
});

describe("a redelivery that writes to the audit trail", () => {
  it("records the activity once, not twice", async () => {
    // The only channel where a duplicate is fully preventable and also fully
    // unacceptable: an audit trail that double-counts is not incomplete, it
    // is confidently wrong. Two workers claiming the same delivery — a lease
    // that lapsed, a replica that came back — must converge on one row.
    const repository = new InMemoryActivityRepository();

    const write = () =>
      repository.createActivity({
        type: "Entrega",
        action: "update",
        entityId: "delivery-1",
        description: "Ocorrência registrada",
        status: "Insucesso",
        performedBy: "user-1",
        businessId: "business-a",
        deliveryId: DELIVERY_A,
      });

    const first = await write();
    const second = await write();

    expect(repository.activities).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it("leaves the first record exactly as it was", async () => {
    // `update: {}` in the upsert is deliberate. Re-recording would move
    // created_at forward and make the trail lie about when it happened.
    const repository = new InMemoryActivityRepository();

    const first = await repository.createActivity({
      type: "Entrega",
      action: "update",
      entityId: "delivery-1",
      description: "Descrição original",
      status: "Insucesso",
      performedBy: "user-1",
      businessId: "business-a",
      deliveryId: DELIVERY_A,
    });

    const second = await repository.createActivity({
      type: "Entrega",
      action: "update",
      entityId: "delivery-1",
      description: "Descrição diferente",
      status: "Insucesso",
      performedBy: "user-1",
      businessId: "business-a",
      deliveryId: DELIVERY_A,
    });

    // Asserted on what the second write RETURNS, not on activities[0]: the
    // first row would read correctly either way, so checking it would pass
    // even with the deduplication removed.
    expect(second.description).toBe("Descrição original");
    expect(second.created_at).toEqual(first.created_at);
    expect(repository.activities).toHaveLength(1);
  });

  it("does not collapse the activities a use case writes directly", async () => {
    // Most activities have no delivery behind them. Two different actions
    // that happen to look alike are two events and must both be recorded.
    const repository = new InMemoryActivityRepository();

    const write = () =>
      repository.createActivity({
        type: "Veículo",
        action: "update",
        entityId: "vehicle-1",
        description: "Quilometragem atualizada",
        status: "Ativo",
        performedBy: "user-1",
        businessId: "business-a",
      });

    await write();
    await write();

    expect(repository.activities).toHaveLength(2);
  });
});

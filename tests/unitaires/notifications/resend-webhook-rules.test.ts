import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
  RESEND_STATUS_RANK,
  deliveryIdFromMessageId,
  extractResendEvent,
  verifySvixSignature,
} from "@/shared/providers/mail-provider/resend-webhook";

/**
 * OBS-08: an e-mail that bounced stayed DELIVERED for good. Resend reports
 * delivery, bounce and complaint through a Svix-signed webhook; these are the
 * pure parts of reading it — is the body really Resend's, and what does it
 * say about which of our messages.
 */
const KEY = Buffer.from("chave-de-assinatura-de-teste-32b!");
const SECRET = `whsec_${KEY.toString("base64")}`;

function sign(id: string, timestamp: string, body: string, key = KEY): string {
  return `v1,${createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;
}

describe("the Svix signature on a Resend callback", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const timestamp = String(Math.floor(now / 1000));
  const body = '{"type":"email.bounced"}';

  it("accepts the body Resend signed", () => {
    expect(
      verifySvixSignature(
        { id: "msg_1", timestamp, signature: sign("msg_1", timestamp, body) },
        Buffer.from(body),
        SECRET,
        now,
      ),
    ).toBe(true);
  });

  it("accepts any of several signatures (secret rotation)", () => {
    const other = sign("msg_1", timestamp, body, Buffer.from("outra-chave"));

    expect(
      verifySvixSignature(
        {
          id: "msg_1",
          timestamp,
          signature: `${other} ${sign("msg_1", timestamp, body)}`,
        },
        Buffer.from(body),
        SECRET,
        now,
      ),
    ).toBe(true);
  });

  it("refuses a body changed after signing", () => {
    expect(
      verifySvixSignature(
        { id: "msg_1", timestamp, signature: sign("msg_1", timestamp, body) },
        Buffer.from('{"type":"email.delivered"}'),
        SECRET,
        now,
      ),
    ).toBe(false);
  });

  it("refuses a replay older than five minutes", () => {
    const old = String(Math.floor(now / 1000) - 6 * 60);

    expect(
      verifySvixSignature(
        { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) },
        Buffer.from(body),
        SECRET,
        now,
      ),
    ).toBe(false);
  });

  it("refuses missing headers and malformed signatures", () => {
    expect(
      verifySvixSignature(
        { id: undefined, timestamp, signature: sign("msg_1", timestamp, body) },
        Buffer.from(body),
        SECRET,
        now,
      ),
    ).toBe(false);

    expect(
      verifySvixSignature(
        { id: "msg_1", timestamp, signature: "v1,não-é-base64" },
        Buffer.from(body),
        SECRET,
        now,
      ),
    ).toBe(false);
  });
});

describe("what a Resend event says", () => {
  it("reads a bounce, with the reason and without the address", () => {
    expect(
      extractResendEvent({
        type: "email.bounced",
        created_at: "2026-09-24T12:00:01.000Z",
        data: {
          email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
          message_id: "<018f0000-0000-7000-8000-0000000000d1@intrajetto.com>",
          to: ["ana@exemplo.com"],
          bounce: {
            type: "Permanent",
            subType: "General",
            message: "550 5.1.1 <ana@exemplo.com>: user unknown",
          },
        },
      }),
    ).toEqual({
      status: "bounced",
      emailId: "56761188-7520-42d8-8898-ff6fc54ce618",
      messageId: "<018f0000-0000-7000-8000-0000000000d1@intrajetto.com>",
      occurredAt: new Date("2026-09-24T12:00:01.000Z"),
      errorCode: "Permanent/General",
      errorMessage: "550 5.1.1 <a***@exemplo.com>: user unknown",
    });
  });

  it("ignores events that are not about delivering an e-mail", () => {
    expect(extractResendEvent({ type: "email.opened", data: { email_id: "x" } })).toBeNull();
    expect(extractResendEvent({ type: "domain.updated", data: {} })).toBeNull();
    expect(extractResendEvent({ type: "email.delivered", data: {} })).toBeNull();
    expect(extractResendEvent(null)).toBeNull();
  });

  it("ranks the statuses so none moves a delivery backwards", () => {
    expect(RESEND_STATUS_RANK.delivered).toBeGreaterThan(RESEND_STATUS_RANK.sent);
    expect(RESEND_STATUS_RANK.bounced).toBeGreaterThan(RESEND_STATUS_RANK.delivered);
    expect(RESEND_STATUS_RANK.complained).toBeGreaterThan(RESEND_STATUS_RANK.delivered);
  });
});

describe("the delivery a Message-ID names", () => {
  it("is the id the pipeline put in the local part", () => {
    expect(
      deliveryIdFromMessageId("<018f0000-0000-7000-8000-0000000000d1@intrajetto.com>"),
    ).toBe("018f0000-0000-7000-8000-0000000000d1");
  });

  it("is nobody for a Message-ID we did not build", () => {
    expect(deliveryIdFromMessageId("<111-222-333@email.example.com>")).toBeNull();
    expect(deliveryIdFromMessageId(null)).toBeNull();
  });
});

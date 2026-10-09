import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import cron from "node-cron";

import {
  extractMetaStatuses,
  extractMetaTemplateUpdates,
  isMetaVerifyTokenValid,
  verifyMetaSignature,
} from "@/shared/providers/whatsapp-provider/meta-webhook";

import { classifyExpoReceipt } from "@/jobs/cron/check-push-receipts-job";
import { registerCronJobs } from "@/jobs/cron";
import {
  CronJobDefinition,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * The rules that decide whether a provider callback is trusted and what it
 * says, without a server. The receiver itself is proven end to end in
 * tests/E2E/provider-receipts.test.ts.
 */
const SECRET = "segredo-do-app";

function signatureOf(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Meta's signature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts the HMAC of the exact bytes", () => {
    expect(
      verifyMetaSignature(Buffer.from(body), signatureOf(body), SECRET),
    ).toBe(true);
  });

  it("refuses a body changed after signing", () => {
    expect(
      verifyMetaSignature(
        Buffer.from(body.replace("[]", "[1]")),
        signatureOf(body),
        SECRET,
      ),
    ).toBe(false);
  });

  it("refuses another app's secret, a missing header and a malformed one", () => {
    const raw = Buffer.from(body);

    expect(verifyMetaSignature(raw, signatureOf(body, "outro"), SECRET)).toBe(
      false,
    );
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=abc", SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha1=abc", SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=não-é-hex", SECRET)).toBe(false);
  });

  it("checks the verify token exactly", () => {
    expect(isMetaVerifyTokenValid("abc", "abc")).toBe(true);
    expect(isMetaVerifyTokenValid("abcd", "abc")).toBe(false);
    expect(isMetaVerifyTokenValid(undefined, "abc")).toBe(false);
  });
});

describe("reading a status callback", () => {
  const DELIVERY = "018f0000-0000-7000-8000-0000000000d1";

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        time: 1758690100,
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                {
                  id: "wamid.A",
                  status: "failed",
                  timestamp: "1758690000",
                  biz_opaque_callback_data: DELIVERY,
                  errors: [
                    {
                      code: 131026,
                      title: "Message undeliverable",
                      error_data: { details: "Receiver is incapable" },
                    },
                  ],
                },
                { id: "wamid.B", status: "read", timestamp: "1758690001" },
                { status: "sent" },
                {
                  id: "wamid.C",
                  status: "sent",
                  biz_opaque_callback_data: "não-é-um-id",
                },
              ],
            },
          },
          {
            field: "message_template_status_update",
            value: {
              event: "PAUSED",
              message_template_name: "trajetto_notification",
              message_template_language: "pt_BR",
              reason: "LOW_QUALITY",
              other_info: {
                title: "FIRST_PAUSE",
                description: "Your template has been paused for 3 hours",
              },
            },
          },
        ],
      },
    ],
  };

  it("maps each status, with Meta's error and the delivery it names", () => {
    const [failed, read, sent] = extractMetaStatuses(payload);

    expect(failed).toEqual({
      providerMessageId: "wamid.A",
      status: "failed",
      occurredAt: new Date(1758690000 * 1000),
      deliveryId: DELIVERY,
      errorCode: "131026",
      errorMessage: "Receiver is incapable",
    });

    expect(read).toMatchObject({ providerMessageId: "wamid.B", deliveryId: null });

    // Callback data that is not a delivery id ties nothing.
    expect(sent).toMatchObject({ providerMessageId: "wamid.C", deliveryId: null });
  });

  it("skips an entry with no message id instead of refusing the batch", () => {
    expect(extractMetaStatuses(payload)).toHaveLength(3);
    expect(extractMetaStatuses({ entry: "nada" })).toEqual([]);
    expect(extractMetaStatuses(null)).toEqual([]);
  });

  it("reads a template being paused, with its language and how long", () => {
    expect(extractMetaTemplateUpdates(payload)).toEqual([
      {
        event: "PAUSED",
        templateName: "trajetto_notification",
        reason: "LOW_QUALITY",
        language: "pt_BR",
        pauseTitle: "FIRST_PAUSE",
        // The entry's time: when Meta says it happened, not when it arrived.
        occurredAt: new Date(1758690100 * 1000),
      },
    ]);
  });
});

describe("an Expo receipt", () => {
  const created = new Date("2026-09-24T10:00:00.000Z");
  const later = new Date("2026-09-24T10:20:00.000Z");

  it("waits while Expo has not published it yet", () => {
    expect(classifyExpoReceipt(undefined, created, later)).toBeNull();
  });

  it("gives up on a ticket past Expo's retention", () => {
    expect(
      classifyExpoReceipt(
        undefined,
        created,
        new Date("2026-09-25T10:00:00.000Z"),
      ),
    ).toMatchObject({ status: "expired", pruneToken: false });
  });

  it("prunes the device only on DeviceNotRegistered", () => {
    expect(
      classifyExpoReceipt(
        { status: "error", details: { error: "DeviceNotRegistered" } },
        created,
        later,
      ),
    ).toMatchObject({
      status: "error",
      errorCode: "DeviceNotRegistered",
      pruneToken: true,
    });

    expect(
      classifyExpoReceipt(
        { status: "error", details: { error: "MessageRateExceeded" } },
        created,
        later,
      ),
    ).toMatchObject({ status: "error", pruneToken: false });

    expect(classifyExpoReceipt({ status: "ok" }, created, later)).toMatchObject({
      status: "ok",
      pruneToken: false,
    });
  });
});

describe("the receipts job", () => {
  it("is scheduled", () => {
    const jobs: CronJobDefinition[] = [];

    vi.spyOn(CronSchedulerService.getInstance(), "registerJob").mockImplementation(
      (definition: CronJobDefinition) => {
        jobs.push(definition);
      },
    );

    registerCronJobs();

    const job = jobs.find((entry) => entry.name === "check-push-receipts");

    expect(job).toBeDefined();
    expect(cron.validate(job!.schedule)).toBe(true);
  });
});

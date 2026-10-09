import { describe, expect, it } from "vitest";
import { NotificationChannel } from "@prisma/client";

import {
  formatDeliveryError,
  isCredentialFailure,
  providerDetailOf,
  suppressedChannels,
} from "@/shared/notifications/delivery-diagnostics";

/**
 * OBS-08: what a provider said about a failed send used to be reduced to its
 * sentence. Meta's error code and HTTP status, the SMTP code and reply were
 * dropped on the way to lastError, so the dead letter could not tell an
 * expired token from a number without WhatsApp — and nothing could alert on
 * the first. And a channel left out at expansion (preference off, no device,
 * opted out) left no trace at all.
 */
describe("the provider detail in lastError", () => {
  it("prefixes Meta's HTTP status and error code", () => {
    expect(
      formatDeliveryError("Error validating access token: Session has expired", {
        provider: "whatsapp",
        httpStatus: 401,
        errorCode: 190,
      }),
    ).toBe(
      "[whatsapp http=401 code=190] Error validating access token: Session has expired",
    );
  });

  it("prefixes the SMTP code and reply of an e-mail refusal", () => {
    expect(
      formatDeliveryError("Falha ao enviar e-mail: Invalid login", {
        provider: "email",
        smtpCode: "EAUTH",
        smtpReply: 535,
      }),
    ).toBe("[email smtp=EAUTH reply=535] Falha ao enviar e-mail: Invalid login");
  });

  it("names the provider even when it gave no code", () => {
    expect(
      formatDeliveryError("Meta Cloud API não respondeu em 10s", {
        provider: "whatsapp",
      }),
    ).toBe("[whatsapp] Meta Cloud API não respondeu em 10s");
  });

  it("leaves a failure that never reached a provider as it was", () => {
    expect(formatDeliveryError("Recipient user no longer exists")).toBe(
      "Recipient user no longer exists",
    );
  });

  it("never lets a provider's text forge the prefix fields", () => {
    expect(
      formatDeliveryError("x", {
        provider: "whatsapp",
        errorCode: "190] [email smtp=EAUTH" as unknown as number,
      }),
    ).toBe("[whatsapp code=190emailsmtpEAUTH] x");
  });
});

describe("reading the detail off a thrown error", () => {
  it("takes the detail the pipeline attached", () => {
    const error = Object.assign(new Error("boom"), {
      detail: { provider: "whatsapp", httpStatus: 403, errorCode: 10 },
    });

    expect(providerDetailOf(error, NotificationChannel.WHATSAPP)).toEqual({
      provider: "whatsapp",
      httpStatus: 403,
      errorCode: 10,
    });
  });

  it("reads the HTTP status Expo answered with on a push", () => {
    const error = Object.assign(new Error("Expo push respondeu HTTP 401"), {
      httpStatus: 401,
    });

    expect(providerDetailOf(error, NotificationChannel.PUSH)).toEqual({
      provider: "push",
      httpStatus: 401,
    });
  });

  it("has nothing to say about an error that carries no detail", () => {
    expect(providerDetailOf(new Error("boom"), NotificationChannel.EMAIL)).toBeUndefined();
    expect(providerDetailOf("boom", NotificationChannel.PUSH)).toBeUndefined();
  });
});

describe("a credential failure, recognised from lastError", () => {
  it.each([
    "[whatsapp http=401 code=190] Session has expired",
    "[whatsapp http=403] Forbidden",
    "[whatsapp code=190] expired",
    "[whatsapp] WhatsApp não configurado: defina META_WHATSAPP_ACCESS_TOKEN e META_WHATSAPP_PHONE_NUMBER_ID.",
    "[email smtp=EAUTH reply=535] Falha ao enviar e-mail: Invalid login",
    "[email reply=530] Authentication required",
    "[push http=401] Expo push respondeu HTTP 401",
  ])("%s", (lastError) => {
    expect(isCredentialFailure(lastError)).toBe(true);
  });

  it.each([
    "[whatsapp http=400 code=131026] Message undeliverable",
    "[whatsapp http=429 code=131056] Pair rate limit hit",
    "[email smtp=EENVELOPE reply=550] mailbox unavailable",
    "[push http=503] Expo push respondeu HTTP 503",
    "Recipient user no longer exists",
    // A provider's free text quoting a status is not a credential failure.
    "Meta Cloud API respondeu HTTP 401",
    null,
    undefined,
  ])("not %s", (lastError) => {
    expect(isCredentialFailure(lastError)).toBe(false);
  });
});

describe("the channels an event left out, and why", () => {
  const everything = {
    activityNotificationsEnabled: true,
    emailNotificationsEnabled: true,
    whatsappNotificationsEnabled: true,
    hasWhatsAppPhone: true,
  };

  const content = {
    hasInAppContent: true,
    hasEmailContent: true,
    hasWhatsAppContent: true,
    hasPushDevice: true,
  };

  it("is nothing when every channel with content was created", () => {
    expect(suppressedChannels(everything, content)).toEqual([]);
  });

  it("says a preference turned a channel off", () => {
    expect(
      suppressedChannels(
        { ...everything, emailNotificationsEnabled: false, whatsappNotificationsEnabled: false },
        content,
      ),
    ).toEqual([
      { channel: NotificationChannel.EMAIL, reason: "preference_off" },
      { channel: NotificationChannel.WHATSAPP, reason: "preference_off" },
    ]);
  });

  it("tells a missing phone apart from a WhatsApp preference", () => {
    expect(
      suppressedChannels({ ...everything, hasWhatsAppPhone: false }, content),
    ).toEqual([{ channel: NotificationChannel.WHATSAPP, reason: "no_contact" }]);
  });

  it("says push had no device to go to", () => {
    expect(
      suppressedChannels(everything, { ...content, hasPushDevice: false }),
    ).toEqual([{ channel: NotificationChannel.PUSH, reason: "no_push_device" }]);
  });

  it("puts in-app and its push down to the in-app preference", () => {
    expect(
      suppressedChannels({ ...everything, activityNotificationsEnabled: false }, content),
    ).toEqual([
      { channel: NotificationChannel.IN_APP, reason: "preference_off" },
      { channel: NotificationChannel.PUSH, reason: "preference_off" },
    ]);
  });

  it("does not list a channel the topic has no content for", () => {
    expect(
      suppressedChannels(
        { ...everything, whatsappNotificationsEnabled: false },
        { ...content, hasWhatsAppContent: false },
      ),
    ).toEqual([]);
  });
});

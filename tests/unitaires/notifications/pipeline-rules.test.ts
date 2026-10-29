import { describe, expect, it } from "vitest";
import { NotificationChannel } from "@prisma/client";

import {
  assertDeliveryLeaseInvariant,
  channelsForRecipient,
  DELIVERY_CONCURRENCY,
  DELIVERY_LANES,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  honourRetryAfter,
  laneOf,
  nextRetryDelayMs,
  PER_DELIVERY_TIMEOUT_MS,
  resolveRecipientChannelFlags,
  withRetryJitter,
} from "@/shared/notifications/pipeline-rules";

describe("a provider asking us to wait", () => {
  it("is honoured when it asks for longer than our backoff", () => {
    expect(honourRetryAfter(30_000, 600_000)).toBe(600_000);
  });

  it("never brings a retry sooner than our backoff", () => {
    expect(honourRetryAfter(120_000, 5_000)).toBe(120_000);
  });

  it("is capped at an hour, whatever it asks", () => {
    expect(honourRetryAfter(30_000, 24 * 60 * 60_000)).toBe(60 * 60_000);
  });

  it("is ignored when absent or nonsense", () => {
    expect(honourRetryAfter(30_000, undefined)).toBe(30_000);
    expect(honourRetryAfter(30_000, Number.NaN)).toBe(30_000);
    expect(honourRetryAfter(30_000, -5)).toBe(30_000);
  });
});

describe("delivery lanes", () => {
  it("keeps the providers that can hang away from the bell and the phone", () => {
    expect(laneOf(NotificationChannel.EMAIL)).toBe("external");
    expect(laneOf(NotificationChannel.WHATSAPP)).toBe("external");

    expect(laneOf(NotificationChannel.IN_APP)).toBe("internal");
    expect(laneOf(NotificationChannel.PUSH)).toBe("internal");
    expect(laneOf(NotificationChannel.ACTIVITY)).toBe("internal");
  });

  it("covers every channel exactly once", () => {
    const covered = [...DELIVERY_LANES.internal, ...DELIVERY_LANES.external];

    expect([...covered].sort()).toEqual(
      Object.values(NotificationChannel).sort(),
    );
  });
});

const allEnabled = {
  activityNotificationsEnabled: true,
  emailNotificationsEnabled: true,
  whatsappNotificationsEnabled: true,
  hasWhatsAppPhone: true,
};

const fullContent = {
  hasInAppContent: true,
  hasEmailContent: true,
  hasWhatsAppContent: true,
};

describe("push channel", () => {
  /**
   * Push is the phone-shaped form of in-app: same content, same preference
   * decision — it only exists where a registered device does.
   */
  it("adds PUSH alongside IN_APP when the recipient has a device", () => {
    const channels = channelsForRecipient(allEnabled, {
      ...fullContent,
      hasPushDevice: true,
    });

    expect(channels).toContain(NotificationChannel.IN_APP);
    expect(channels).toContain(NotificationChannel.PUSH);
  });

  it("no device, no PUSH row — web-only users never accumulate dead pushes", () => {
    const channels = channelsForRecipient(allEnabled, fullContent);

    expect(channels).not.toContain(NotificationChannel.PUSH);
  });

  it("in-app disabled disables PUSH with it", () => {
    const channels = channelsForRecipient(
      { ...allEnabled, activityNotificationsEnabled: false },
      { ...fullContent, hasPushDevice: true },
    );

    expect(channels).not.toContain(NotificationChannel.IN_APP);
    expect(channels).not.toContain(NotificationChannel.PUSH);
  });
});

describe("retry backoff", () => {
  it("waits longer after each failed attempt", () => {
    const delays = DELIVERY_RETRY_DELAYS_MS.map((_, index) =>
      nextRetryDelayMs(index + 1, DELIVERY_RETRY_DELAYS_MS),
    );

    expect(delays).toEqual(DELIVERY_RETRY_DELAYS_MS);

    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThan(delays[index - 1]!);
    }
  });

  /**
   * An hour-long provider outage used to outlast the whole schedule (~42
   * minutes), turning every message of its first twenty minutes into a
   * permanent failure.
   */
  it("outlasts a provider outage of a few hours", () => {
    const total = DELIVERY_RETRY_DELAYS_MS.reduce(
      (sum, delay) => sum + delay,
      0,
    );

    expect(total).toBeGreaterThan(4 * 60 * 60_000);
  });

  it("caps attempts, and reclaims, one past the schedule", () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(DELIVERY_RETRY_DELAYS_MS.length + 1);
  });

  /**
   * Null is the signal to mark the row FAILED. Without a hard stop, one
   * permanently broken delivery would be retried forever.
   */
  it("gives up after the schedule is exhausted", () => {
    expect(nextRetryDelayMs(DELIVERY_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });
});

describe("channel gating", () => {
  it("gives an all-enabled recipient every channel", () => {
    expect(channelsForRecipient(allEnabled, fullContent)).toEqual([
      NotificationChannel.IN_APP,
      NotificationChannel.EMAIL,
      NotificationChannel.WHATSAPP,
    ]);
  });

  it("honors each per-user toggle independently", () => {
    expect(
      channelsForRecipient(
        { ...allEnabled, activityNotificationsEnabled: false },
        fullContent,
      ),
    ).not.toContain(NotificationChannel.IN_APP);

    expect(
      channelsForRecipient(
        { ...allEnabled, emailNotificationsEnabled: false },
        fullContent,
      ),
    ).not.toContain(NotificationChannel.EMAIL);

    expect(
      channelsForRecipient(
        { ...allEnabled, whatsappNotificationsEnabled: false },
        fullContent,
      ),
    ).not.toContain(NotificationChannel.WHATSAPP);
  });

  /**
   * Opt-in without a number would create deliveries that can only fail —
   * noise in the failure metrics for something that isn't a failure.
   */
  it("skips WhatsApp when the recipient has no phone", () => {
    expect(
      channelsForRecipient(
        { ...allEnabled, hasWhatsAppPhone: false },
        fullContent,
      ),
    ).not.toContain(NotificationChannel.WHATSAPP);
  });

  it("skips WhatsApp when the topic has no WhatsApp content", () => {
    expect(
      channelsForRecipient(allEnabled, {
        ...fullContent,
        hasWhatsAppContent: false,
      }),
    ).not.toContain(NotificationChannel.WHATSAPP);
  });

  /**
   * An activity-only topic (checklist, refuelling) renders nothing in-app,
   * and e-mail reuses the in-app render — so neither channel may fire even
   * for a recipient with everything enabled.
   */
  it("skips in-app and e-mail when the topic has no in-app content", () => {
    expect(
      channelsForRecipient(allEnabled, {
        ...fullContent,
        hasInAppContent: false,
        hasEmailContent: false,
      }),
    ).toEqual([NotificationChannel.WHATSAPP]);
  });

  /**
   * A topic can carry in-app content and still refuse e-mail — the welcome
   * note whose real content already went out as a credentials e-mail.
   */
  it("suppresses only e-mail when the topic asks for it", () => {
    expect(
      channelsForRecipient(allEnabled, {
        ...fullContent,
        hasEmailContent: false,
        hasWhatsAppContent: false,
      }),
    ).toEqual([NotificationChannel.IN_APP]);
  });

  /**
   * Mandatory topics ("your account changed") exist so preferences control
   * noise, never critical notices: in-app fires even with everything off.
   */
  it("forces in-app for a mandatory topic with everything disabled", () => {
    expect(
      channelsForRecipient(
        {
          activityNotificationsEnabled: false,
          emailNotificationsEnabled: false,
          whatsappNotificationsEnabled: false,
          hasWhatsAppPhone: false,
        },
        { ...fullContent, isMandatory: true },
      ),
    ).toEqual([NotificationChannel.IN_APP]);
  });
});

describe("preference layering", () => {
  const legacyAllOn = {
    activity_notifications_enabled: true,
    email_notifications_enabled: true,
    whatsapp_notifications_enabled: true,
    whatsapp_phone: "24999999999",
  };

  /**
   * No saved row = no opinion: shipping the preferences table changed
   * nobody's behavior until they touch the screen.
   */
  it("falls back to the legacy toggles without a row", () => {
    expect(resolveRecipientChannelFlags(legacyAllOn, undefined)).toEqual({
      activityNotificationsEnabled: true,
      emailNotificationsEnabled: true,
      whatsappNotificationsEnabled: true,
      hasWhatsAppPhone: true,
    });
  });

  it("lets a saved row override the globals for its category", () => {
    expect(
      resolveRecipientChannelFlags(legacyAllOn, {
        inApp: false,
        email: false,
        whatsapp: false,
      }),
    ).toEqual({
      activityNotificationsEnabled: false,
      emailNotificationsEnabled: false,
      whatsappNotificationsEnabled: false,
      hasWhatsAppPhone: true,
    });
  });

  /**
   * The defaults, when the row has said nothing at all.
   *
   * Every other fixture here sets the three toggles explicitly, so the
   * fallbacks were never reached by a test — and the fallbacks are where the
   * rule actually lives. They are deliberately ASYMMETRIC, and the asymmetry
   * is the product decision:
   *
   * - in-app and e-mail default ON, because they are inside the product the
   *   person signed up for. Silence there means "I have not thought about
   *   it", and defaulting them off would deliver a system that notifies
   *   nobody until every user visits a settings screen;
   * - **WhatsApp defaults OFF**, because it is not our channel. Meta governs
   *   it and requires opt-in; sending to somebody who never opted in costs
   *   the number its quality rating and can get it blocked outright — and
   *   under the LGPD it is a message to a personal channel with no basis.
   *   Silence there has to mean no.
   *
   * Found by mutation: flipping `?? false` to `?? true` on the WhatsApp
   * fallback left all 1.100 unit tests green.
   */
  it("defaults in-app and e-mail ON, and WhatsApp OFF, for a silent row", () => {
    const flags = resolveRecipientChannelFlags({}, undefined);

    expect(flags.activityNotificationsEnabled).toBe(true);
    expect(flags.emailNotificationsEnabled).toBe(true);

    expect(
      flags.whatsappNotificationsEnabled,
      "WhatsApp sem opt-in explícito: a régua é da Meta, não nossa",
    ).toBe(false);
  });

  it("and a silent row gets no WhatsApp even carrying a number", () => {
    /**
     * The two gates are separate on purpose, and this pins which one refuses.
     * A recipient whose phone came in from the registration form has a number
     * and has still never agreed to be messaged on it — the number is a
     * contact detail, not consent.
     */
    const flags = resolveRecipientChannelFlags(
      { whatsapp_phone: "24999999999" },
      undefined,
    );

    expect(flags.hasWhatsAppPhone).toBe(true);

    expect(channelsForRecipient(flags, fullContent)).not.toContain(
      NotificationChannel.WHATSAPP,
    );
  });

  /**
   * A preference can want WhatsApp all it likes — without a configured
   * number there is nowhere to send, and the phone gate stays in charge.
   */
  it("keeps WhatsApp blocked without a phone even when the row wants it", () => {
    const flags = resolveRecipientChannelFlags(
      { ...legacyAllOn, whatsapp_phone: null },
      { inApp: true, email: true, whatsapp: true },
    );

    expect(flags.whatsappNotificationsEnabled).toBe(true);
    expect(flags.hasWhatsAppPhone).toBe(false);

    expect(
      channelsForRecipient(flags, {
        hasInAppContent: true,
        hasEmailContent: true,
        hasWhatsAppContent: true,
      }),
    ).not.toContain(NotificationChannel.WHATSAPP);
  });
});

/**
 * The lease is the only thing standing between a slow batch and a duplicate
 * WhatsApp: once it expires, another replica claims rows the first one is
 * still sending. These pin the arithmetic so a future tuning change cannot
 * quietly cross the line.
 */
describe("delivery lease invariant", () => {
  it("accepts the shipped batch size", () => {
    expect(() => assertDeliveryLeaseInvariant(20)).not.toThrow();
  });

  it("refuses a batch whose worst case outruns the lease", () => {
    // 200 items at concurrency 5 is 40 waves; at 15s each that is 600s,
    // well past the 180s lease.
    expect(() => assertDeliveryLeaseInvariant(200)).toThrow(
      /lease invariant violated/i,
    );
  });

  it("refuses a timeout raise that no longer fits", () => {
    expect(() =>
      assertDeliveryLeaseInvariant(20, DELIVERY_CONCURRENCY, 60_000),
    ).toThrow(/lease invariant violated/i);
  });

  it("keeps a real margin with the shipped numbers", () => {
    const worstCaseMs =
      Math.ceil(20 / DELIVERY_CONCURRENCY) * PER_DELIVERY_TIMEOUT_MS;

    // Not merely under the lease: comfortably under it.
    expect(worstCaseMs * 2).toBeLessThan(DELIVERY_LEASE_SECONDS * 1000);
  });
});

describe("retry jitter", () => {
  it("stays within twenty percent of the scheduled delay", () => {
    const base = 30_000;

    for (let attempt = 0; attempt < 200; attempt++) {
      const jittered = withRetryJitter(base);

      expect(jittered).toBeGreaterThanOrEqual(base * 0.8);
      expect(jittered).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it("never schedules a retry sooner than a second", () => {
    expect(withRetryJitter(100)).toBeGreaterThanOrEqual(1_000);
  });

  it("actually spreads the batch instead of returning one value", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => withRetryJitter(30_000)),
    );

    // A convoy of retries marching back in lockstep is the failure this
    // exists to prevent, so identical values across 50 draws is a bug.
    expect(seen.size).toBeGreaterThan(1);
  });
});

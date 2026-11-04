import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import { sendExpoPushMessages } from "@/shared/notifications/push-provider";

/**
 * A push outlives its meaning when a phone is off for days (plan of
 * 02/11/2026, item A7; decision D41).
 *
 * Expo keeps an undelivered message for FCM/APNs' default of a month, so a
 * driver whose phone came back on Monday got Friday's "rota liberada" — a
 * route long finished. Each topic now says how long its message is worth
 * delivering (Expo's `ttl`), and a topic without a value keeps the provider's
 * default.
 */
const HOUR = 60 * 60;

let sentBodies: Array<Array<Record<string, unknown>>> = [];

beforeEach(() => {
  sentBodies = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)) as Array<
        Record<string, unknown>
      >;

      sentBodies.push(messages);

      return new Response(
        JSON.stringify({
          data: messages.map((_, index) => ({
            status: "ok",
            id: `ticket-${index}`,
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const content = {
  title: "Rota liberada",
  body: "Sua rota de hoje está pronta.",
  data: { url: "/deliveries" },
};

describe("the Expo push message's time to live", () => {
  it("carries the ttl it was given, in seconds", async () => {
    await sendExpoPushMessages(["ExponentPushToken[a]"], {
      ...content,
      ttlSeconds: 12 * HOUR,
    });

    const [[message]] = sentBodies;

    expect(message.ttl).toBe(12 * HOUR);
  });

  it("leaves the provider's default when the topic has none", async () => {
    await sendExpoPushMessages(["ExponentPushToken[a]"], content);

    const [[message]] = sentBodies;

    expect(message).not.toHaveProperty("ttl");
  });
});

describe("each topic's push validity (D41)", () => {
  it.each([
    ["route.released", 12 * HOUR],
    ["route.cancelled", 12 * HOUR],
    ["route.plan_changed", 12 * HOUR],
    ["chat-message.sent", 24 * HOUR],
    ["delivery-occurrence.authorization_decided", 12 * HOUR],
    ["delivery.status_overridden", 12 * HOUR],
    ["delivery-proof.ai-flagged", 24 * HOUR],
  ] as const)("%s keeps its push for %i seconds", (topic, seconds) => {
    expect(notificationPolicies[topic].pushTtlSeconds).toBe(seconds);
  });

  it("leaves every other topic on the provider's default", () => {
    const declared = Object.entries(notificationPolicies)
      .filter(([, policy]) => policy.pushTtlSeconds !== undefined)
      .map(([topic]) => topic)
      .sort();

    expect(declared).toEqual(
      [
        "chat-message.sent",
        "delivery-occurrence.authorization_decided",
        "delivery-proof.ai-flagged",
        "delivery.status_overridden",
        "route.cancelled",
        "route.plan_changed",
        "route.released",
      ].sort(),
    );
  });
});

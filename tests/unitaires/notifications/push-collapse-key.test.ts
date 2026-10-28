import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendExpoPushMessages } from "@/shared/notifications/push-provider";

/**
 * A push sent twice for the same delivery must not show twice.
 *
 * Expo does not deduplicate. A replica that dies between Expo's accept and
 * the UPDATE that records it leaves the row PROCESSING; after the lease the
 * next owner sends it again (resilience-crash-after-accept), and a
 * dead-letter replay does the same on purpose. Both copies carry the same
 * delivery id, and that id is now the message's `tag` (Android: replaces the
 * notification on screen) and, on an iPhone, its `collapseId` (APNs: replaces
 * it), so the second copy takes the first one's place.
 *
 * Never `collapseId` on Android: Expo turns it into FCM's collapse_key, and
 * FCM keeps at most four collapse keys for a phone that is offline — a key
 * per delivery would silently drop every notification past the fourth.
 */
const DELIVERY = "018fe000-0000-7000-8000-0000000000d1";

const ANDROID = "ExponentPushToken[android]";
const IPHONE = "ExponentPushToken[iphone]";

let sentBodies: unknown[] = [];

beforeEach(() => {
  sentBodies = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)) as unknown[];

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
  data: { url: "/notifications", deliveryId: DELIVERY },
};

describe("the Expo push message", () => {
  it("carries the collapse key as tag on every device, and as collapseId only on iPhones", async () => {
    const result = await sendExpoPushMessages(
      [ANDROID, IPHONE],
      { ...content, collapseKey: DELIVERY },
      new Set([IPHONE]),
    );

    expect(result.deliveredAny).toBe(true);

    const [messages] = sentBodies as Array<Array<Record<string, unknown>>>;

    expect(messages).toHaveLength(2);

    for (const message of messages) expect(message.tag).toBe(DELIVERY);

    const byDevice = new Map(messages.map((message) => [message.to, message]));

    expect(byDevice.get(IPHONE)?.collapseId).toBe(DELIVERY);

    // FCM's collapse_key: four per offline phone, the rest dropped.
    expect(byDevice.get(ANDROID)).not.toHaveProperty("collapseId");
  });

  it("never collapses in transit when no device is known to be an iPhone", async () => {
    await sendExpoPushMessages([ANDROID], {
      ...content,
      collapseKey: DELIVERY,
    });

    const [[message]] = sentBodies as Array<Array<Record<string, unknown>>>;

    expect(message.tag).toBe(DELIVERY);
    expect(message).not.toHaveProperty("collapseId");
  });

  it("sends the same key on a second send of the same delivery", async () => {
    for (let send = 0; send < 2; send += 1) {
      await sendExpoPushMessages(
        [ANDROID, IPHONE],
        { ...content, collapseKey: DELIVERY },
        new Set([IPHONE]),
      );
    }

    const keys = (sentBodies as Array<Array<Record<string, unknown>>>).map(
      (messages) =>
        messages.map((message) => `${message.tag}|${message.collapseId}`),
    );

    expect(keys).toEqual([
      [`${DELIVERY}|undefined`, `${DELIVERY}|${DELIVERY}`],
      [`${DELIVERY}|undefined`, `${DELIVERY}|${DELIVERY}`],
    ]);
  });

  it("keeps the rest of the payload as it was", async () => {
    await sendExpoPushMessages(
      [IPHONE],
      { ...content, collapseKey: DELIVERY },
      new Set([IPHONE]),
    );

    const [[message]] = sentBodies as Array<Array<Record<string, unknown>>>;

    expect(message).toEqual({
      to: IPHONE,
      title: content.title,
      body: content.body,
      data: content.data,
      sound: "default",
      channelId: "default",
      priority: "high",
      tag: DELIVERY,
      collapseId: DELIVERY,
    });
  });

  it("adds no collapse fields when no key is given", async () => {
    await sendExpoPushMessages(["ExponentPushToken[a]"], content);

    const [[message]] = sentBodies as Array<Array<Record<string, unknown>>>;

    expect(message).not.toHaveProperty("tag");
    expect(message).not.toHaveProperty("collapseId");
  });
});

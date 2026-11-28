import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import {
  fetchExpoPushReceipts,
  sendExpoPushMessages,
} from "@/shared/notifications/push-provider";

/**
 * Expo's "enhanced push security" (plan of 02/11/2026, item A8).
 *
 * Once somebody turns it on in the Expo project, every push and every receipt
 * query without the project's access token is refused with 401 — all of them,
 * at once, with nothing in the code to show why. The API now sends
 * `Authorization: Bearer <EXPO_ACCESS_TOKEN>` on both calls when the variable
 * is set, and nothing changes while it is not.
 */
const SECRET = "expo-access-token-de-teste";

let calls: Array<{ url: string; headers: Record<string, string> }> = [];

let previous: string | undefined;

beforeEach(() => {
  calls = [];
  previous = env.EXPO_ACCESS_TOKEN;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });

      const body = url.endsWith("/getReceipts")
        ? { data: {} }
        : { data: [{ status: "ok", id: "ticket-1" }] };

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  env.EXPO_ACCESS_TOKEN = previous;
  vi.unstubAllGlobals();
});

const content = { title: "Rota liberada", body: "Pronta.", data: {} };

describe("the Expo access token", () => {
  it("goes as a Bearer header on the send and on the receipts query", async () => {
    env.EXPO_ACCESS_TOKEN = SECRET;

    await sendExpoPushMessages(["ExponentPushToken[a]"], content);
    await fetchExpoPushReceipts(["ticket-1"]);

    expect(calls).toHaveLength(2);

    for (const call of calls) {
      expect(call.headers.Authorization).toBe(`Bearer ${SECRET}`);
    }
  });

  it("is left out entirely when the variable is not set", async () => {
    env.EXPO_ACCESS_TOKEN = undefined;

    await sendExpoPushMessages(["ExponentPushToken[a]"], content);
    await fetchExpoPushReceipts(["ticket-1"]);

    expect(calls).toHaveLength(2);

    for (const call of calls) {
      expect(call.headers).not.toHaveProperty("Authorization");
    }
  });
});

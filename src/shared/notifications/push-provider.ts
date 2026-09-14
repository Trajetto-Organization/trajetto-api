/**
 * Expo Push API client (plain HTTP — the endpoint is a single POST, an SDK
 * would be a dependency for one call). Expo relays to FCM/APNs using the
 * credentials configured in the EAS project, so the API needs no Firebase
 * secret of its own.
 */

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/**
 * Without an explicit signal, undici lets a stalled connection hang for
 * minutes. The notification pipeline claims this row under a lease and
 * processes the batch concurrently, so a hung push would hold its slot until
 * the lease expired and another replica sent the same tray message again.
 * Ten seconds sits under the pipeline's own per-delivery backstop.
 */
const REQUEST_TIMEOUT_MS = 10_000;

interface ExpoPushTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

interface PushContent {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

interface PushSendResult {
  /** At least one device accepted the message. */
  deliveredAny: boolean;

  /** Tokens the provider declared dead — prune them, never retry them. */
  invalidTokens: string[];
}

async function sendExpoPushMessages(
  tokens: string[],
  content: PushContent,
): Promise<PushSendResult> {
  const messages = tokens.map((token) => ({
    to: token,
    title: content.title,
    body: content.body,
    data: content.data,
    sound: "default",
    channelId: "default",
    priority: "high",
  }));

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Expo push respondeu HTTP ${response.status}`);
  }

  const result = (await response.json()) as { data?: ExpoPushTicket[] };
  const tickets = result.data ?? [];

  let deliveredAny = false;
  const invalidTokens: string[] = [];

  tickets.forEach((ticket, index) => {
    if (ticket.status === "ok") {
      deliveredAny = true;
      return;
    }

    if (ticket.details?.error === "DeviceNotRegistered") {
      const token = tokens[index];
      if (token) invalidTokens.push(token);
    }
  });

  return { deliveredAny, invalidTokens };
}

export { sendExpoPushMessages };
export type { PushContent, PushSendResult };

import {
  httpOutcome,
  observeProviderCall,
} from "@/shared/health/provider-metrics";

/**
 * Expo Push API client (plain HTTP — the endpoint is a single POST, an SDK
 * would be a dependency for one call). Expo relays to FCM/APNs using the
 * credentials configured in the EAS project, so the API needs no Firebase
 * secret of its own.
 */

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";

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
  /** Present on an accepted ticket: what its receipt is asked for by. */
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Same shape as a ticket's error, minus the id: FCM/APNs' verdict. */
interface ExpoPushReceipt {
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

  /**
   * One per device Expo accepted. A ticket only says Expo queued it; whether
   * FCM/APNs took it — and whether the device still exists — is its receipt,
   * published minutes later (see check-push-receipts-job).
   */
  tickets: Array<{ id: string; token: string }>;
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

  // Timed per call for /health/metrics (latency and error rate per channel).
  const response = await observeProviderCall(
    "PUSH",
    () =>
      fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    httpOutcome,
  );

  if (!response.ok) {
    // The status rides on the error: the pipeline writes it into lastError
    // as `[push http=401]`, which the ops alerting reads (OBS-08).
    throw Object.assign(
      new Error(`Expo push respondeu HTTP ${response.status}`),
      {
        httpStatus: response.status,
      },
    );
  }

  const result = (await response.json()) as { data?: ExpoPushTicket[] };
  const tickets = result.data ?? [];

  let deliveredAny = false;
  const invalidTokens: string[] = [];
  const accepted: Array<{ id: string; token: string }> = [];

  // Expo answers in the order the messages were sent, one ticket each.
  tickets.forEach((ticket, index) => {
    if (ticket.status === "ok") {
      deliveredAny = true;

      const token = tokens[index];
      if (ticket.id && token) accepted.push({ id: ticket.id, token });

      return;
    }

    if (ticket.details?.error === "DeviceNotRegistered") {
      const token = tokens[index];
      if (token) invalidTokens.push(token);
    }
  });

  return { deliveredAny, invalidTokens, tickets: accepted };
}

/**
 * The receipts for up to 1000 tickets (Expo's limit per call). A ticket with
 * no entry in the answer has no receipt YET; Expo keeps them for a day.
 */
async function fetchExpoPushReceipts(
  ids: string[],
): Promise<Record<string, ExpoPushReceipt>> {
  if (ids.length === 0) return {};

  const response = await fetch(EXPO_RECEIPTS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Expo receipts respondeu HTTP ${response.status}`);
  }

  const result = (await response.json()) as {
    data?: Record<string, ExpoPushReceipt>;
  };

  return result.data ?? {};
}

export { fetchExpoPushReceipts, sendExpoPushMessages };
export type { ExpoPushReceipt, PushContent, PushSendResult };

import { env } from "@/env";
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

/**
 * The headers of every call to Expo. With "enhanced push security" turned on
 * in the Expo project, a send or a receipts query without the project's
 * access token is refused with 401 — every push at once (plan of 02/11/2026,
 * item A8). The token is optional: without it nothing changes, and the owner
 * turns the setting on only after the variable is live in both environments
 * (decision D43). Read per call, so a test or a hot env change is honoured.
 */
function expoHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(env.EXPO_ACCESS_TOKEN
      ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` }
      : {}),
  };
}

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

  /**
   * One id per logical message: a second send under the same key replaces
   * the first instead of adding a twin to the tray. The pipeline passes the
   * notification delivery id, which is unique per (event, recipient,
   * channel), so only copies of the SAME delivery collapse — a redelivery
   * after a crash between Expo's accept and our UPDATE, or a dead-letter
   * replay. Expo does not deduplicate on its own.
   *
   * Sent as `tag` to every device (Android: replaces a notification already
   * displayed; iOS ignores it) and as `collapseId` to iPhones only (APNs
   * apns-collapse-id: replaces the displayed one) — docs.expo.dev, "Message
   * request format".
   *
   * Never `collapseId` on Android: Expo maps it to FCM's collapse_key, and
   * FCM stores at most four collapse keys per device while it is offline,
   * dropping the rest with no say in which (firebase.google.com, "Collapsible
   * and non-collapsible messages"). A key per delivery would turn every push
   * collapsible: a driver out of signal who is sent five notifications would
   * get four. Without it they stay non-collapsible (up to 100 stored).
   */
  collapseKey?: string;

  /**
   * How long Expo (and FCM/APNs behind it) keeps the message for a phone
   * that is off or out of signal, in seconds. Absent = the provider's
   * default of a month — which is how a driver whose phone came back on
   * Monday got Friday's "rota liberada" (plan of 02/11/2026, A7). Each topic
   * states its own value on its policy (`pushTtlSeconds`, decision D41).
   */
  ttlSeconds?: number;
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

/**
 * The most messages one call to Expo may carry (docs.expo.dev, "Send push
 * notifications": "up to 100 messages" per request; more is refused as
 * PUSH_TOO_MANY_NOTIFICATIONS).
 */
const EXPO_MAX_MESSAGES_PER_REQUEST = 100;

/** Calls at once when a refused call is sent again one request per call. */
const SPLIT_CONCURRENCY = 5;

/** One recipient's messages: its devices, one content (sendExpoPushBatch). */
interface PushRequest {
  tokens: string[];
  content: PushContent;

  /** Which of `tokens` are iPhones: only they get `collapseId` (above). */
  iosTokens?: ReadonlySet<string>;
}

/** What one request of a batch got: its own result, or the call's failure. */
type PushBatchOutcome =
  { ok: true; result: PushSendResult } | { ok: false; error: PushCallError };

/** A failed call; `httpStatus` when Expo answered (absent: network, timeout). */
type PushCallError = Error & { httpStatus?: number };

function messagesOf({ tokens, content, iosTokens }: PushRequest) {
  return tokens.map((token) => ({
    to: token,
    title: content.title,
    body: content.body,
    data: content.data,
    sound: "default",
    channelId: "default",
    priority: "high",
    ...(content.ttlSeconds ? { ttl: content.ttlSeconds } : {}),
    ...(content.collapseKey ? { tag: content.collapseKey } : {}),
    ...(content.collapseKey && iosTokens?.has(token)
      ? { collapseId: content.collapseKey }
      : {}),
  }));
}

/** One POST to Expo: its tickets, or a throw that carries the status. */
async function postMessages(messages: unknown[]): Promise<ExpoPushTicket[]> {
  // Timed per call for /health/metrics (latency and error rate per channel).
  const response = await observeProviderCall(
    "PUSH",
    () =>
      fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: expoHeaders(),
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

  return result.data ?? [];
}

/** A recipient's result from its own tickets, in the order of its tokens. */
function resultOf(tokens: string[], tickets: ExpoPushTicket[]): PushSendResult {
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

async function sendExpoPushMessages(
  tokens: string[],
  content: PushContent,

  /** Which of `tokens` are iPhones: only they get `collapseId` (above). */
  iosTokens: ReadonlySet<string> = new Set(),
): Promise<PushSendResult> {
  const tickets = await postMessages(
    messagesOf({ tokens, content, iosTokens }),
  );

  return resultOf(tokens, tickets);
}

/**
 * Whole requests packed into calls of at most 100 messages, in order. A
 * request is never split: its tickets come back from one call, and a
 * failed call fails all of it. One that alone passes 100 goes in a call of
 * its own, as it went before the batch (Expo refuses it, as it did then).
 */
function packRequests(requests: readonly PushRequest[]): number[][] {
  const calls: number[][] = [];
  let current: number[] = [];
  let size = 0;

  requests.forEach((request, index) => {
    const count = request.tokens.length;

    if (current.length > 0 && size + count > EXPO_MAX_MESSAGES_PER_REQUEST) {
      calls.push(current);
      current = [];
      size = 0;
    }

    current.push(index);
    size += count;
  });

  if (current.length > 0) calls.push(current);

  return calls;
}

/**
 * Several recipients' messages in as few calls as Expo takes (plano-escala
 * U-06): the notification pipeline's push rows of one batch, each with its
 * own tokens and content, packed into POSTs of up to 100 messages.
 *
 * Expo answers one ticket per message, in the order sent, and its ids say
 * nothing about which message they belong to. So each call keeps the map
 * from a message's position to its request and token, and every request
 * gets back only the tickets at its own positions: its accepted tickets,
 * its dead tokens, whether any of its devices took it. An answer whose
 * ticket count is not the message count is not guessed at: every request
 * of that call fails, rather than one recipient's receipt landing on
 * another's delivery.
 *
 * A call that fails fails its own requests and no other: each comes back
 * with the error, the HTTP status on it. A 400 for a call of several
 * requests is the whole call refused (Expo validates the request before
 * sending any of it: PUSH_TOO_MANY_EXPERIENCE_IDS when a token of another
 * Expo project rode along, for one), so it is sent again one request per
 * call: the request that caused it fails alone, as it did before the batch.
 *
 * Never rejects: each request's outcome is in the array, by position.
 */
async function sendExpoPushBatch(
  requests: readonly PushRequest[],
): Promise<PushBatchOutcome[]> {
  const outcomes: PushBatchOutcome[] = new Array(requests.length);

  await Promise.all(
    packRequests(requests).map((call) => sendCall(requests, call, outcomes)),
  );

  return outcomes;
}

async function sendCall(
  requests: readonly PushRequest[],
  call: number[],
  outcomes: PushBatchOutcome[],
): Promise<void> {
  // Position in the call → (request, token): the map the tickets go by.
  const owners: Array<{ request: number; token: string }> = [];
  const messages: unknown[] = [];

  for (const index of call) {
    const request = requests[index];

    messages.push(...messagesOf(request));
    for (const token of request.tokens) owners.push({ request: index, token });
  }

  let tickets: ExpoPushTicket[];

  try {
    tickets = await postMessages(messages);
  } catch (error) {
    const failure = asCallError(error);

    if (failure.httpStatus === 400 && call.length > 1) {
      // A few at a time: the split of a call of a hundred must not land on
      // Expo as a hundred calls at once.
      for (let start = 0; start < call.length; start += SPLIT_CONCURRENCY) {
        await Promise.all(
          call
            .slice(start, start + SPLIT_CONCURRENCY)
            .map((index) => sendCall(requests, [index], outcomes)),
        );
      }

      return;
    }

    for (const index of call) outcomes[index] = { ok: false, error: failure };

    return;
  }

  if (tickets.length !== messages.length) {
    const failure: PushCallError = new Error(
      `Expo devolveu ${tickets.length} tickets para ${messages.length} mensagens; nenhum foi atribuído`,
    );

    for (const index of call) outcomes[index] = { ok: false, error: failure };

    return;
  }

  const own = new Map<number, ExpoPushTicket[]>(
    call.map((index) => [index, []]),
  );

  tickets.forEach((ticket, position) => {
    own.get(owners[position].request)!.push(ticket);
  });

  for (const index of call) {
    outcomes[index] = {
      ok: true,
      result: resultOf(requests[index].tokens, own.get(index)!),
    };
  }
}

function asCallError(error: unknown): PushCallError {
  return error instanceof Error
    ? (error as PushCallError)
    : new Error(String(error));
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
    headers: expoHeaders(),
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

export {
  EXPO_MAX_MESSAGES_PER_REQUEST,
  expoHeaders,
  fetchExpoPushReceipts,
  sendExpoPushBatch,
  sendExpoPushMessages,
};
export type {
  ExpoPushReceipt,
  PushBatchOutcome,
  PushCallError,
  PushContent,
  PushRequest,
  PushSendResult,
};

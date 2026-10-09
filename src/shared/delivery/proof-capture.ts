import { CLIENT_VERSION_HEADER, parseClientVersion } from "@/shared/http/client-version";

import { CLIENT_SENT_AT_HEADER, resolveOccurredAt } from "./occurred-at";

/**
 * What the phone says about the receipt photo (decision 14.8, design §7.2 of
 * the ICP proof): when the photo was taken and which phone took it. The
 * proof document prints both, so they are advisory like occurred_at: what
 * cannot be read becomes null, never a refusal — from the driver's offline
 * queue a 400 is a permanent failure, and a proof is not lost over a stamp.
 */

/** The phone's Android ID (expo-application getAndroidId): 16 hex digits. */
const ANDROID_ID = /^[0-9a-f]{16}$/i;

/** The fallback the app keeps in SecureStore when there is no Android ID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How much of a User-Agent the trail keeps. */
const DEVICE_LABEL_MAX = 120;

/**
 * When the receipt photo was taken, on the server's clock: moved by the
 * phone's clock error like occurred_at (X-Client-Sent-At), never more than
 * the offline week old, and never after the tap that sent the proof (or
 * after now, when there was none). Null when absent or unreadable.
 */
function resolvePhotoTakenAt(input: {
  photoTakenAt: unknown;
  clientSentAt?: unknown;
  /** The proof's own instant, already resolved; null = received now. */
  occurredAt: Date | null;
  now?: Date;
}): Date | null {
  const now = input.now ?? new Date();

  const taken = resolveOccurredAt({
    occurredAt: input.photoTakenAt,
    clientSentAt: input.clientSentAt,
    now,
  });

  if (!taken) return null;

  const cap = input.occurredAt ?? now;

  return taken.getTime() > cap.getTime() ? new Date(cap.getTime()) : taken;
}

/** The phone's stable id, in lower case, or null for anything else. */
function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  return ANDROID_ID.test(trimmed) || UUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Which app build sent it, for the trail's "device" (DRIVER_APP only): the
 * platform, version and build from x-trajetto-client-version, or else the
 * User-Agent, bounded. Null when the request says neither.
 */
function deviceLabel(headers: Record<string, unknown>): string | null {
  const client = parseClientVersion(headers[CLIENT_VERSION_HEADER]);

  if (client?.platform || client?.version) {
    const name = [client.platform, client.version].filter(Boolean).join(" ");

    return client.build !== undefined ? `${name} (build ${client.build})` : name;
  }

  const userAgent = headers["user-agent"];

  if (typeof userAgent !== "string" || userAgent.trim() === "") return null;

  return userAgent.trim().slice(0, DEVICE_LABEL_MAX);
}

/** The photo stamp and the phone, as the PROOF event stores them. */
interface ProofCapture {
  photoTakenAt: Date | null;
  deviceId: string | null;
  device: string | null;
}

/** The capture of one proof request, from its body and headers. */
function proofCaptureOf(input: {
  headers: Record<string, unknown>;
  photoTakenAt: unknown;
  deviceId: unknown;
  /** The proof's own instant, already resolved; null = received now. */
  occurredAt: Date | null;
}): ProofCapture {
  return {
    photoTakenAt: resolvePhotoTakenAt({
      photoTakenAt: input.photoTakenAt,
      clientSentAt: input.headers[CLIENT_SENT_AT_HEADER],
      occurredAt: input.occurredAt,
    }),
    deviceId: normalizeDeviceId(input.deviceId),
    device: deviceLabel(input.headers),
  };
}

export { deviceLabel, normalizeDeviceId, proofCaptureOf, resolvePhotoTakenAt };
export type { ProofCapture };

import { z } from "zod";

const uuid = z.string().uuid();

/**
 * The idempotency key of a driver submission, read the way the create
 * controllers read it — the body's `client_submission_id` first, then the
 * `Idempotency-Key` header when the body has none — but BEFORE anything else
 * in the body is validated.
 *
 * That ordering is the point. The app's outbox freezes the body it queued, and
 * resends it after the network died on the answer. If the server was deployed
 * in between with a stricter schema, the resend of a record that already
 * exists used to fail validation and turn into a red "failed" item on the
 * phone — and the driver's natural next step, typing it again, is a new key.
 * Looking the key up first answers that resend with what it already created.
 *
 * Only a well-formed UUID is returned. Anything else goes down the normal
 * path, where the schema refuses it with a proper message.
 */
function submissionKeyOf(
  body: unknown,
  idempotencyHeader: unknown,
): string | undefined {
  const fromBody =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).client_submission_id
      : undefined;

  // Same precedence as the controllers: an empty body value falls through to
  // the header, anything else in the body wins.
  const raw = fromBody ? fromBody : idempotencyHeader;

  return uuid.safeParse(raw).success ? (raw as string) : undefined;
}

export { submissionKeyOf };

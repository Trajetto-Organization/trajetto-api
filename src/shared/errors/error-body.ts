import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifySerializerCompiler } from "fastify/types/schema";

import { fallbackCodeFor } from "./http-error-rules";

/**
 * Every refusal leaves as `{ code, message, issues? }` (decision 11.3).
 *
 * The error handler (http.ts) sends its bodies already serialized, so no
 * route schema touches them. A body a controller sends itself is an object,
 * and two things went wrong with it:
 *
 * - it went through the route's response schema for that status, and a
 *   schema listing only `message` stripped `code` and every detail field in
 *   silence (zod drops unknown keys);
 * - a controller that sent `{ message }` alone left the client nothing
 *   stable to decide on, while the published document promises `code`.
 *
 * So a 4xx object body is serialized as built, and gains a code from its
 * status when it has none, plus the `x-error-code` header the handler sends.
 * 5xx bodies are left alone: the only ones a route builds itself are probes
 * (/health), whose schema IS the contract.
 */
function isClientErrorStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * Wraps the zod serializer compiler: a 4xx body is never filtered by the
 * route's schema. Success bodies and 5xx keep the schema, which is what keeps
 * internal columns out of a success response.
 */
function errorAwareSerializerCompiler<T>(
  compile: FastifySerializerCompiler<T>,
): FastifySerializerCompiler<T> {
  return (route) => {
    if (isClientErrorStatus(Number(route.httpStatus))) {
      return (data: unknown) => JSON.stringify(data);
    }

    return compile(route);
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * preSerialization hook: completes a 4xx object body with `code` and the
 * header. Strings, buffers and streams never reach this hook, which is how
 * the handler's serialized bodies pass untouched.
 */
async function completeErrorBody(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (!isClientErrorStatus(reply.statusCode) || !isPlainObject(payload)) {
    return payload;
  }

  const code =
    typeof payload.code === "string" && payload.code.length > 0
      ? payload.code
      : fallbackCodeFor(reply.statusCode);

  if (!reply.hasHeader("x-error-code")) reply.header("x-error-code", code);

  return payload.code === code ? payload : { ...payload, code };
}

export { completeErrorBody, errorAwareSerializerCompiler };

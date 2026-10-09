import type { FastifyBodyParser } from "fastify";

/**
 * Wraps a JSON body parser so that an EMPTY body is `undefined` instead of an
 * error, and hands everything else to the wrapped parser untouched.
 *
 * The wrapped parser is meant to be Fastify's own default
 * (`app.getDefaultJsonParser('error', 'error')`): it runs `secure-json-parse`,
 * which refuses `__proto__` and `constructor.prototype` keys with a 400. A
 * bare `JSON.parse` accepts both and leaves the poisoned key on the parsed
 * object, one `Object.assign` or schema-less route away from prototype
 * pollution. The default parser also already tags malformed JSON with
 * `statusCode = 400`, so the error handler answers it as the caller's mistake.
 */
function tolerateEmptyJsonBody(
  strict: FastifyBodyParser<string>,
): FastifyBodyParser<string> {
  return (request, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";

    if (text.length === 0) return done(null, undefined);

    return strict(request, text, done);
  };
}

export { tolerateEmptyJsonBody };

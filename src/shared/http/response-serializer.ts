import type { FastifySerializerCompiler } from "fastify/types/schema";
import {
  InvalidSchemaError,
  ResponseSerializationError,
} from "fastify-type-provider-zod";
import { $ZodType, safeParse } from "zod/v4/core";

/**
 * The success body, PARSED by the route's response schema.
 *
 * fastify-type-provider-zod 7 ENCODES it instead (zod 4's reverse
 * direction). Encoding fills no `.default()` — a schema whose `message`
 * defaults to a sentence, with a handler that leaves it to the schema, would
 * answer 500 — and cannot run a `.transform()` or `z.preprocess()` backwards
 * at all. Parsing is what the type provider's 4.x did with zod 3, so every
 * body the API sends today leaves exactly as before: unknown fields
 * stripped, defaults filled, and a body that breaks its schema refused with
 * the same FST_ERR_RESPONSE_SERIALIZATION 500.
 *
 * A 4xx never gets here (errorAwareSerializerCompiler, error-body.ts).
 */
type ResponseSchema = $ZodType | { properties: $ZodType };

function schemaOf(maybeSchema: ResponseSchema): $ZodType {
  if (maybeSchema instanceof $ZodType) return maybeSchema;

  if (maybeSchema.properties instanceof $ZodType) return maybeSchema.properties;

  throw new InvalidSchemaError(JSON.stringify(maybeSchema));
}

const parsingSerializerCompiler: FastifySerializerCompiler<ResponseSchema> = ({
  schema: maybeSchema,
  method,
  url,
}) => {
  const schema = schemaOf(maybeSchema);

  return (data) => {
    const result = safeParse(schema, data);

    if (!result.success) {
      throw new ResponseSerializationError(method, url, {
        cause: result.error,
      });
    }

    return JSON.stringify(result.data);
  };
};

export { parsingSerializerCompiler };

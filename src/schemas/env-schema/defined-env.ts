import { z } from "zod";

import { envSchema } from "./index";

type RawEnv = Record<string, string | undefined>;

/**
 * The object schema under the refinements and the transform. Unwrapped in a
 * loop so adding another `.superRefine()`/`.transform()` to the schema does not
 * silently turn every field into "unknown" here.
 */
function envShape(): Record<string, z.ZodTypeAny> {
  let schema: z.ZodTypeAny = envSchema;

  while (schema instanceof z.ZodEffects) schema = schema.innerType();

  return (schema as z.AnyZodObject).shape;
}

/**
 * The environment with every EMPTY optional variable treated as unset.
 *
 * The production compose passes optional settings as `${VAR}` or `${VAR:-}`,
 * so a variable the stack does not define reaches the container as "". Zod's
 * `.default()` only fires on `undefined`: the Meta template name and API
 * version came out empty in production, and a coerced number came out as 0.
 *
 * Only fields that accept `undefined` (optional or defaulted) are normalised.
 * A required field keeps whatever it was given, so a deploy that boots today
 * still boots.
 */
function definedEnv(source: RawEnv): RawEnv {
  const shape = envShape();

  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => !(value === "" && shape[key]?.isOptional()),
    ),
  );
}

export { definedEnv, envShape };

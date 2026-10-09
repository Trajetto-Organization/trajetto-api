import { z } from "zod";

/**
 * A documentation schema turned into a checker that refuses any key it does
 * not name, at every depth.
 *
 * zod strips unknown keys by default, so parsing a real payload with the
 * documented schema only proves the documented fields are THERE — not that
 * the document lists everything that goes out. Both directions matter for a
 * body the serializer passes through untouched.
 */
function deepStrict(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    return z
      .object(
        Object.fromEntries(
          Object.entries(schema.shape as z.ZodRawShape).map(([key, value]) => [
            key,
            deepStrict(value),
          ]),
        ),
      )
      .strict();
  }

  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap()).nullable();
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element));

  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as z.ZodTypeAny[]).map(deepStrict);

    return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  return schema;
}

/** Every issue as `path: message`, so a failure names the field. */
function strictIssues(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = deepStrict(schema).safeParse(value);

  return result.success
    ? []
    : result.error.issues.map(
        (issue) =>
          `${issue.path.join(".") || "(raiz)"}: ${issue.message}${
            "keys" in issue ? ` ${JSON.stringify(issue.keys)}` : ""
          }`,
      );
}

export { deepStrict, strictIssues };

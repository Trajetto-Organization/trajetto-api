import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * An empty variable is an unset variable.
 *
 * The production compose passes optional settings as `${VAR}` or `${VAR:-}`,
 * so a variable the stack does not define reaches the container as an EMPTY
 * string. Zod's `.default()` only fires on `undefined`: the Meta template name
 * and API version came out empty in production, and a coerced number came out
 * as 0. Only fields that accept `undefined` are normalised; a required field
 * keeps whatever it was given, exactly as before.
 */
const base = {
  NODE_ENV: "test",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "local",
};

describe("the environment the API boots with", () => {
  it("was hit by the bug: an empty optional value skips the default", () => {
    const parsed = envSchema.parse({
      ...base,
      META_WHATSAPP_TEMPLATE_NAME: "",
    });

    expect(parsed.META_WHATSAPP_TEMPLATE_NAME).toBe("");
  });

  it("gives an empty optional value its default", () => {
    const parsed = envSchema.parse(
      definedEnv({
        ...base,
        META_WHATSAPP_TEMPLATE_NAME: "",
        META_WHATSAPP_API_VERSION: "",
        PORT: "",
      }),
    );

    expect(parsed.META_WHATSAPP_TEMPLATE_NAME).toBe("trajetto_notification");
    expect(parsed.META_WHATSAPP_API_VERSION).toBe("v23.0");
    expect(parsed.PORT).toBe(3333);
  });

  it("leaves a required value alone, even empty", () => {
    const source = { ...base, JWT_SECRET: "" };

    expect(definedEnv(source).JWT_SECRET).toBe("");
  });

  it("keeps every value that was actually set", () => {
    const source = { ...base, META_WHATSAPP_TEMPLATE_NAME: "outro_template" };

    expect(definedEnv(source)).toEqual(source);
  });

  it("is what the loader parses", () => {
    const loader = readFileSync(
      resolve(__dirname, "../../../src/env/index.ts"),
      "utf8",
    );

    expect(loader).toContain("envSchema.safeParse(definedEnv(process.env))");
  });
});

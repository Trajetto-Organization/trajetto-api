import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  passwordField,
  sessionLoginSchema,
} from "@/schemas/authenticate-user-schema";
import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";

/**
 * A password set before zod 4 still signs in.
 *
 * zod 3 measured a text in UTF-16 units and zod 4 in characters (code
 * points): an emoji was 2 and is 1. "abc😀😀" passed the 7 of `passwordField`
 * then and is 5 now, so read with the setter's rule the login refused it as
 * short (400) before the hash was compared, and the account was locked until
 * a reset. The login and the current password of a change keep the floor in
 * units; a new password follows zod 4.
 */
const SET_BEFORE_ZOD_4 = "abc😀😀";

const messagesOf = (schema: z.ZodType, body: unknown) => {
  const result = schema.safeParse(body);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("the password of a login", () => {
  it("takes a password zod 3 took, whatever zod 4 counts", () => {
    expect(SET_BEFORE_ZOD_4).toHaveLength(7);
    expect([...SET_BEFORE_ZOD_4]).toHaveLength(5);

    expect(
      messagesOf(sessionLoginSchema, {
        email: "ana.souza@transportadora.com.br",
        password: SET_BEFORE_ZOD_4,
      }),
    ).toEqual([]);
    expect(
      messagesOf(updateUserPasswordSchema, {
        currentPassword: SET_BEFORE_ZOD_4,
        newPassword: "Nova@Senha1",
      }),
    ).toEqual([]);
  });

  it("refuses a short or a long one with the same sentences", () => {
    expect(
      messagesOf(sessionLoginSchema, {
        email: "ana.souza@transportadora.com.br",
        password: "abc",
      }),
    ).toEqual(["A senha deve ter pelo menos 7 caracteres."]);
    expect(
      messagesOf(sessionLoginSchema, {
        email: "ana.souza@transportadora.com.br",
        password: "a".repeat(101),
      }),
    ).toEqual(["A senha deve ter no máximo 100 caracteres."]);
  });

  it("takes every password the setter takes now (100 emoji included)", () => {
    const longest = "😀".repeat(100);

    expect(messagesOf(passwordField, longest)).toEqual([]);
    expect(
      messagesOf(sessionLoginSchema, {
        email: "ana.souza@transportadora.com.br",
        password: longest,
      }),
    ).toEqual([]);
  });

  it("still publishes the floor and the ceiling", () => {
    expect(
      z.toJSONSchema(sessionLoginSchema, { io: "input" }).properties?.password,
    ).toMatchObject({ type: "string", minLength: 7, maxLength: 100 });
  });
});

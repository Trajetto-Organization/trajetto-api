import { afterAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";

/**
 * What the reset and verification tables hold, read straight from Postgres
 * (AUTH-04).
 *
 * The unit file proves the use cases against the in-memory fake. This one
 * proves the Prisma repository — the code that actually writes the column —
 * because a fake that hashed while the real repository did not would leave
 * every unit test green and every token readable.
 */
const prisma = new PrismaClient();
const tokens = new UserTokensRepository(prisma);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const inAnHour = (): Date => new Date(Date.now() + 60 * 60 * 1000);

const emails: string[] = [];

function freshEmail(): string {
  const email = `repouso-${randomUUID()}@exemplo.com.br`;
  emails.push(email);

  return email;
}

afterAll(async () => {
  await prisma.forgotPasswordVerificationToken.deleteMany({
    where: { email: { in: emails } },
  });
  await prisma.emailVerificationToken.deleteMany({
    where: { email: { in: emails } },
  });

  await prisma.$disconnect();
});

describe("the password reset table", () => {
  it("holds the SHA-256 of the token, not the token", async () => {
    const email = freshEmail();
    const mailed = randomUUID();

    await tokens.createForgotPasswordVerificationToken({
      email,
      token: mailed,
      expires: inAnHour(),
    });

    const [row] = await prisma.$queryRaw<{ token: string }[]>`
      SELECT "token" FROM "forgot_password_verification_token"
      WHERE "email" = ${email}
    `;

    expect(row.token).not.toBe(mailed);
    expect(row.token).toBe(sha256(mailed));
  });

  it("finds the row by the mailed token and not by the stored value", async () => {
    const email = freshEmail();
    const mailed = randomUUID();

    await tokens.createForgotPasswordVerificationToken({
      email,
      token: mailed,
      expires: inAnHour(),
    });

    const found = await tokens.findForgotPasswordVerificationTokenByToken(
      mailed,
    );

    expect(found?.email).toBe(email);

    expect(
      await tokens.findForgotPasswordVerificationTokenByToken(sha256(mailed)),
    ).toBeNull();
  });

  it("replaces the stored hash when a new link is asked for", async () => {
    const email = freshEmail();
    const first = randomUUID();
    const second = randomUUID();

    await tokens.createForgotPasswordVerificationToken({
      email,
      token: first,
      expires: inAnHour(),
    });
    await tokens.createForgotPasswordVerificationToken({
      email,
      token: second,
      expires: inAnHour(),
    });

    expect(
      await tokens.findForgotPasswordVerificationTokenByToken(first),
    ).toBeNull();
    expect(
      (await tokens.findForgotPasswordVerificationTokenByToken(second))?.email,
    ).toBe(email);
  });
});

describe("the e-mail verification table", () => {
  it("holds the SHA-256 of the token, and finds it by the mailed one", async () => {
    const email = freshEmail();
    const mailed = randomUUID();

    await tokens.createEmailVerificationToken({
      email,
      token: mailed,
      expires: inAnHour(),
    });

    const [row] = await prisma.$queryRaw<{ token: string }[]>`
      SELECT "token" FROM "email_verification_token" WHERE "email" = ${email}
    `;

    expect(row.token).toBe(sha256(mailed));
    expect((await tokens.findEmailVerificationTokenByToken(mailed))?.email).toBe(
      email,
    );
    expect(await tokens.findEmailVerificationTokenByToken(row.token)).toBeNull();
  });
});

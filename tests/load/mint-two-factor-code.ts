import { createPrismaClient } from "@/shared/database/database-client";
/**
 * Replaces the pending two-factor code of one account with a code the browser
 * suite knows.
 *
 *   DATABASE_URL="...load_test..." npx tsx tests/load/mint-two-factor-code.ts <email> <code>
 *
 * The real code travels by e-mail (the in-process test inbox when the API
 * runs with NODE_ENV=test, as in the browser suites; Ethereal in development) and
 * only its keyed hash is stored. The spec submits the login form first — so
 * the API issues the challenge and the row exists, exactly as for a person —
 * and then swaps the stored hash for one of a code it chose, with the same
 * `hashOneTimeCode` the API verifies against. Nothing else about the flow is
 * bypassed: the challenge, the attempt counter and the expiry stay real.
 */

import { hashOneTimeCode } from "../../src/shared/security/one-time-code";
import { assertDisposableDatabase } from "./lib/disposable-database";

const prisma = createPrismaClient();

async function main(): Promise<void> {
  const [email, code] = process.argv.slice(2);

  assertDisposableDatabase();

  if (!email || !/^\d{6}$/.test(code ?? "")) {
    throw new Error(
      "Uso: mint-two-factor-code.ts <email> <código de 6 dígitos>",
    );
  }

  const { count } = await prisma.twoFactorToken.updateMany({
    where: { email },
    data: { token: hashOneTimeCode(code), attempts: 0 },
  });

  if (count !== 1) {
    throw new Error(
      `Nenhum código pendente para ${email}: envie o formulário de login antes.`,
    );
  }

  console.log(`[Web E2E] Código de dois fatores trocado para ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

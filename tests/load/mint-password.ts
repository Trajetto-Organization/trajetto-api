import { createPrismaClient } from "@/shared/database/database-client";
/**
 * Gives an account created during a browser journey the suite's password.
 *
 *   DATABASE_URL="...load_test..." npx tsx tests/load/mint-password.ts <email>
 *
 * When the MASTER registers a manager, or a manager registers a driver, the
 * API generates a password and e-mails it (an Ethereal inbox outside
 * production). The journey spec stands in for the person reading that e-mail:
 * it sets the documented test password (WEB_E2E_PASSWORD, or the default of
 * mint-browser-users.ts) and marks the address verified, then signs in through
 * the form like anybody else. Only on the throwaway database.
 */

import { hash } from "bcrypt";
import { assertDisposableDatabase } from "./lib/disposable-database";

const prisma = createPrismaClient();

const PASSWORD = process.env.WEB_E2E_PASSWORD ?? "Navegador@E2E2026";

async function main(): Promise<void> {
  const [email] = process.argv.slice(2);

  assertDisposableDatabase();

  if (!email) throw new Error("Uso: mint-password.ts <email>");

  const { count } = await prisma.user.updateMany({
    where: { email },
    data: {
      password: await hash(PASSWORD, 10),
      email_verified: new Date(),
      failed_login_attempts: 0,
      login_locked_until: null,
    },
  });

  if (count !== 1) throw new Error(`Nenhum usuário com o e-mail ${email}.`);

  console.log(`[Web E2E] Senha de teste definida para ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

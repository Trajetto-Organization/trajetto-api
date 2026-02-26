import { env } from "@/env";
import { hash } from "bcrypt";

import database from "@/../infra/database";

async function checkDatabaseConnection(retries = 5, interval = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      // Try running a query to check the connection
      await database.$queryRaw`SELECT 1`;
      console.log(
        "\n🟢 Conexão com o banco de dados estabelecida com sucesso!",
      );

      return true;
    } catch (error) {
      if (i === retries - 1) {
        console.error(
          "\n❌ Falha ao conectar ao banco de dados após várias tentativas",
        );

        throw error;
      }

      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

async function seed() {
  try {
    process.stdout.write("\n\n⚡ Verificando conexão com o banco de dados");
    await checkDatabaseConnection();

    const usersCount = await database.user.count();

    if (usersCount > 0) {
      console.log("✅ Banco de dados já possui usuários. Seed abortado.");
      return;
    }

    // Check if environment variables are set
    const masterEmail = env.MASTER_USER_EMAIL;
    const masterPassword = env.MASTER_USER_INITIAL_PASSWORD;

    if (!masterEmail || !masterPassword) {
      console.error(
        "❌ Variáveis MASTER_USER_EMAIL e MASTER_USER_INITIAL_PASSWORD devem estar definidas",
      );

      process.exit(1);
    }

    // Validate if the email is not in use
    const existingUser = await database.user.findUnique({
      where: { email: masterEmail },
    });

    if (existingUser) {
      console.error(`❌ Email ${masterEmail} já está em uso por outro usuário`);
      process.exit(1);
    }

    // Password hash
    const hashedPassword = await hash(masterPassword, 6);

    // Create master user
    const masterUser = await database.user.create({
      data: {
        name: "Administrador Master",
        email: masterEmail,
        password: hashedPassword,
        role: "MASTER",
        email_verified: new Date(),
      },
    });

    console.log("🎉 Usuário master criado com sucesso!");
    console.log(`📧 Email: ${masterUser.email}`);

    console.log("🔒 Senha: [DEFINIDA VIA VARIÁVEL DE AMBIENTE]");
    console.log("\n⚠️  IMPORTANTE: Altere a senha após o primeiro login!");
  } catch (error) {
    console.error("\n❌ Erro ao executar seed:", error);
    process.exit(1);
  } finally {
    await database.$disconnect();
  }
}

seed();

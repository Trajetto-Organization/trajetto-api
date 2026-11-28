import { randomBytes } from "node:crypto";

import { hash } from "bcrypt";

import { createPrismaClient } from "@/shared/database/database-client";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";

import { simulatedCnpj } from "./documents";

/**
 * The only rows the simulation writes straight into the database: what has
 * no public flow for a company's own people.
 *
 * - the company itself (a MASTER creates it in the back office), with the
 *   default occurrence types its creation seeds (business-repository.ts);
 * - its modules, FLEET and DELIVERIES (the MASTER's plan switches);
 * - its administrator, whose login the dispatcher and the recorder use.
 *
 * Everything else — settings, catalogues, drivers, vehicles, deliveries,
 * routes — goes through the HTTP API, as the web does it.
 */
interface SeededCompany {
  businessId: string;
  businessName: string;
  adminEmail: string;
  adminPassword: string;
}

const COMPANY = {
  corporate_reason: "Rota Paulista Simulação Logística LTDA",
  fantasy_name: "Rota Paulista (simulação)",
  cep: "05311000",
  city: "São Paulo",
  uf: "SP",
  street: "Avenida Mofarrej",
  address_number: "1200",
  cnae: "4930202",
  responsible_name: "Responsável da Simulação",
  telephone: "11900000000",
  email: "contato@simulacao.invalid",
  timezone: "America/Sao_Paulo",
};

const ADMIN_EMAIL = "despacho@simulacao.invalid";

async function seedCompany(): Promise<SeededCompany> {
  const prisma = createPrismaClient();
  const cnpj = simulatedCnpj(1);

  try {
    const existing = await prisma.business.findFirst({
      where: { OR: [{ cnpj }, { corporate_reason: COMPANY.corporate_reason }] },
      select: { id: true },
    });

    if (existing) {
      throw new Error(
        "A empresa simulada já existe neste banco. Rode `npx tsx tests/simulation/scripts/prepare-database.ts` para começar do zero.",
      );
    }

    // Random per run and written only to the run's context file (gitignored).
    const adminPassword = `Sim-${randomBytes(9).toString("base64url")}`;
    const passwordHash = await hash(adminPassword, 10);

    const businessId = await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          ...COMPANY,
          cnpj,
          vehicle_limit: 20,
          entitlements: {
            create: [
              { module: "FLEET", enabled: true },
              { module: "DELIVERIES", enabled: true },
            ],
          },
        },
        select: { id: true },
      });

      // What the company's creation seeds with it (decisions 14.3 and 14.4).
      await ensureDefaultOccurrenceTypes(tx, business.id);

      await tx.user.create({
        data: {
          name: "Débora Despacho",
          email: ADMIN_EMAIL,
          password: passwordHash,
          role: "BUSINESS_ADMIN",
          businessId: business.id,
          email_verified: new Date(),
        },
      });

      return business.id;
    });

    return {
      businessId,
      businessName: COMPANY.fantasy_name,
      adminEmail: ADMIN_EMAIL,
      adminPassword,
    };
  } finally {
    await prisma.$disconnect();
  }
}

export { seedCompany };
export type { SeededCompany };

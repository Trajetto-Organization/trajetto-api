import * as XLSX from "xlsx";
import { ViolationGravity } from "@prisma/client";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import database from "../database";

interface ViolationData {
  code: string;
  subCode: number;
  description: string;
  legalBasis: string;
  violatorType: string;
  gravity: string;
  competentAgency: string;
}

class ImportViolationCodesService {
  /**
   * Maps file severity to database enum
   */
  private mapGravityToEnum(gravity: string): ViolationGravity {
    const normalizedGravity = gravity.trim().toLowerCase();

    if (normalizedGravity.includes("leve")) return ViolationGravity.LIGHT;
    if (
      normalizedGravity.includes("média") ||
      normalizedGravity.includes("media")
    )
      return ViolationGravity.MEDIUM;
    if (
      normalizedGravity.includes("grave") &&
      !normalizedGravity.includes("gravíss")
    )
      return ViolationGravity.SERIOUS;
    if (
      normalizedGravity.includes("gravíss") ||
      normalizedGravity.includes("graviss")
    )
      return ViolationGravity.VERY_SERIOUS;

    return ViolationGravity.NO_POINTS;
  }

  /**
   * Maps severity to points on the driver's license
   */
  private mapGravityToPoints(gravity: string): number {
    const normalizedGravity = gravity.trim().toLowerCase();

    if (normalizedGravity.includes("leve")) return 3;
    if (
      normalizedGravity.includes("média") ||
      normalizedGravity.includes("media")
    )
      return 4;
    if (
      normalizedGravity.includes("grave") &&
      !normalizedGravity.includes("gravíss")
    )
      return 5;
    if (
      normalizedGravity.includes("gravíss") ||
      normalizedGravity.includes("graviss")
    )
      return 7;

    return 0;
  }

  /**
   * Reads and processes the Excel file
   */
  private readExcelFile(filePath: string): ViolationData[] {
    try {
      console.log(`📖 Lendo arquivo Excel: ${filePath}`);

      if (!existsSync(filePath)) {
        throw new Error(`Arquivo Excel não encontrado: ${filePath}`);
      }

      const fileBuffer = readFileSync(filePath);
      const workbook = XLSX.read(fileBuffer, {
        cellStyles: true,
        cellFormula: true,
        cellDates: true,
        cellNF: true,
        sheetStubs: true,
      });

      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      // Convert to JSON, ignoring the first line (header)
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      const dataRows = rawData.slice(1) as any[];

      console.log(`📊 Total de linhas encontradas: ${dataRows.length}`);

      const violationData: ViolationData[] = [];

      dataRows.forEach((row, index) => {
        try {
          // Validate if the line has essential data
          if (!row[0] || !row[2]) {
            console.warn(
              `⚠️  Linha ${index + 2} ignorada - dados insuficientes`,
            );
            return;
          }

          const violation: ViolationData = {
            code: String(row[0]).trim(),
            subCode: Number(row[1]) || 0,
            description: String(row[2]).trim(),
            legalBasis: String(row[3] || "").trim(),
            violatorType: String(row[4] || "").trim(),
            gravity: String(row[5] || "---").trim(),
            competentAgency: String(row[6] || "").trim(),
          };

          violationData.push(violation);
        } catch (error) {
          console.error(`❌ Erro ao processar linha ${index + 2}:`, error);
        }
      });

      console.log(`✅ Processadas ${violationData.length} infrações válidas`);
      return violationData;
    } catch (error) {
      console.error("❌ Erro ao ler arquivo Excel:", error);
      throw error;
    }
  }

  /**
   * Imports data into the database
   */
  async importToDatatabase(violationData: ViolationData[]): Promise<void> {
    console.log("💾 Iniciando importação para o banco de dados...");

    try {
      // ✅ CHECK EQUAL TO SEED.TS - Checks if data already exists
      const existingCount = await database.trafficViolationCode.count();
      if (existingCount > 0) {
        console.log(
          "✅ Banco de dados já possui códigos de infração. Seed abortado.",
        );
        return;
      }

      // Prepare data for batch insertion
      const dataToInsert = violationData.map((violation) => ({
        code: violation.code,
        sub_code: violation.subCode,
        description: violation.description,
        legal_basis: violation.legalBasis,
        violator_type: violation.violatorType,
        gravity: this.mapGravityToEnum(violation.gravity),
        gravity_raw: violation.gravity,
        points: this.mapGravityToPoints(violation.gravity),
        competent_agency: violation.competentAgency,
      }));

      // Insert in batches for better performance
      const batchSize = 50;
      let insertedCount = 0;

      for (let i = 0; i < dataToInsert.length; i += batchSize) {
        const batch = dataToInsert.slice(i, i + batchSize);

        try {
          await database.trafficViolationCode.createMany({
            data: batch,
            skipDuplicates: true,
          });

          insertedCount += batch.length;
          console.log(
            `📦 Lote ${Math.ceil((i + 1) / batchSize)} importado (${insertedCount}/${dataToInsert.length})`,
          );
        } catch (error) {
          console.error(
            `❌ Erro no lote ${Math.ceil((i + 1) / batchSize)}:`,
            error,
          );
        }
      }

      console.log(
        `🎉 Importação concluída! ${insertedCount} códigos de infração importados`,
      );

      // Statistics
      const stats = await this.getImportStats();
      console.log("\n📊 Estatísticas da importação:");
      console.log(`Total de códigos: ${stats.total}`);
      console.log(`Infrações leves: ${stats.light}`);
      console.log(`Infrações médias: ${stats.medium}`);
      console.log(`Infrações graves: ${stats.serious}`);
      console.log(`Infrações gravíssimas: ${stats.verySerious}`);
      console.log(`Sem pontuação: ${stats.noPoints}`);
    } catch (error) {
      console.error("❌ Erro durante a importação:", error);
      throw error;
    }
  }

  /**
   * Get statistics from imported data
   */
  private async getImportStats() {
    const [total, light, medium, serious, verySerious, noPoints] =
      await Promise.all([
        database.trafficViolationCode.count(),
        database.trafficViolationCode.count({
          where: { gravity: ViolationGravity.LIGHT },
        }),
        database.trafficViolationCode.count({
          where: { gravity: ViolationGravity.MEDIUM },
        }),
        database.trafficViolationCode.count({
          where: { gravity: ViolationGravity.SERIOUS },
        }),
        database.trafficViolationCode.count({
          where: { gravity: ViolationGravity.VERY_SERIOUS },
        }),
        database.trafficViolationCode.count({
          where: { gravity: ViolationGravity.NO_POINTS },
        }),
      ]);

    return { total, light, medium, serious, verySerious, noPoints };
  }

  /**
   * Performs the entire import process
   */
  async execute(excelFilePath: string): Promise<void> {
    console.log("🚀 Iniciando importação dos códigos de infrações...\n");

    try {
      // Check connection to the bank
      await database.$queryRaw`SELECT 1`;
      console.log("✅ Conexão com banco de dados estabelecida\n");

      // ✅ MORE ROBUST FILE VERIFICATION
      if (!existsSync(excelFilePath)) {
        console.log("⚠️  Arquivo Excel de infrações não encontrado.");
        console.log("   A importação de códigos de infração será pulada.");
        console.log(
          "   Para importar, certifique-se de que o arquivo existe em:",
        );
        console.log(`   ${excelFilePath}`);
        return;
      }

      // ✅ CHECKING IF DATA ALREADY EXISTS BEFORE READING THE FILE
      const existingCount = await database.trafficViolationCode.count();
      if (existingCount > 0) {
        console.log(
          "✅ Banco de dados já possui códigos de infração. Seed abortado.",
        );
        return;
      }

      // Read Excel file
      const violationData = this.readExcelFile(excelFilePath);

      // Import to the bank
      await this.importToDatatabase(violationData);
      console.log("\n🎯 Importação finalizada com sucesso!");
    } catch (error) {
      console.error("\n💥 Erro durante a importação:", error);
      throw error;
    } finally {
      await database.$disconnect();
    }
  }
}

// Main script
async function main() {
  const importer = new ImportViolationCodesService();

  // Path to Excel file (adjust as needed)
  const excelFilePath = resolve(
    process.cwd(),
    "tabela-codigo-infracoes-renainf-xlsx.xlsx",
  );

  await importer.execute(excelFilePath);
}

// Run only if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("💥 Erro fatal:", error);
    process.exit(1);
  });
}

export { ImportViolationCodesService };

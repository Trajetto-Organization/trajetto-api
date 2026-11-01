import ExcelJS from "exceljs"; // If you get an error, try: import * as ExcelJS from "exceljs";
import { ViolationGravity } from "@prisma/client";

import { existsSync } from "node:fs";
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

class ImportViolationCodes {
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
   * Helper to safely extract text from an ExcelJS cell
   */
  private getCellText(cell: ExcelJS.Cell | undefined): string {
    if (!cell) return "";
    const v = cell.value;
    if (v == null) return "";
    // if it's a rich object (e.g. {text: 'x'}), date, or formula result, try to convert
    if (typeof v === "object") {
      // ExcelJS richer types: { text: '...' } or Date objects
      if ("text" in v && typeof (v as any).text === "string")
        return (v as any).text.trim();

      if (v instanceof Date) return v.toISOString();
      if ("richText" in v)
        return (v as any).richText
          .map((r: any) => r.text)
          .join("")
          .trim();

      // fallback: JSON stringify then toString
      return String(v).trim();
    }
    return String(v).trim();
  }

  /**
   * Reads and processes the Excel file using exceljs (async)
   */
  private async readExcelFile(filePath: string): Promise<ViolationData[]> {
    try {
      console.log(`📖 Lendo arquivo Excel (exceljs): ${filePath}`);

      if (!existsSync(filePath)) {
        throw new Error(`Arquivo Excel não encontrado: ${filePath}`);
      }

      const workbook = new ExcelJS.Workbook();
      // leitura assíncrona do arquivo
      await workbook.xlsx.readFile(filePath);

      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        console.warn("⚠️  Nenhuma planilha encontrada no arquivo.");
        return [];
      }

      const violationData: ViolationData[] = [];
      let rowIndex = 0;

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        rowIndex = rowNumber;
        // pula cabeçalho (assumindo que cabeçalho é a primeira linha)
        if (rowNumber === 1) return;

        try {
          const codeText = this.getCellText(row.getCell(1));
          const descriptionText = this.getCellText(row.getCell(3));

          // valida campos essenciais
          if (!codeText || !descriptionText) {
            console.warn(
              `⚠️  Linha ${rowNumber} ignorada - dados insuficientes`,
            );
            return;
          }

          const violation: ViolationData = {
            code: codeText,
            subCode: Number(this.getCellText(row.getCell(2))) || 0,
            description: descriptionText,
            legalBasis: this.getCellText(row.getCell(4)) || "",
            violatorType: this.getCellText(row.getCell(5)) || "",
            gravity: this.getCellText(row.getCell(6)) || "---",
            competentAgency: this.getCellText(row.getCell(7)) || "",
          };

          violationData.push(violation);
        } catch (error) {
          console.error(`❌ Erro ao processar linha ${rowNumber}:`, error);
        }
      });

      console.log(`✅ Processadas ${violationData.length} infrações válidas`);
      return violationData;
    } catch (error) {
      console.error("❌ Erro ao ler arquivo Excel:", error);
      throw error;
    }
  }

  async importToDatatabase(violationData: ViolationData[]): Promise<void> {
    console.log("💾 Iniciando importação para o banco de dados...");

    try {
      const existingCount = await database.trafficViolationCode.count();
      if (existingCount > 0) {
        console.log(
          "✅ Banco de dados já possui códigos de infração. Seed abortado.",
        );
        return;
      }

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

      const batchSize = 50;
      let insertedCount = 0;

      // All or nothing. The release step runs this strictly (a failure fails
      // the step), and the check above skips any table that has a row: a
      // batch lost midway, logged and skipped, left the table short for
      // good while the step reported success. In one transaction a failure
      // leaves the table empty, the step fails, and the next run fills it.
      await database.$transaction(
        async (tx) => {
          for (let i = 0; i < dataToInsert.length; i += batchSize) {
            const batch = dataToInsert.slice(i, i + batchSize);

            await tx.trafficViolationCode.createMany({
              data: batch,
              skipDuplicates: true,
            });

            insertedCount += batch.length;
            console.log(
              `📦 Lote ${Math.ceil((i + 1) / batchSize)} importado (${insertedCount}/${dataToInsert.length})`,
            );
          }
        },
        // The client's 15 s budget is for requests; the whole table, here.
        { timeout: 120_000 },
      );

      console.log(
        `🎉 Importação concluída! ${insertedCount} códigos de infração importados`,
      );

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
      await database.$queryRaw`SELECT 1`;
      console.log("✅ Conexão com banco de dados estabelecida\n");

      if (!existsSync(excelFilePath)) {
        console.log("⚠️  Arquivo Excel de infrações não encontrado.");
        console.log("   A importação de códigos de infração será pulada.");
        console.log(
          "   Para importar, certifique-se de que o arquivo existe em:",
        );
        console.log(`   ${excelFilePath}`);
        return;
      }

      const existingCount = await database.trafficViolationCode.count();
      if (existingCount > 0) {
        console.log(
          "✅ Banco de dados já possui códigos de infração. Seed abortado.",
        );
        return;
      }

      // note o await aqui (readExcelFile agora é async)
      const violationData = await this.readExcelFile(excelFilePath);

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

async function main() {
  const importer = new ImportViolationCodes();

  const excelFilePath = resolve(
    process.cwd(),
    "tabela-codigo-infracoes-renainf-xlsx.xlsx",
  );

  await importer.execute(excelFilePath);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("💥 Erro fatal:", error);
    process.exit(1);
  });
}

export { ImportViolationCodes };

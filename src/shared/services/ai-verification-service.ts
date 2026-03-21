import { env } from "@/env";
import database from "@/../infra/database";

import Anthropic from "@anthropic-ai/sdk";
import AWS from "aws-sdk";

import fs from "node:fs";
import path from "node:path";

const ODOMETER_MISMATCH_THRESHOLD_KM = 50;
const ODOMETER_MISMATCH_THRESHOLD_PERCENT = 0.05;

interface OdometerAnalysisResult {
  readMileage: number | null;
  confidence: number;
  status: "verified" | "mismatch" | "fraud" | "unreadable" | "error";
  details: string;
  rawResponse: any;
}

interface ChecklistFieldAnalysisResult {
  fieldName: string;
  status: "confirmed" | "contradicts" | "inconclusive";
  confidence: number;
  observation: string;
  rawResponse: any;
}

interface BusinessLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
}

// Field-specific prompt builders
const CHECKLIST_FIELD_PROMPTS: Record<string, (fieldValue: any) => string> = {
  current_mileage: (reportedKm: any) =>
    `Analise esta foto do odômetro de um veículo. O motorista informou a quilometragem de ${reportedKm} km.
    Extraia o valor numérico exibido no odômetro e compare com o valor informado.
    Responda APENAS em JSON: { "valor_lido": number | null, "confianca": 0-100, "corresponde": boolean, "legivel": boolean, "observacao": string }`,

  tires_condition: (condition: any) =>
    `Analise esta foto de pneu de veículo. O motorista classificou a condição como "${condition}".
    Avalie: desgaste da banda de rodagem, danos visíveis (cortes, bolhas, desgaste irregular), calibragem aparente.
    Responda APENAS em JSON: { "condicao_observada": "good" | "bad" | "needs_attention", "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,

  fuel_level_adequate: (adequate: any) =>
    `Analise esta foto do painel/marcador de combustível de um veículo. O motorista informou que o nível de combustível ${adequate ? "está adequado" : "NÃO está adequado"}.
    Leia o marcador de combustível e estime o nível.
    Responda APENAS em JSON: { "nivel_estimado": "cheio" | "tres_quartos" | "metade" | "um_quarto" | "reserva" | "ilegivel", "adequado": boolean, "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,

  // Generic prompt for other fields
  _default: (fieldValue: any) =>
    `Analise esta foto de um item de checklist veicular. O motorista informou a condição como "${fieldValue}".
    Avalie visualmente se a foto corresponde à condição informada. Verifique se há danos, problemas ou irregularidades visíveis.
    Responda APENAS em JSON: { "condicao_observada": string, "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,
};

// Service
class AIVerificationService {
  private client: Anthropic | null = null;
  private s3: AWS.S3 | null = null;

  private prisma = database;

  constructor() {
    const apiKey = env.ANTHROPIC_API_KEY;

    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }

    // Initialize S3 client for R2 if configured
    if (env.UPLOAD_STORAGE_TYPE === "r2" && env.R2_ACCOUNT_ID) {
      this.s3 = new AWS.S3({
        accessKeyId: env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        region: "auto",
        signatureVersion: "v4",
      });
    }
  }

  public isAvailable(): boolean {
    return this.client !== null;
  }

  // Image Fetching
  async fetchImageAsBase64(filePath: string): Promise<{
    base64: string;
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  }> {
    let buffer: Buffer;
    if (this.s3 && env.UPLOAD_STORAGE_TYPE === "r2") {
      // Fetch from R2
      const result = await this.s3
        .getObject({
          Bucket: env.R2_BUCKET_NAME || "",
          Key: filePath,
        })
        .promise();

      buffer = result.Body as Buffer;
    } else {
      // Fetch from local filesystem
      const localPath = env.UPLOAD_LOCAL_PATH;
      const fullPath = path.join(path.resolve(localPath), filePath);

      buffer = await fs.promises.readFile(fullPath);
    }

    // Determine media type from file extension
    const ext = path.extname(filePath).toLowerCase();
    const mediaTypeMap: Record<
      string,
      "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    > = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };

    return {
      base64: buffer.toString("base64"),
      mediaType: mediaTypeMap[ext] || "image/webp",
    };
  }

  // Odometer Analysis
  async analyzeOdometerImage(
    imagePath: string,
    reportedMileage: number,
  ): Promise<OdometerAnalysisResult> {
    if (!this.client) {
      return {
        readMileage: null,
        confidence: 0,
        status: "error",
        details: "AI service not configured (missing ANTHROPIC_API_KEY)",
        rawResponse: null,
      };
    }

    try {
      const { base64, mediaType } = await this.fetchImageAsBase64(imagePath);
      const response = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: `Analise esta foto de odômetro de veículo. O motorista informou a quilometragem de ${reportedMileage} km.
                Extraia o valor numérico exibido no odômetro. Considere:
                  1. Se é odômetro digital ou analógico
                  2. Se a imagem está legível e clara
                  3. Se há sinais de adulteração ou fraude (foto de tela, edição, outro veículo)
                  4. Compare o valor lido com o informado (${reportedMileage} km)

                  Responda APENAS em JSON válido, sem markdown:
                  { "valor_lido": number | null, "confianca": 0-100, "legivel": boolean, "sinais_fraude": boolean, "motivos_fraude": string[], "observacao": string }`,
              },
            ],
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === "text");
      const rawText = textContent?.type === "text" ? textContent.text : "";

      // Parse JSON response
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          readMileage: null,
          confidence: 0,
          status: "error",
          details: "Failed to parse AI response",
          rawResponse: rawText,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Determine status
      if (!parsed.legivel || parsed.valor_lido === null) {
        return {
          readMileage: null,
          confidence: parsed.confianca || 0,
          status: "unreadable",
          details: parsed.observacao || "Odômetro ilegível na imagem",
          rawResponse: parsed,
        };
      }

      if (parsed.sinais_fraude) {
        return {
          readMileage: parsed.valor_lido,
          confidence: parsed.confianca,
          status: "fraud",
          details: `Suspeita de fraude: ${(parsed.motivos_fraude || []).join(", ")}. ${parsed.observacao || ""}`,
          rawResponse: parsed,
        };
      }

      // Compare values
      const diff = Math.abs(parsed.valor_lido - reportedMileage);
      const percentDiff = reportedMileage > 0 ? diff / reportedMileage : diff;

      if (
        diff > ODOMETER_MISMATCH_THRESHOLD_KM &&
        percentDiff > ODOMETER_MISMATCH_THRESHOLD_PERCENT
      ) {
        return {
          readMileage: parsed.valor_lido,
          confidence: parsed.confianca,
          status: "mismatch",
          details: `Divergência: IA leu ${parsed.valor_lido} km, informado ${reportedMileage} km (diferença de ${diff.toFixed(0)} km). ${parsed.observacao || ""}`,
          rawResponse: parsed,
        };
      }

      return {
        readMileage: parsed.valor_lido,
        confidence: parsed.confianca,
        status: "verified",
        details: `Verificado: ${parsed.valor_lido} km (informado: ${reportedMileage} km). ${parsed.observacao || ""}`,
        rawResponse: parsed,
      };
    } catch (error) {
      console.error("[AIVerification] Error analyzing odometer:", error);
      return {
        readMileage: null,
        confidence: 0,
        status: "error",
        details:
          "Não foi possível realizar a verificação IA. Tente novamente mais tarde.",
        rawResponse: null,
      };
    }
  }

  // Checklist Image Analysis
  async analyzeChecklistImage(
    imagePath: string,
    fieldName: string,
    fieldValue: any,
  ): Promise<ChecklistFieldAnalysisResult> {
    if (!this.client) {
      return {
        fieldName,
        status: "inconclusive",
        confidence: 0,
        observation: "AI service not configured",
        rawResponse: null,
      };
    }

    try {
      const { base64, mediaType } = await this.fetchImageAsBase64(imagePath);

      // Get field-specific prompt
      const promptBuilder =
        CHECKLIST_FIELD_PROMPTS[fieldName] || CHECKLIST_FIELD_PROMPTS._default;
      const prompt = promptBuilder(fieldValue);

      const response = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === "text");
      const rawText = textContent?.type === "text" ? textContent.text : "";

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          fieldName,
          status: "inconclusive",
          confidence: 0,
          observation: "Failed to parse AI response",
          rawResponse: rawText,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Determine status based on response
      const matches =
        parsed.corresponde_ao_informado ?? parsed.corresponde ?? true;

      return {
        fieldName,
        status: matches ? "confirmed" : "contradicts",
        confidence: parsed.confianca || 0,
        observation: parsed.observacao || "",
        rawResponse: parsed,
      };
    } catch (error) {
      console.error(
        `[AIVerification] Error analyzing checklist field ${fieldName}:`,
        error,
      );

      return {
        fieldName,
        status: "inconclusive",
        confidence: 0,
        observation:
          "Não foi possível realizar a verificação IA. Tente novamente mais tarde.",
        rawResponse: null,
      };
    }
  }

  // ─── Business Limit Management ─────────────────────────────────
  async checkBusinessLimit(businessId: string): Promise<BusinessLimitResult> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        ai_analysis_limit: true,
        ai_analysis_used: true,
        ai_analysis_reset_at: true,
      },
    });

    if (!business) {
      return { allowed: false, remaining: 0, limit: 0, used: 0 };
    }

    // Fallback: monthly reset if the cron job (reset-ai-usage-job) has not executed
    const now = new Date();
    const resetAt = new Date(business.ai_analysis_reset_at);

    if (
      now.getMonth() !== resetAt.getMonth() ||
      now.getFullYear() !== resetAt.getFullYear()
    ) {
      await this.prisma.business.update({
        where: { id: businessId },
        data: {
          ai_analysis_used: 0,
          ai_analysis_reset_at: now,
        },
      });

      return {
        allowed: business.ai_analysis_limit > 0,
        remaining: business.ai_analysis_limit,
        limit: business.ai_analysis_limit,
        used: 0,
      };
    }

    // 0 means disabled (no AI for this company)
    if (business.ai_analysis_limit === 0) {
      return {
        allowed: false,
        remaining: 0,
        limit: 0,
        used: business.ai_analysis_used,
      };
    }

    const remaining = business.ai_analysis_limit - business.ai_analysis_used;
    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
      limit: business.ai_analysis_limit,
      used: business.ai_analysis_used,
    };
  }

  async incrementBusinessUsage(
    businessId: string,
    count: number = 1,
  ): Promise<void> {
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        ai_analysis_used: { increment: count },
      },
    });
  }
}

export {
  AIVerificationService,
  OdometerAnalysisResult,
  ChecklistFieldAnalysisResult,
  BusinessLimitResult,
};

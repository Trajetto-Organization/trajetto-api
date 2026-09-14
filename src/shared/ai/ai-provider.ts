import { env } from "@/env";

import Anthropic from "@anthropic-ai/sdk";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import fs from "node:fs";
import path from "node:path";

import {
  ChecklistProviderResponse,
  OdometerProviderResponse,
} from "./ai-rules";
import { ProviderCallUsage } from "./ai-types";

const PROVIDER_NAME = "anthropic";
const VISION_MODEL = "claude-haiku-4-5-20251001";

/**
 * HTTP status of a provider API error, or undefined for anything else
 * (network failures, parse errors). The pipeline uses it to decide whether a
 * retry can possibly help: an invalid key returns 401 on every attempt, so
 * waiting through the whole backoff schedule just delays the inevitable.
 */
function providerErrorStatus(error: unknown): number | undefined {
  return error instanceof Anthropic.APIError ? error.status : undefined;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface ProviderCall<TParsed> {
  parsed: TParsed;
  usage: ProviderCallUsage;
}

// Field-specific prompt builders (checklist)
const CHECKLIST_FIELD_PROMPTS: Record<string, (fieldValue: unknown) => string> =
  {
    current_mileage: (reportedKm) =>
      `Analise esta foto do odômetro de um veículo. O motorista informou a quilometragem de ${reportedKm} km.
    Extraia o valor numérico exibido no odômetro e compare com o valor informado.
    Responda APENAS em JSON: { "valor_lido": number | null, "confianca": 0-100, "corresponde": boolean, "legivel": boolean, "observacao": string }`,

    tires_condition: (condition) =>
      `Analise esta foto de pneu de veículo. O motorista classificou a condição como "${condition}".
    Avalie: desgaste da banda de rodagem, danos visíveis (cortes, bolhas, desgaste irregular), calibragem aparente.
    Responda APENAS em JSON: { "condicao_observada": "good" | "bad" | "needs_attention", "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,

    fuel_level_adequate: (adequate) =>
      `Analise esta foto do painel/marcador de combustível de um veículo. O motorista informou que o nível de combustível ${adequate ? "está adequado" : "NÃO está adequado"}.
    Leia o marcador de combustível e estime o nível.
    Responda APENAS em JSON: { "nivel_estimado": "cheio" | "tres_quartos" | "metade" | "um_quarto" | "reserva" | "ilegivel", "adequado": boolean, "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,

    _default: (fieldValue) =>
      `Analise esta foto de um item de checklist veicular. O motorista informou a condição como "${fieldValue}".
    Avalie visualmente se a foto corresponde à condição informada. Verifique se há danos, problemas ou irregularidades visíveis.
    Responda APENAS em JSON: { "condicao_observada": string, "corresponde_ao_informado": boolean, "confianca": 0-100, "observacao": string }`,
  };

/**
 * The raw provider boundary: fetches the photo, calls the vision model and
 * returns the parsed JSON plus token usage for the attempt trail. Transport
 * and parse failures THROW — the pipeline records the failed attempt and
 * retries with backoff, unlike the legacy service which swallowed them into
 * a fake "error" result and charged nothing while never retrying.
 */
class AIAnalysisProvider {
  private client: Anthropic | null = null;
  private s3: S3Client | null = null;

  constructor() {
    if (env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }

    if (env.UPLOAD_STORAGE_TYPE === "r2" && env.R2_ACCOUNT_ID) {
      this.s3 = new S3Client({
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID || "",
          secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
        },
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        region: "auto",
      });
    }
  }

  public isAvailable(): boolean {
    return this.client !== null;
  }

  public async analyzeOdometerImage(
    imagePath: string,
    reportedMileage: number,
  ): Promise<ProviderCall<OdometerProviderResponse>> {
    const prompt = `Analise esta foto de odômetro de veículo. O motorista informou a quilometragem de ${reportedMileage} km.
                Extraia o valor numérico exibido no odômetro. Considere:
                  1. Se é odômetro digital ou analógico
                  2. Se a imagem está legível e clara
                  3. Se há sinais de adulteração ou fraude (foto de tela, edição, outro veículo)
                  4. Compare o valor lido com o informado (${reportedMileage} km)

                  Responda APENAS em JSON válido, sem markdown:
                  { "valor_lido": number | null, "confianca": 0-100, "legivel": boolean, "sinais_fraude": boolean, "motivos_fraude": string[], "observacao": string }`;

    return this.callVisionModel<OdometerProviderResponse>(imagePath, prompt);
  }

  public async analyzeChecklistImage(
    imagePath: string,
    fieldName: string,
    fieldValue: unknown,
  ): Promise<ProviderCall<ChecklistProviderResponse>> {
    const promptBuilder =
      CHECKLIST_FIELD_PROMPTS[fieldName] || CHECKLIST_FIELD_PROMPTS._default;

    return this.callVisionModel<ChecklistProviderResponse>(
      imagePath,
      promptBuilder(fieldValue),
    );
  }

  private async callVisionModel<TParsed>(
    imagePath: string,
    prompt: string,
  ): Promise<ProviderCall<TParsed>> {
    if (!this.client) {
      throw new Error("AI provider not configured (missing ANTHROPIC_API_KEY)");
    }

    const { base64, mediaType } = await this.fetchImageAsBase64(imagePath);
    const startedAt = Date.now();

    const response = await this.client.messages.create({
      model: VISION_MODEL,
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

    const usage: ProviderCallUsage = {
      provider: PROVIDER_NAME,
      model: VISION_MODEL,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      durationMs: Date.now() - startedAt,
    };

    const textContent = response.content.find(
      (content) => content.type === "text",
    );
    const rawText = textContent?.type === "text" ? textContent.text : "";

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error(
        `Model response contained no JSON (${usage.model}): ${rawText.slice(0, 200)}`,
      );
    }

    return { parsed: JSON.parse(jsonMatch[0]) as TParsed, usage };
  }

  private async fetchImageAsBase64(filePath: string): Promise<{
    base64: string;
    mediaType: ImageMediaType;
  }> {
    let buffer: Buffer;

    if (this.s3 && env.UPLOAD_STORAGE_TYPE === "r2") {
      const result = await this.s3.send(
        new GetObjectCommand({
          Bucket: env.R2_BUCKET_NAME || "",
          Key: filePath,
        }),
      );

      // In SDK v3 the Body is a stream; `transformToByteArray` materializes it.
      const bytes = await result.Body!.transformToByteArray();
      buffer = Buffer.from(bytes);
    } else {
      const localPath = env.UPLOAD_LOCAL_PATH;
      const fullPath = path.join(path.resolve(localPath), filePath);

      buffer = await fs.promises.readFile(fullPath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mediaTypeMap: Record<string, ImageMediaType> = {
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
}

export { AIAnalysisProvider, PROVIDER_NAME, VISION_MODEL, providerErrorStatus };
export type { ProviderCall };

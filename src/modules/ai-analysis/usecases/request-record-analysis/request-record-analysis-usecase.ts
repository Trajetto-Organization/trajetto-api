import { injectable } from "tsyringe";

import database from "@/../infra/database";

import { AppError } from "@/shared/errors/AppError";

import {
  AIAnalysisService,
  readerSupports,
} from "@/shared/ai/ai-analysis-service";
import { checklistReadingKind } from "@/shared/ai/ai-rules";
import { refreshChecklistVerdict } from "@/shared/ai/ai-record-store";
import { AIAnalysisRequestInput } from "@/shared/ai/ai-types";

import {
  findRecordInScope,
  type AIRecordPrincipal,
  type AIRecordType,
} from "../shared/ai-record-access";

interface RequestRecordAnalysisRequest {
  principal: AIRecordPrincipal;
  recordType: AIRecordType;
  recordId: string;
}

interface RequestRecordAnalysisResponse {
  outcome: "queued" | "already_running" | "already_completed";
  message: string;
}

const MESSAGES: Record<RequestRecordAnalysisResponse["outcome"], string> = {
  queued: "Verificação IA iniciada.",
  already_running: "A verificação IA já está em andamento.",
  already_completed:
    "Estas fotos já foram verificadas — o resultado está registrado.",
};

/**
 * Every photo left is of an item the automatic reading does not cover (ADR
 * 0010: fuel level, tyres, "working" items). Said as such — the old 503
 * "não configurada" blamed the server for a product decision.
 */
const NOT_COVERED_MESSAGE =
  "Os itens com foto deste checklist não têm leitura automática. Confira as fotos.";

/** Nothing new to read, but an informed value changed since the reading. */
const RECOMPARED_MESSAGE =
  "Estas fotos já foram verificadas. O resultado foi comparado de novo com os valores atuais do checklist, sem nova cobrança.";

/**
 * The "verificar com IA" button: requests (or re-requests) the AI analysis of
 * an existing fuel/checklist record. Covers records that predate the quota
 * (created while the limit was 0), quota-denied skips and failed runs — the
 * idempotent request layer revives the terminal request without re-billing
 * units that already produced a result.
 *
 * Deliberately manual: enabling AI for a company must not stampede-consume
 * the fresh quota over every historical record.
 */
@injectable()
class RequestRecordAnalysisUseCase {
  async execute({
    principal,
    recordType,
    recordId,
  }: RequestRecordAnalysisRequest): Promise<RequestRecordAnalysisResponse> {
    // The company scope comes BEFORE any other refusal: "this fuelling has no
    // photo" (400) against "not found" (404) told a caller holding another
    // company's id whether the record exists.
    const record = await findRecordInScope(principal, recordType, recordId);

    const business = await database.business.findUnique({
      where: { id: record.businessId },
      select: { ai_analysis_limit: true },
    });

    if (!business || business.ai_analysis_limit === 0) {
      throw new AppError(
        "A verificação IA não está habilitada para esta empresa.",
        409,
        "AI_NOT_ENABLED",
      );
    }

    const input = await this.buildInput(recordType, record.id, principal.id);

    if (input === "already_completed" && recordType === "checklist") {
      // Every photo was read: the button still re-compares the paid readings
      // with the values the checklist holds now, free — an informed value
      // corrected after the AI flagged it no longer keeps "Não confere".
      const refreshed = await refreshChecklistVerdict(record.id);

      return {
        outcome: input,
        message: refreshed?.written ? RECOMPARED_MESSAGE : MESSAGES[input],
      };
    }

    if (input === "already_completed" || input === "already_running") {
      return { outcome: input, message: MESSAGES[input] };
    }

    if (input === "not_covered") {
      throw new AppError(NOT_COVERED_MESSAGE, 409, "AI_NOT_COVERED");
    }

    const outcome = await AIAnalysisService.getInstance().requestAnalysis(input);

    if (outcome === "not_covered") {
      throw new AppError(NOT_COVERED_MESSAGE, 409, "AI_NOT_COVERED");
    }

    if (outcome === "denied") {
      throw new AppError(
        "Limite de análises do período atingido.",
        409,
        "AI_QUOTA_EXHAUSTED",
      );
    }

    if (outcome === "unavailable") {
      throw new AppError(
        "A verificação IA não está configurada no servidor.",
        503,
        "AI_PROVIDER_UNAVAILABLE",
      );
    }

    return { outcome, message: MESSAGES[outcome] };
  }

  /**
   * The request the record asks for now — or why there is none: every photo
   * was already read, or the ones left are being read right now.
   */
  private async buildInput(
    recordType: AIRecordType,
    recordId: string,
    requestedById: string,
  ): Promise<
    | AIAnalysisRequestInput
    | "already_completed"
    | "already_running"
    | "not_covered"
  > {
    if (recordType === "fuel") {
      const fuel = await database.fuel.findUniqueOrThrow({
        where: { id: recordId },
        select: {
          id: true,
          businessId: true,
          odometer_photo: true,
          current_mileage: true,
        },
      });

      if (!fuel.odometer_photo) {
        throw new AppError(
          "Este abastecimento não tem foto do odômetro para verificar.",
          400,
          "AI_RECORD_WITHOUT_PHOTO",
        );
      }

      // Photo + mileage is the whole input, so the same fuelling asked twice
      // is the same request: already done, or revived if it failed.
      return {
        type: "FUEL_ODOMETER",
        recordId: fuel.id,
        businessId: fuel.businessId,
        requestedById,
        input: {
          odometerPhotoPath: fuel.odometer_photo,
          reportedMileage: fuel.current_mileage,
        },
      };
    }

    const checklist = await database.vehicleChecklist.findUniqueOrThrow({
      where: { id: recordId },
    });

    const photosByField =
      (checklist.photos_by_field as Record<string, string[]> | null) ?? {};

    if (Object.keys(photosByField).length === 0) {
      throw new AppError(
        "Este checklist não tem fotos anexadas para verificar.",
        400,
        "AI_RECORD_WITHOUT_PHOTO",
      );
    }

    // Only the photos never read and not being read (AI-2). The button used
    // to send every photo of the checklist, and after an update that re-read
    // one field the whole checklist was a new input — every photo paid for
    // again.
    const { pending, inFlight, read } = await this.unreadPhotos(
      recordId,
      checklist.businessId,
      photosByField,
    );

    // Only what the reader reads is worth a request: a tyre photo stays
    // "unread" forever under OCR, and must not make the button promise a
    // reading (ADR 0010 §5).
    const covered = Object.fromEntries(
      Object.entries(pending).filter(([field]) =>
        readerSupports(
          checklistReadingKind(field, (checklist as Record<string, unknown>)[field]),
        ),
      ),
    );

    if (Object.keys(covered).length === 0) {
      if (inFlight) return "already_running";

      // Something was read: the free re-comparison still applies.
      if (read || Object.keys(pending).length === 0) return "already_completed";

      return "not_covered";
    }

    return {
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: checklist.businessId,
      requestedById,
      input: {
        photosByField: covered,
        // The service keeps only the photographed fields' values.
        checklistData: checklist as unknown as Record<string, unknown>,
      },
    };
  }

  /**
   * The fields whose current photo no request of this record has read, nor
   * holds a reservation to read right now.
   *
   * A photo reserved by a request still PENDING or PROCESSING counted as
   * unread: after an update queued the new photo of one field, the button
   * opened an overlapping request with a different key and paid for that
   * photo twice — for as long as the first one waited (a backlog, a paused
   * provider).
   */
  private async unreadPhotos(
    recordId: string,
    businessId: string,
    photosByField: Record<string, string[]>,
  ): Promise<{
    pending: Record<string, string[]>;
    inFlight: boolean;
    read: boolean;
  }> {
    const taken = await database.$queryRaw<
      Array<{ unitKey: string; photo: string | null; consumed: boolean }>
    >`
      SELECT u."unitKey",
             r."input"->'photosByField'->u."unitKey"->>0 AS "photo",
             (u."status" = 'CONSUMED') AS "consumed"
      FROM "ai_analysis_request" r
      JOIN "ai_analysis_unit" u ON u."requestId" = r."id"
      WHERE r."type" = 'CHECKLIST'
        AND r."recordId" = ${recordId}
        AND r."businessId" = ${businessId}
        AND (
          u."status" = 'CONSUMED'
          OR (u."status" = 'RESERVED' AND r."status" IN ('PENDING', 'PROCESSING'))
        )
    `;

    const keyOf = (field: string, photo: string | null | undefined) =>
      `${field}\u0000${photo}`;

    const read = new Set(
      taken.filter((row) => row.consumed).map((row) => keyOf(row.unitKey, row.photo)),
    );
    const reading = new Set(
      taken.filter((row) => !row.consumed).map((row) => keyOf(row.unitKey, row.photo)),
    );

    let inFlight = false;

    const pending = Object.fromEntries(
      Object.entries(photosByField).filter(([field, photos]) => {
        if (!Array.isArray(photos) || photos.length === 0) return false;

        const key = keyOf(field, photos[0]);

        if (read.has(key)) return false;

        if (reading.has(key)) {
          inFlight = true;
          return false;
        }

        return true;
      }),
    );

    return { pending, inFlight, read: read.size > 0 };
  }
}

export { RequestRecordAnalysisUseCase };
export type { RequestRecordAnalysisResponse };

import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { AppError } from "@/shared/errors/AppError";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import type {
  OccurrenceFeedCategory,
  OccurrenceSeverity,
} from "../list-occurrences/occurrence-feed";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { formatInstant } from "@/shared/vehicle/record-dates";
import { labelledAnswers } from "../authorize-occurrence/authorization-notice";

/** The tower's decision as the spreadsheet reads it (decision 6.3). */
const AUTHORIZATION_LABEL: Record<string, string> = {
  NOT_REQUIRED: "Não exigida",
  PENDING: "Aguardando a torre",
  APPROVED: "Autorizada",
  DENIED: "Negada",
  SUPERSEDED: "Encerrada sem decisão",
};

/** "Rótulo: valor; Rótulo: valor", in the form's order (decision 6.2). */
function answersCell(value: unknown): string {
  const { fields, answers } = (value ?? {}) as { fields?: unknown; answers?: unknown };

  return labelledAnswers(fields, answers)
    .map(({ label, value: answer }) => `${label}: ${answer}`)
    .join("; ") || "N/A";
}

interface ExportOccurrenceRequest {
  userId: string;
  businessId?: string;
  search?: string;
  severity?: OccurrenceSeverity[];
  category?: OccurrenceFeedCategory[];
  occurrenceTypeIds?: string[];
  deliveryStatuses?: DeliveryStatus[];
}

/**
 * Every occurrence of the operation, as a spreadsheet.
 *
 * The one export a manager actually sits down with: "quantas vezes o cliente
 * estava ausente neste mês, e em quais endereços". The typed occurrence and
 * whether it blocked the delivery are the two columns that answer it.
 */
@injectable()
class ExportOccurrenceUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    businessId,
    search,
    severity,
    category,
    occurrenceTypeIds,
    deliveryStatuses,
  }: ExportOccurrenceRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    // The feed's filters (decision 5.8): the ids copied from the row menu,
    // the type, the severity and the delivery status, as on screen.
    const iterator = this.delivery.streamOccurrencesForExport({
      businessId: resolvedBusinessId,
      driverId: findUser.driverId ?? undefined,
      search,
      severity,
      category,
      occurrenceTypeIds,
      deliveryStatuses,
    });

    // The company's zone (decision 1.1): the day in the file name and the
    // hour in "Data", which the server's zone (UTC) put a day ahead from
    // 21:00 in São Paulo.
    const findBusiness = await this.business.findBusinessById(resolvedBusinessId);
    const timeZone = resolveTimeZone(
      (findBusiness as { timezone?: string | null } | null)?.timezone,
    );

    const columns: ExportColumn[] = [
      { header: "ID", key: "id", width: 38, formatter: ExportFormatters.fallback },
      { header: "Data", key: "created_at", width: 20, formatter: (value) => formatInstant(value, timeZone) },
      { header: "Tipo", key: "typeName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Categoria", key: "category", width: 14, formatter: ExportFormatters.fallback },
      { header: "Impeditiva", key: "blocking", width: 12, formatter: ExportFormatters.fallback },
      { header: "Entrega", key: "deliveryId", width: 38, formatter: ExportFormatters.fallback },
      { header: "Destinatário", key: "recipientName", width: 32, formatter: ExportFormatters.fallback },
      { header: "Cidade", key: "city", width: 24, formatter: ExportFormatters.fallback },
      { header: "UF", key: "uf", width: 6, formatter: ExportFormatters.fallback },
      { header: "Registrada por", key: "reporterName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Relato", key: "description", width: 48, formatter: ExportFormatters.fallback },
      { header: "Fotos", key: "photoCount", width: 8, formatter: ExportFormatters.fallback },
      { header: "Respostas do formulário", key: "formAnswers", width: 48, formatter: answersCell },
      {
        header: "Autorização",
        key: "authorizationStatus",
        width: 22,
        formatter: (value) => AUTHORIZATION_LABEL[String(value ?? "NOT_REQUIRED")] ?? String(value),
      },
      { header: "Decidida por", key: "deciderName", width: 28, formatter: ExportFormatters.fallback },
      {
        header: "Decidida em",
        key: "decidedAt",
        width: 20,
        formatter: (value) => formatInstant(value, timeZone),
      },
      { header: "Motivo da decisão", key: "decisionNote", width: 40, formatter: ExportFormatters.fallback },
    ];

    const today = businessDateKey(new Date(), timeZone);

    return { iterator, columns, filename: `ocorrencias-${today}` };
  }
}

export { ExportOccurrenceUseCase };

import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { AppError } from "@/shared/errors/AppError";

interface ExportOccurrenceRequest {
  userId: string;
  businessId?: string;
  search?: string;
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
  ) {}

  async execute({
    userId,
    businessId,
    search,
  }: ExportOccurrenceRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const iterator = this.delivery.streamOccurrencesForExport({
      businessId: resolvedBusinessId,
      driverId: findUser.driverId ?? undefined,
      search,
    });

    const columns: ExportColumn[] = [
      { header: "ID", key: "id", width: 38, formatter: ExportFormatters.fallback },
      { header: "Data", key: "created_at", width: 20, formatter: ExportFormatters.datetime },
      { header: "Tipo", key: "typeName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Impeditiva", key: "blocking", width: 12, formatter: ExportFormatters.fallback },
      { header: "Entrega", key: "deliveryId", width: 38, formatter: ExportFormatters.fallback },
      { header: "Destinatário", key: "recipientName", width: 32, formatter: ExportFormatters.fallback },
      { header: "Cidade", key: "city", width: 24, formatter: ExportFormatters.fallback },
      { header: "UF", key: "uf", width: 6, formatter: ExportFormatters.fallback },
      { header: "Registrada por", key: "reporterName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Relato", key: "description", width: 48, formatter: ExportFormatters.fallback },
      { header: "Fotos", key: "photoCount", width: 8, formatter: ExportFormatters.fallback },
    ];

    const today = new Date().toISOString().slice(0, 10);

    return { iterator, columns, filename: `ocorrencias-${today}` };
  }
}

export { ExportOccurrenceUseCase };

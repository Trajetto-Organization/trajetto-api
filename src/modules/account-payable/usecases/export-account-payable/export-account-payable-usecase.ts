import { inject, injectable } from "tsyringe";
import type { AccountPayableCategory } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { AppError } from "@/shared/errors/AppError";
import { ExportColumn } from "@/shared/services/export/types";

import type { SortOrder } from "@/shared/pagination/list-query";

import { resolveListScope } from "../list-account-payable/list-account-payable-usecase";
import type { AccountPayableSortKey } from "../list-account-payable/account-payable-list";

import {
  accountPayableSituation,
  type AccountPayableStatus,
  type AccountPayableStatusGroup,
  type BusinessClock,
} from "../../rules/account-payable-status";
import type { AccountPayable } from "../../dtos/account-payable-dto";

interface ExportAccountPayableRequest {
  userId: string;
  businessId?: string;
  search?: string;
  statusGroups?: AccountPayableStatusGroup[];
  categories?: AccountPayableCategory[];
  sort?: AccountPayableSortKey;
  order?: SortOrder;
}

const STATUS_LABELS: Record<AccountPayableStatus, string> = {
  PENDING: "Pendente",
  PARTIAL: "Parcial",
  OVERDUE: "Vencida",
  PARTIAL_LATE: "Parcial com atraso",
  PAID: "Paga",
  LATE: "Paga com atraso",
};

const CATEGORY_LABELS: Record<AccountPayableCategory, string> = {
  FUEL: "Combustível",
  MAINTENANCE: "Manutenção",
  INSURANCE: "Seguro",
  TAXES_FEES: "Impostos e taxas",
  FINES: "Multas",
  TOLLS: "Pedágio",
  RENTAL: "Locação",
  PAYROLL: "Folha de pagamento",
  OTHER: "Outros",
};

/** "YYYY-MM-DD" as the day it is, with no zone to shift it. */
function dayLabel(key: string | null): string {
  if (!key) return "N/A";

  const [year, month, day] = key.split("-");

  return `${day}/${month}/${year}`;
}

function money(value: unknown): string {
  if (value === null || value === undefined) return "N/A";

  return Number(String(value)).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

type Related = AccountPayable & {
  branch?: {
    corporate_reason?: string | null;
    fantasy_name?: string | null;
  } | null;
  supplier?: { name?: string | null } | null;
  vehicle?: { license_plate?: string | null } | null;
  registrationUser?: { name?: string | null } | null;
  createdBy?: { name?: string | null } | null;
};

function categoryLabel(bill: Related): string {
  if (!bill.category) return "N/A";

  if (bill.category === "OTHER" && bill.category_description) {
    return `${CATEGORY_LABELS.OTHER} (${bill.category_description})`;
  }

  return CATEGORY_LABELS[bill.category];
}

/** One file row: every value already a string, formatted in pt-BR. */
function exportRow(
  bill: Related,
  clock: BusinessClock,
): Record<string, string> {
  const situation = accountPayableSituation(bill, clock);

  return {
    id: bill.id,
    status: STATUS_LABELS[situation.status],
    category: categoryLabel(bill),
    payee: bill.supplier?.name ?? bill.payee_name ?? "N/A",
    description: bill.description ?? "N/A",
    document_number: bill.document_number ?? "N/A",
    vehicle: bill.vehicle?.license_plate ?? "N/A",
    branch: bill.branch?.fantasy_name || bill.branch?.corporate_reason || "N/A",
    responsible: bill.registrationUser?.name ?? "N/A",
    created_by: bill.createdBy?.name ?? "N/A",
    issue_date: new Intl.DateTimeFormat("pt-BR", {
      timeZone: clock.timeZone,
    }).format(new Date(bill.issue_date)),
    due_day: dayLabel(situation.due_day),
    payment_day: dayLabel(situation.payment_day),
    amount: money(bill.amount),
    amount_paid: money(bill.amount_paid),
    remaining_amount: money(situation.remaining_amount),
    service_order: bill.serviceOrderId ?? "N/A",
  };
}

const COLUMNS: ExportColumn[] = [
  { header: "ID", key: "id", width: 38 },
  { header: "Situação", key: "status", width: 20 },
  { header: "Categoria", key: "category", width: 22 },
  { header: "Favorecido", key: "payee", width: 30 },
  { header: "Descrição", key: "description", width: 40 },
  { header: "Nº do documento", key: "document_number", width: 20 },
  { header: "Veículo (centro de custo)", key: "vehicle", width: 18 },
  { header: "Filial", key: "branch", width: 28 },
  { header: "Responsável", key: "responsible", width: 25 },
  { header: "Registrada por", key: "created_by", width: 25 },
  { header: "Emissão", key: "issue_date", width: 12 },
  { header: "Vencimento", key: "due_day", width: 12 },
  { header: "Pagamento", key: "payment_day", width: 12 },
  { header: "Valor", key: "amount", width: 16 },
  { header: "Valor pago", key: "amount_paid", width: 16 },
  { header: "Restante", key: "remaining_amount", width: 16 },
  { header: "Ordem de serviço", key: "service_order", width: 38 },
];

/**
 * The accounts payable report: the rows of the list's own filter, search
 * and order (decision 5.8), with the same server-side status the screen
 * shows, the MASTER exporting the company it selected.
 */
@injectable()
class ExportAccountPayableUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
  ) {}

  async execute(request: ExportAccountPayableRequest): Promise<{
    iterator: AsyncGenerator<Record<string, string>>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const scope = await resolveListScope(
      this.user,
      this.business,
      request.userId,
      request.businessId,
    );

    const source = this.accountPayable.streamAccountPayablesForExport({
      businessId: scope.businessId,
      clock: scope.clock,
      search: request.search,
      statusGroups: request.statusGroups,
      categories: request.categories,
      sort: request.sort,
      order: request.order,
    });

    // Peek before the headers go out: an empty report is refused as JSON.
    const first = await source.next();

    if (first.done) {
      throw new AppError(
        "Nenhuma conta a pagar para exportar com esta busca e estes filtros.",
        400,
        "ACCOUNT_PAYABLE_NOTHING_TO_EXPORT",
      );
    }

    const clock = scope.clock;
    const firstBill = first.value as Related;

    async function* rows(): AsyncGenerator<Record<string, string>> {
      try {
        yield exportRow(firstBill, clock);

        for await (const bill of source) {
          yield exportRow(bill as Related, clock);
        }
      } finally {
        // The pipeline stops early when the client leaves: release the batch.
        await source.return(undefined);
      }
    }

    return {
      iterator: rows(),
      columns: COLUMNS,
      filename: `relatorio-contas-a-pagar-${clock.todayKey}`,
    };
  }
}

export { ExportAccountPayableUseCase, STATUS_LABELS, exportRow };

import { AccountPayableCategory } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/client";

import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  AccountPayableStatusGroup,
  BusinessClock,
} from "../rules/account-payable-status";
import type {
  AccountPayableSortKey,
  StatusGroupCounts,
} from "../usecases/list-account-payable/account-payable-list";

interface AccountPayable {
  id: string;
  issue_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: Decimal | string;
  amount_paid?: Decimal | string | null;
  category?: AccountPayableCategory | null;
  category_description?: string | null;
  businessId: string;
  branchId: string;
  serviceOrderId?: string | null;
  /** The responsible person (chosen in the form); a driver sees theirs. */
  registrationUserId: string;
  /** Decision 8.4: the payee is a registered supplier OR a free-text name. */
  supplierId?: string | null;
  payee_name?: string | null;
  /** Decision 8.4: the vehicle that carries the cost (cost centre). */
  vehicleId?: string | null;
  description?: string | null;
  document_number?: string | null;
  /** Who registered it; null for legacy rows and after that user is gone. */
  createdById?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The fields a form writes; shared by create and update. */
interface AccountPayableFields {
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: number;
  amount_paid?: number | null;
  category: AccountPayableCategory;
  category_description?: string | null;
  branchId: string;
  serviceOrderId?: string | null;
  registrationUserId: string;
  supplierId?: string | null;
  payee_name?: string | null;
  vehicleId?: string | null;
  description?: string | null;
  document_number?: string | null;
}

interface CreateAccountPayableProps extends AccountPayableFields {
  businessId: string;

  /** The session user; set by the use case, never read from the body. */
  createdById?: string | null;

  /** The web form's Idempotency-Key (IDEMP-14): the same key is one bill. */
  client_submission_id?: string | null;
}

/** `undefined` = not sent; `null` clears the column. */
type UpdateAccountPayableProps = {
  [K in keyof AccountPayableFields]?: AccountPayableFields[K] | null;
} & {
  issue_date?: Date | string;
};

interface UpdateAccountPayable {
  accountPayableData: UpdateAccountPayableProps;
  accountPayableId: string;
}

interface ListAccountPayablesProps {
  page: number;
  pageSize: number;
  businessId: string;
  /** "Today" in the company's zone: the line between open and overdue. */
  clock: BusinessClock;
  search?: string;
  statusGroups?: AccountPayableStatusGroup[];
  categories?: AccountPayableCategory[];
  sort?: AccountPayableSortKey;
  order?: SortOrder;
}

interface ListAccountPayablesResult {
  data: AccountPayable[];
  /** Per situation over the card base (every filter but the status one). */
  groups: StatusGroupCounts;
}

interface SearchAccountPayableWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  userId: string;
  search?: string;
}

interface CursorPaginatedAccountPayable {
  data: AccountPayable[];
  nextCursor: string | null;
  hasMore: boolean;
}

type ExportAccountPayablesProps = Omit<
  ListAccountPayablesProps,
  "page" | "pageSize"
>;

export {
  AccountPayable,
  AccountPayableFields,
  CreateAccountPayableProps,
  UpdateAccountPayableProps,
  UpdateAccountPayable,
  ListAccountPayablesProps,
  ListAccountPayablesResult,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  ExportAccountPayablesProps,
};

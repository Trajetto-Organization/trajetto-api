import { AccountPayableCategory } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

type AccountPayableStatus =
  | "PENDING"
  | "PAID"
  | "PARTIAL"
  | "LATE"
  | "PARTIAL_LATE"
  | "OVERDUE";

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
  registrationUserId: string;
  created_at: Date | string;
  updated_at: Date | string;
  branchName?: string;
  serviceOrderDescription?: string;
  registrationUserName?: string;
  status?: string;
  remainingAmount?: string;
}

interface CreateAccountPayableProps {
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: number;
  amount_paid?: number | null;
  category: AccountPayableCategory;
  category_description?: string | null;
  businessId: string;
  branchId: string;
  serviceOrderId?: string | null;
  registrationUserId: string;
}

interface UpdateAccountPayableProps {
  issue_date?: Date | string;
  due_date?: Date | string;
  payment_date?: Date | string | null;
  amount?: number;
  amount_paid?: number | null;
  category?: AccountPayableCategory;
  category_description?: string | null;
  branchId?: string | null;
  serviceOrderId?: string | null;
  registrationUserId?: string | null;
}

interface UpdateAccountPayable {
  accountPayableData: UpdateAccountPayableProps;
  accountPayableId: string;
}

interface ListAccountPayableProps {
  data: AccountPayable[];
  total: number;
}

interface ListAccountPayableByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole?: string;
  search?: string;
}

interface SearchAccountPayableWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  userId: string;
}

interface CursorPaginatedAccountPayable {
  data: AccountPayable[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  AccountPayable,
  CreateAccountPayableProps,
  UpdateAccountPayableProps,
  UpdateAccountPayable,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  AccountPayableStatus,
};

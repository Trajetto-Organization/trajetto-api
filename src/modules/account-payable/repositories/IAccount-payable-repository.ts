import { Prisma } from "@prisma/client";

import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayablesProps,
  ListAccountPayablesResult,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  UpdateAccountPayable,
  ExportAccountPayablesProps,
} from "../dtos/account-payable-dto";

interface IAccountPayableRepository {
  createAccountPayable: (
    accountPayableData: CreateAccountPayableProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<AccountPayable>;
  /** The bill a web submission already created, within this company. */
  findAccountPayableBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<AccountPayable | null>;
  /** One company's page, plus the per-situation totals of the cards. */
  listAccountPayables: (
    props: ListAccountPayablesProps,
  ) => Promise<ListAccountPayablesResult>;
  /** Every row of the list's filter, in the list's order, in batches. */
  streamAccountPayablesForExport: (
    props: ExportAccountPayablesProps,
  ) => AsyncGenerator<AccountPayable>;
  updateAccountPayable: (
    update: UpdateAccountPayable,
    tx?: Prisma.TransactionClient,
  ) => Promise<AccountPayable>;
  /**
   * Deletes a bill only while it is still unpaid.
   *
   * The `businessId` and the precondition travel in the same `where`: an
   * update may stamp the payment between reading `payment_date` and the
   * delete, and a settled financial record would vanish without a trace.
   */
  deleteAccountPayable: (
    accountPayableId: string,
    businessId: string,
  ) => Promise<AccountPayable>;
  findAccountPayableById: (
    accountPayableId: string,
  ) => Promise<AccountPayable | null>;
  findAccountPayablesByServiceOrderId: (
    serviceOrderId: string,
  ) => Promise<AccountPayable[] | null>;
  findAccountPayablesByRegistrationUserId: (
    registrationUserId: string,
  ) => Promise<AccountPayable[]>;
  /** Σ amount of the bills of a service order (FLEET-AP-5). */
  sumAmountByServiceOrderId: (serviceOrderId: string) => Promise<number>;
  searchAccountPayableByResponsibleUserWithCursor: (
    props: SearchAccountPayableWithCursorProps,
  ) => Promise<CursorPaginatedAccountPayable>;
}

export { IAccountPayableRepository };

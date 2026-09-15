import { Prisma } from "@prisma/client";

import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  UpdateAccountPayable,
} from "../dtos/account-payable-dto";

interface IAccountPayableRepository {
  createAccountPayable: (
    accountPayableData: CreateAccountPayableProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<AccountPayable>;
  listAccountPayables: (
    listAccountPayableProps: ListAccountPayableByBusinessIdProps,
  ) => Promise<ListAccountPayableProps>;
  updateAccountPayable: (
    update: UpdateAccountPayable,
    tx?: Prisma.TransactionClient,
  ) => Promise<AccountPayable>;
  /**
   * Apaga, mas só uma conta que continua em aberto.
   *
   * O `businessId` e a pré-condição vão juntos no mesmo `where`: entre ler
   * `payment_date` e apagar, a atualização carimba o pagamento — e um registro
   * financeiro liquidado desaparece sem deixar rastro.
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
  searchAccountPayableByResponsibleUserWithCursor: (
    props: SearchAccountPayableWithCursorProps,
  ) => Promise<CursorPaginatedAccountPayable>;
}

export { IAccountPayableRepository };

import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  UpdateAccountPayable,
} from "../dtos/account-payable-dto";

interface IAccountPayableRepository {
  createAccountPayable: (
    accountPayableData: CreateAccountPayableProps,
  ) => Promise<AccountPayable>;
  listAccountPayables: (
    listAccountPayableProps: ListAccountPayableByBusinessIdProps,
  ) => Promise<ListAccountPayableProps>;
  updateAccountPayable: ({
    accountPayableData,
    accountPayableId,
  }: UpdateAccountPayable) => Promise<AccountPayable>;
  deleteAccountPayable: (accountPayableId: string) => Promise<AccountPayable>;
  findAccountPayableById: (
    accountPayableId: string,
  ) => Promise<AccountPayable | null>;
  findAccountPayablesByServiceOrderId: (
    serviceOrderId: string,
  ) => Promise<AccountPayable[] | null>;
  findAccountPayablesByRegistrationUserId: (
    registrationUserId: string,
  ) => Promise<AccountPayable[]>;
}

export { IAccountPayableRepository };

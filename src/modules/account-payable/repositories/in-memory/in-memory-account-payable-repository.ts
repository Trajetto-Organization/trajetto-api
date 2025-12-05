import { v4 as uuidV4 } from "uuid";
import { IAccountPayableRepository } from "../IAccount-payable-repository";

import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  ListAccountPayableByResponsibleUserIdProps,
  UpdateAccountPayable,
} from "../../dtos/account-payable-dto";

class InMemoryAccountPayableRepository implements IAccountPayableRepository {
  public accountPayables: AccountPayable[] = [];

  async createAccountPayable(
    accountPayableData: CreateAccountPayableProps,
  ): Promise<AccountPayable> {
    const accountPayable: AccountPayable = {
      id: uuidV4(),
      issue_date: new Date(),
      due_date: accountPayableData.due_date,
      payment_date: accountPayableData.payment_date,
      amount: accountPayableData.amount.toString(),
      amount_paid: accountPayableData.amount_paid?.toString() || null,
      businessId: accountPayableData.businessId,
      branchId: accountPayableData.branchId,
      serviceOrderId: accountPayableData.serviceOrderId,
      registrationUserId: accountPayableData.registrationUserId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.accountPayables.push(accountPayable);
    return accountPayable;
  }

  async listAccountPayables(
    listAccountPayableProps: ListAccountPayableByBusinessIdProps,
  ): Promise<ListAccountPayableProps> {
    const { page, pageSize, businessId } = listAccountPayableProps;
    const filteredPayables = this.accountPayables.filter(
      (payable) => payable.businessId === businessId,
    );
    const skip = (page - 1) * pageSize;
    const slicedPayables = filteredPayables.slice(skip, skip + pageSize);

    return {
      data: slicedPayables,
      total: filteredPayables.length,
    };
  }

  async listAccountPayablesByResponsibleUserId({
    page,
    pageSize,
    responsibleUserId,
    businessId,
  }: ListAccountPayableByResponsibleUserIdProps): Promise<ListAccountPayableProps> {
    const filteredPayables = this.accountPayables.filter(
      (payable) =>
        payable.registrationUserId === responsibleUserId &&
        payable.businessId === businessId,
    );
    const skip = (page - 1) * pageSize;
    const slicedPayables = filteredPayables.slice(skip, skip + pageSize);

    return {
      data: slicedPayables,
      total: filteredPayables.length,
    };
  }

  async updateAccountPayable({
    accountPayableData,
    accountPayableId,
  }: UpdateAccountPayable): Promise<AccountPayable> {
    const index = this.accountPayables.findIndex(
      (payable) => payable.id === accountPayableId,
    );

    if (index === -1) {
      throw new Error("Account payable not found");
    }

    const updatedPayable: AccountPayable = {
      ...this.accountPayables[index],
      updated_at: new Date(),
    };

    // Update only fields that are provided and handle null types correctly
    if (accountPayableData.issue_date !== undefined) {
      updatedPayable.issue_date = accountPayableData.issue_date;
    }

    if (accountPayableData.due_date !== undefined) {
      updatedPayable.due_date = accountPayableData.due_date;
    }

    if (accountPayableData.payment_date !== undefined) {
      updatedPayable.payment_date = accountPayableData.payment_date;
    }

    if (accountPayableData.amount !== undefined) {
      updatedPayable.amount = accountPayableData.amount.toString();
    }

    if (accountPayableData.amount_paid !== undefined) {
      updatedPayable.amount_paid =
        accountPayableData.amount_paid?.toString() || null;
    }

    if (accountPayableData.branchId !== undefined) {
      updatedPayable.branchId = accountPayableData.branchId;
    }

    if (accountPayableData.serviceOrderId !== undefined) {
      updatedPayable.serviceOrderId = accountPayableData.serviceOrderId;
    }

    if (
      accountPayableData.registrationUserId !== undefined &&
      accountPayableData.registrationUserId !== null
    ) {
      updatedPayable.registrationUserId = accountPayableData.registrationUserId;
    }

    this.accountPayables[index] = updatedPayable;
    return this.accountPayables[index];
  }

  async deleteAccountPayable(
    accountPayableId: string,
  ): Promise<AccountPayable> {
    const index = this.accountPayables.findIndex(
      (payable) => payable.id === accountPayableId,
    );

    if (index === -1) {
      throw new Error("Account payable not found");
    }

    const deletedPayable = this.accountPayables[index];

    this.accountPayables.splice(index, 1);
    return deletedPayable;
  }

  async findAccountPayableById(
    accountPayableId: string,
  ): Promise<AccountPayable | null> {
    const accountPayable = this.accountPayables.find(
      (payable) => payable.id === accountPayableId,
    );
    return accountPayable || null;
  }

  async findAccountPayablesByServiceOrderId(
    serviceOrderId: string,
  ): Promise<AccountPayable[] | null> {
    const payables = this.accountPayables.filter(
      (payable) => payable.serviceOrderId === serviceOrderId,
    );
    return payables.length > 0 ? payables : null;
  }

  async findAccountPayablesByRegistrationUserId(
    registrationUserId: string,
  ): Promise<AccountPayable[]> {
    return this.accountPayables.filter(
      (payable) => payable.registrationUserId === registrationUserId,
    );
  }
}

export { InMemoryAccountPayableRepository };

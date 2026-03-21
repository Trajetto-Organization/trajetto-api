import { IAccountPayableRepository } from "./IAccount-payable-repository";
import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  SearchAccountPayableWithCursorProps,
  CursorPaginatedAccountPayable,
  UpdateAccountPayable,
} from "../dtos/account-payable-dto";

import database from "@/../infra/database";

class AccountPayableRepository implements IAccountPayableRepository {
  constructor(private prisma = database) {}

  async createAccountPayable(
    accountPayableData: CreateAccountPayableProps,
  ): Promise<AccountPayable> {
    const accountPayableCreated = await this.prisma.accountPayable.create({
      data: {
        due_date: accountPayableData.due_date,
        payment_date: accountPayableData.payment_date,
        amount: accountPayableData.amount,
        amount_paid: accountPayableData.amount_paid,
        business: {
          connect: {
            id: accountPayableData.businessId,
          },
        },
        branch: {
          connect: {
            id: accountPayableData.branchId,
          },
        },
        ...(accountPayableData.serviceOrderId && {
          serviceOrder: {
            connect: {
              id: accountPayableData.serviceOrderId,
            },
          },
        }),
        registrationUser: {
          connect: {
            id: accountPayableData.registrationUserId,
          },
        },
      },
      include: {
        branch: true,
        serviceOrder: true,
        registrationUser: true,
      },
    });

    return accountPayableCreated;
  }

  async listAccountPayables({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListAccountPayableByBusinessIdProps): Promise<ListAccountPayableProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      const isValidNumericSearch = (search: string): boolean => {
        if (!search) return false;
        if (!/^\d+(\.\d+)?$/.test(search)) return false;

        const parsed = parseFloat(search);
        return !isNaN(parsed) && isFinite(parsed);
      };

      const numericSearch = isValidNumericSearch(normalizedSearch);

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        {
          registrationUser: {
            OR: [
              {
                id: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                name: { contains: normalizedSearch, mode: "insensitive" },
              },
            ],
          },
        },
        {
          branch: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                corporate_reason: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                fantasy_name: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
        {
          serviceOrder: {
            id: { contains: normalizedSearch, mode: "insensitive" },
          },
        },
        // Business ID and name (MASTER only)
        ...(currentUserRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
        ...(numericSearch
          ? [
              { amount: parseFloat(normalizedSearch) },
              { amount_paid: parseFloat(normalizedSearch) },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [accountPayableData, total] = await Promise.all([
      this.prisma.accountPayable.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          business: {
            select: {
              corporate_reason: true,
            },
          },
          branch: {
            select: {
              corporate_reason: true,
              fantasy_name: true,
            },
          },
          serviceOrder: {
            select: {
              id: true,
              date: true,
              maintenance_type: true,
              vehicle: {
                select: {
                  license_plate: true,
                  description: true,
                },
              },
            },
          },
          registrationUser: {
            select: {
              name: true,
            },
          },
        },
        orderBy: {
          created_at: "desc", // Sort by created_at, closest first
        },
      }),
      this.prisma.accountPayable.count({
        where: whereCondition,
      }),
    ]);

    return { data: accountPayableData, total };
  }

  async updateAccountPayable({
    accountPayableData,
    accountPayableId,
  }: UpdateAccountPayable): Promise<AccountPayable> {
    const filteredData = Object.fromEntries(
      Object.entries(accountPayableData).filter(
        ([_, value]) => value !== undefined,
      ),
    );

    const updateAccountPayable = await this.prisma.accountPayable.update({
      where: {
        id: accountPayableId,
      },
      data: filteredData,
      include: {
        branch: true,
        serviceOrder: true,
        registrationUser: true,
      },
    });

    return updateAccountPayable;
  }

  async deleteAccountPayable(
    accountPayableId: string,
  ): Promise<AccountPayable> {
    const deleteAccountPayable = await this.prisma.accountPayable.delete({
      where: {
        id: accountPayableId,
      },
    });

    return deleteAccountPayable;
  }

  async findAccountPayableById(
    accountPayableId: string,
  ): Promise<AccountPayable | null> {
    const findAccountPayableById = await this.prisma.accountPayable.findUnique({
      where: {
        id: accountPayableId,
      },
      include: {
        branch: true,
        serviceOrder: true,
        registrationUser: true,
      },
    });

    return findAccountPayableById;
  }

  async findAccountPayablesByServiceOrderId(
    serviceOrderId: string,
  ): Promise<AccountPayable[] | null> {
    const findAccountPayablesByServiceOrderId =
      await this.prisma.accountPayable.findMany({
        where: {
          serviceOrderId: serviceOrderId,
        },
      });

    return findAccountPayablesByServiceOrderId;
  }

  async findAccountPayablesByRegistrationUserId(
    registrationUserId: string,
  ): Promise<AccountPayable[]> {
    const accountPayables = await this.prisma.accountPayable.findMany({
      where: { registrationUserId },
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        serviceOrder: {
          select: {
            id: true,
            date: true,
            vehicle: { select: { license_plate: true } },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    return accountPayables;
  }

  async searchAccountPayableByResponsibleUserWithCursor({
    limit = 10,
    cursor,
    businessId,
    userId,
  }: SearchAccountPayableWithCursorProps): Promise<CursorPaginatedAccountPayable> {
    const items = await this.prisma.accountPayable.findMany({
      where: {
        registrationUserId: userId,
        businessId,
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        serviceOrder: {
          select: {
            id: true,
            date: true,
            maintenance_type: true,
            vehicle: {
              select: {
                license_plate: true,
                description: true,
              },
            },
          },
        },
        registrationUser: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { AccountPayableRepository };

import { IAccountPayableRepository } from "./IAccount-payable-repository";
import {
  AccountPayable,
  CreateAccountPayableProps,
  ListAccountPayableProps,
  ListAccountPayableByBusinessIdProps,
  UpdateAccountPayable,
  AccountPayableStatus,
} from "../dtos/account-payable-dto";

import database from "@/../infra/database";
import {
  formatDate,
  formatCurrency,
  formatNotificationDate,
  translateAccountPayableStatus,
} from "@/config/format-values";

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
            id: accountPayableData.registrationUserId || "",
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
        ...(numericSearch
          ? [
              { amount: parseFloat(normalizedSearch) },
              { amount_paid: parseFloat(normalizedSearch) },
            ]
          : []),
      );
      orConditions.push({
        branch: {
          OR: [
            {
              corporate_reason: {
                contains: normalizedSearch,
                mode: "insensitive",
              },
            },
            {
              fantasy_name: { contains: normalizedSearch, mode: "insensitive" },
            },
          ],
        },
      });
      orConditions.push({
        registrationUser: {
          name: { contains: normalizedSearch, mode: "insensitive" },
        },
      });
      orConditions.push({
        serviceOrder: {
          id: { contains: normalizedSearch, mode: "insensitive" },
        },
      });
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const accountPayableData = await this.prisma.accountPayable.findMany({
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
        due_date: "asc", // Sort by due date, closest first
      },
    });

    const total = await this.prisma.accountPayable.count({
      where: whereCondition,
    });

    const transformedAccountPayableData = accountPayableData.map(
      (accountPayable) => {
        // Determine account status based on existing fields
        let status: AccountPayableStatus = "PENDING";
        let remainingAmount = Number(accountPayable.amount);

        const currentDate = new Date();
        const dueDate = new Date(accountPayable.due_date);

        const isOverdue = currentDate > dueDate;

        if (accountPayable.payment_date) {
          const amountPaid = Number(accountPayable.amount_paid || 0);
          remainingAmount = Number(accountPayable.amount) - amountPaid;

          // Convert dates for comparison
          const paymentDate = new Date(accountPayable.payment_date);

          // Checks if payment was made after the due date
          const isPaidLate = paymentDate > dueDate;

          if (amountPaid >= Number(accountPayable.amount)) {
            // Full payment
            if (isPaidLate) {
              status = "LATE"; // Pay late
            } else {
              status = "PAID"; // Paid on time
            }
            remainingAmount = 0;
          } else if (amountPaid > 0) {
            // Partial payment
            if (isPaidLate) {
              status = "PARTIAL_LATE"; // Partially paid late
            } else if (isOverdue) {
              // Paid before the due date, but not yet paid in full and the due date is past
              status = "PARTIAL_LATE"; // Partial and expired
            } else {
              status = "PARTIAL"; // Partial on time
            }
          }
        } else {
          // No payment date - check if it is overdue
          if (isOverdue) {
            status = "OVERDUE"; // Overdue and unpaid
          } else {
            status = "PENDING"; // Pending deadline
          }
        }

        const formatServiceOrderDisplay = (serviceOrder: any) => {
          // Format the date in a readable way
          const formattedDate =
            formatDate(serviceOrder.date, "pt-BR") || serviceOrder.date;

          // Get vehicle info if available
          const vehicleInfo = serviceOrder.vehicle.license_plate
            ? `(Veículo: ${serviceOrder.vehicle.description || ""} - Placa: ${serviceOrder.vehicle.license_plate})`
            : "";

          // Combine ID and date for a unique display
          return `OS#${serviceOrder.id.substring(0, 8)} - ${formattedDate} ${vehicleInfo}`;
        };

        return {
          id: accountPayable.id ?? "N/A",
          issue_date:
            formatNotificationDate(accountPayable.issue_date, "pt-BR") ?? "N/A",
          due_date: accountPayable.due_date ?? "N/A",
          payment_date: accountPayable.payment_date ?? null,
          amount: formatCurrency(Number(accountPayable.amount)) ?? "N/A",
          amount_paid: accountPayable.amount_paid
            ? formatCurrency(Number(accountPayable.amount_paid))
            : null,
          businessId: accountPayable.businessId ?? "N/A",
          branchId: accountPayable.branchId ?? "N/A",
          ...(currentUserRole === "MASTER"
            ? {
                business_name:
                  accountPayable.business.corporate_reason ?? "N/A",
              }
            : {}),
          branchName: accountPayable.branch?.corporate_reason || "N/A",
          serviceOrderId: accountPayable.serviceOrderId ?? null,
          serviceOrderDescription: accountPayable.serviceOrder
            ? formatServiceOrderDisplay(accountPayable.serviceOrder)
            : "N/A",
          registrationUserId: accountPayable.registrationUserId ?? "N/A",
          registrationUserName: accountPayable.registrationUser?.name ?? "N/A",
          status: translateAccountPayableStatus(status),
          remainingAmount: formatCurrency(remainingAmount) ?? "N/A",
          created_at: formatDate(accountPayable.created_at, "pt-BR") ?? "N/A",
          updated_at: formatDate(accountPayable.updated_at, "pt-BR") ?? "N/A",
        };
      },
    );

    return { data: transformedAccountPayableData, total };
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
      orderBy: { issue_date: "desc" },
    });

    return accountPayables;
  }
}

export { AccountPayableRepository };

import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  CursorPaginatedServiceOrder,
  SearchServiceOrderByVehicleWithCursorProps,
} from "../dtos/service-order-dto";

import { Prisma } from "@prisma/client";

interface IServiceOrderRepository {
  createServiceOrder: (
    serviceOrderData: CreateServiceOrderProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<ServiceOrder>;
  listServiceOrders: (
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ) => Promise<ListServiceOrderProps>;
  updateServiceOrder: (
    update: UpdateServiceOrder,
    tx?: Prisma.TransactionClient,
  ) => Promise<ServiceOrder>;
  deleteServiceOrder: (serviceOrderId: string) => Promise<ServiceOrder>;
  findServiceOrderById: (
    serviceOrderId: string,
  ) => Promise<ServiceOrder | null>;
  findServiceOrdersByVehicleId: (
    vehicleId: string,
  ) => Promise<ServiceOrder[] | null>;
  findServiceOrdersByResponsibleUserId: (
    responsibleUserId: string,
  ) => Promise<ServiceOrder[]>;
  streamServiceOrdersForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => AsyncGenerator<any>;
  searchServiceOrderWithCursor: (
    props: SearchServiceOrderWithCursorProps,
  ) => Promise<CursorPaginatedServiceOrder>;
  searchServiceOrderByVehicleWithCursor: (
    props: SearchServiceOrderByVehicleWithCursorProps,
  ) => Promise<CursorPaginatedServiceOrder>;
  countServiceOrderForExport: (
    businessId: string,
    userRole: string,
  ) => Promise<number>;
}

export { IServiceOrderRepository };

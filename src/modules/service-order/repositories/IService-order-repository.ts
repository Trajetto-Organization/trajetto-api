import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  CursorPaginatedServiceOrder,
  SearchServiceOrderByVehicleWithCursorProps,
  ServiceOrderListQuery,
  DeleteServiceOrderResult,
  ServiceOrderDetail,
  SearchDriverServiceOrdersProps,
  CursorPaginatedServiceOrderDetail,
} from "../dtos/service-order-dto";

import { Prisma } from "@prisma/client";

interface IServiceOrderRepository {
  createServiceOrder: (
    serviceOrderData: CreateServiceOrderProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<ServiceOrder>;
  /** The order a web submission already created, within this company. */
  findServiceOrderBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<ServiceOrder | null>;
  /**
   * One page of a company's orders with the counts behind the cards and
   * the filter options (decision 8.8). Always scoped to one company.
   */
  listServiceOrders: (
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ) => Promise<ListServiceOrderProps>;
  updateServiceOrder: (
    update: UpdateServiceOrder,
    tx?: Prisma.TransactionClient,
  ) => Promise<ServiceOrder>;
  /**
   * Deletes the order unless it is finished or a bill points at it
   * (FLEET-SO-1). The check and the delete happen under a lock on the order,
   * so a bill linked in between is either seen or refused by its foreign key.
   */
  deleteServiceOrderGuarded: (
    serviceOrderId: string,
    businessId: string,
  ) => Promise<DeleteServiceOrderResult>;
  findServiceOrderById: (
    serviceOrderId: string,
  ) => Promise<ServiceOrder | null>;
  findServiceOrdersByVehicleId: (
    vehicleId: string,
  ) => Promise<ServiceOrder[] | null>;
  findServiceOrdersByResponsibleUserId: (
    responsibleUserId: string,
  ) => Promise<ServiceOrder[]>;
  /** The same rows the listing shows (decision 5.8), in id order. */
  streamServiceOrdersForExport: (
    query: ServiceOrderListQuery,
  ) => AsyncGenerator<any>;
  searchServiceOrderWithCursor: (
    props: SearchServiceOrderWithCursorProps,
  ) => Promise<CursorPaginatedServiceOrder>;
  searchServiceOrderByVehicleWithCursor: (
    props: SearchServiceOrderByVehicleWithCursorProps,
  ) => Promise<CursorPaginatedServiceOrder>;
  countServiceOrderForExport: (query: ServiceOrderListQuery) => Promise<number>;
  /**
   * One order with its links and parts, inside this company only: another
   * company's id answers null, like one that exists nowhere (wave 3).
   */
  findServiceOrderDetail: (
    serviceOrderId: string,
    businessId: string,
  ) => Promise<ServiceOrderDetail | null>;
  /**
   * "Minhas OS" (wave 3), newest first by cursor: the caller's orders
   * (`assigned`, by the responsibleUserId index) or the orders of the given
   * vehicles that are not the caller's (`vehicle`, by the vehicleId index).
   */
  searchServiceOrdersOfDriverWithCursor: (
    props: SearchDriverServiceOrdersProps,
  ) => Promise<CursorPaginatedServiceOrderDetail>;
}

export { IServiceOrderRepository };

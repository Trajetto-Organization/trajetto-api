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

interface IServiceOrderRepository {
  createServiceOrder: (
    serviceOrderData: CreateServiceOrderProps,
  ) => Promise<ServiceOrder>;
  listServiceOrders: (
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ) => Promise<ListServiceOrderProps>;
  updateServiceOrder: ({
    serviceOrderData,
    serviceOrderId,
  }: UpdateServiceOrder) => Promise<ServiceOrder>;
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

import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  ListServiceOrderBusinessProps,
} from "../dtos/service-order-dto";

interface IServiceOrderRepository {
  createServiceOrder: (
    serviceOrderData: CreateServiceOrderProps,
  ) => Promise<ServiceOrder>;
  listServiceOrders: (
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ) => Promise<ListServiceOrderProps>;
  listServiceOrderBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListServiceOrderBusinessProps) => Promise<ListServiceOrderProps>;
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
}

export { IServiceOrderRepository };

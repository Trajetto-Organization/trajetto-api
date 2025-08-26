import { v4 as uuidV4 } from "uuid";
import { IServiceOrderRepository } from "../IService-order-repository";

import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  ListServiceOrderBusinessProps,
} from "../../dtos/service-order-dto";

class InMemoryServiceOrderRepository implements IServiceOrderRepository {
  public serviceOrders: ServiceOrder[] = [];

  async createServiceOrder(
    serviceOrderData: CreateServiceOrderProps,
  ): Promise<ServiceOrder> {
    const serviceOrder: ServiceOrder = {
      id: uuidV4(),
      date: serviceOrderData.date,
      completion_date: serviceOrderData.completion_date,
      maintenance_type: serviceOrderData.maintenance_type,
      total_amount: serviceOrderData.total_amount.toString(),
      businessId: serviceOrderData.businessId,
      vehicleId: serviceOrderData.vehicleId,
      responsibleUserId: serviceOrderData.responsibleUserId,
      branchId: serviceOrderData.branchId,
      supplierId: serviceOrderData.supplierId,
      current_mileage_at_service: serviceOrderData.current_mileage_at_service,
      maintenance_interval_km_at_service:
        serviceOrderData.maintenance_interval_km_at_service,
      last_maintenance_mileage_at_service:
        serviceOrderData.last_maintenance_mileage_at_service,
      new_mileage_after_service: serviceOrderData.new_mileage_after_service,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.serviceOrders.push(serviceOrder);
    return serviceOrder;
  }

  async listServiceOrders(
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ): Promise<ListServiceOrderProps> {
    const { page, pageSize, businessId } = listServiceOrderProps;
    const filteredOrders = this.serviceOrders.filter(
      (order) => order.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;
    const slicedOrders = filteredOrders.slice(skip, skip + pageSize);

    return {
      data: slicedOrders,
      total: filteredOrders.length,
    };
  }

  async listServiceOrderBusiness({
    page,
    pageSize,
    businessId,
  }: ListServiceOrderBusinessProps): Promise<ListServiceOrderProps> {
    const filteredOrders = this.serviceOrders.filter(
      (order) => order.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;
    const slicedOrders = filteredOrders.slice(skip, skip + pageSize);

    return {
      data: slicedOrders,
      total: filteredOrders.length,
    };
  }

  async updateServiceOrder({
    serviceOrderData,
    serviceOrderId,
  }: UpdateServiceOrder): Promise<ServiceOrder> {
    const index = this.serviceOrders.findIndex(
      (order) => order.id === serviceOrderId,
    );

    if (index === -1) {
      throw new Error("Service order not found");
    }

    const updatedOrder: ServiceOrder = {
      ...this.serviceOrders[index],
      updated_at: new Date(),
    };

    // Only update fields that exist in UpdateServiceOrderProps
    if (serviceOrderData.date !== undefined) {
      updatedOrder.date = serviceOrderData.date as string | Date;
    }

    if (serviceOrderData.completion_date !== undefined) {
      updatedOrder.completion_date = serviceOrderData.completion_date;
    }

    if (serviceOrderData.maintenance_type !== undefined) {
      updatedOrder.maintenance_type = serviceOrderData.maintenance_type;
    }

    if (serviceOrderData.total_amount !== undefined) {
      updatedOrder.total_amount = serviceOrderData.total_amount.toString();
    }

    if (serviceOrderData.new_mileage_after_service !== undefined) {
      updatedOrder.new_mileage_after_service =
        serviceOrderData.new_mileage_after_service;
    }

    if (serviceOrderData.vehicleId !== undefined) {
      updatedOrder.vehicleId = serviceOrderData.vehicleId;
    }

    if (serviceOrderData.responsibleUserId !== undefined) {
      updatedOrder.responsibleUserId = serviceOrderData.responsibleUserId;
    }

    if (serviceOrderData.branchId !== undefined) {
      updatedOrder.branchId = serviceOrderData.branchId;
    }

    if (serviceOrderData.supplierId !== undefined) {
      updatedOrder.supplierId = serviceOrderData.supplierId;
    }

    this.serviceOrders[index] = updatedOrder;
    return this.serviceOrders[index];
  }

  async deleteServiceOrder(serviceOrderId: string): Promise<ServiceOrder> {
    const index = this.serviceOrders.findIndex(
      (order) => order.id === serviceOrderId,
    );

    if (index === -1) {
      throw new Error("Service order not found");
    }

    const deletedOrder = this.serviceOrders[index];
    this.serviceOrders.splice(index, 1);
    return deletedOrder;
  }

  async findServiceOrderById(
    serviceOrderId: string,
  ): Promise<ServiceOrder | null> {
    const serviceOrder = this.serviceOrders.find(
      (order) => order.id === serviceOrderId,
    );
    return serviceOrder || null;
  }

  async findServiceOrdersByVehicleId(
    vehicleId: string,
  ): Promise<ServiceOrder[] | null> {
    const orders = this.serviceOrders.filter(
      (order) => order.vehicleId === vehicleId,
    );
    return orders.length > 0 ? orders : null;
  }

  async findServiceOrdersByResponsibleUserId(
    responsibleUserId: string,
  ): Promise<ServiceOrder[]> {
    return this.serviceOrders.filter(
      (order) => order.responsibleUserId === responsibleUserId,
    );
  }
}

export { InMemoryServiceOrderRepository };

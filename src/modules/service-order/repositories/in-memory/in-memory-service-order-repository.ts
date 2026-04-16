import { v7 as uuidV7 } from "uuid";
import { IServiceOrderRepository } from "../IService-order-repository";

import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  SearchServiceOrderByVehicleWithCursorProps,
  CursorPaginatedServiceOrder,
} from "../../dtos/service-order-dto";

class InMemoryServiceOrderRepository implements IServiceOrderRepository {
  public serviceOrders: ServiceOrder[] = [];

  async createServiceOrder(
    serviceOrderData: CreateServiceOrderProps,
  ): Promise<ServiceOrder> {
    const serviceOrder: ServiceOrder = {
      id: uuidV7(),
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
      // Geolocation fields
      latitude: serviceOrderData.latitude || null,
      longitude: serviceOrderData.longitude || null,
      latitude_original: serviceOrderData.latitude_original || null,
      longitude_original: serviceOrderData.longitude_original || null,
      location_source: serviceOrderData.location_source || null,
      location_edited_by: null,
      location_edited_at: null,
      created_from: serviceOrderData.created_from,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.serviceOrders.push(serviceOrder);
    return serviceOrder;
  }

  async listServiceOrders(
    listServiceOrderProps: ListServiceOrderByBusinessIdProps,
  ): Promise<ListServiceOrderProps> {
    const { page, pageSize, businessId, currentUserRole } =
      listServiceOrderProps;
    const filteredOrders =
      currentUserRole === "MASTER"
        ? [...this.serviceOrders]
        : this.serviceOrders.filter((order) => order.businessId === businessId);

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

  async *streamServiceOrdersForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    let filtered =
      userRole === "MASTER"
        ? [...this.serviceOrders]
        : this.serviceOrders.filter((order) => order.businessId === businessId);

    if (search) {
      const searchTerm = search.toLowerCase();
      filtered = filtered.filter(
        (order) =>
          order.id.toLowerCase().includes(searchTerm) ||
          order.maintenance_type.toLowerCase().includes(searchTerm) ||
          order.total_amount.toString().includes(searchTerm),
      );
    }

    for (const order of filtered) {
      yield {
        id: order.id,
        date: order.date,
        completion_date: order.completion_date,
        maintenance_type: order.maintenance_type,
        total_amount: Number(order.total_amount),
        current_mileage_at_service: order.current_mileage_at_service,
        maintenance_interval_km_at_service:
          order.maintenance_interval_km_at_service,
        last_maintenance_mileage_at_service:
          order.last_maintenance_mileage_at_service,
        new_mileage_after_service: order.new_mileage_after_service,
        businessId: order.businessId,
        ...(userRole === "MASTER" ? { businessName: null } : {}),
        vehicleId: order.vehicleId,
        vehicleLicensePlate: null,
        vehicleDescription: null,
        responsibleUserId: order.responsibleUserId,
        responsibleUserName: null,
        responsibleUserEmail: null,
        branchId: order.branchId,
        branchName: null,
        supplierId: order.supplierId,
        supplierName: null,
        latitude: order.latitude ?? null,
        longitude: order.longitude ?? null,
        latitude_original: order.latitude_original ?? null,
        longitude_original: order.longitude_original ?? null,
        location_source: order.location_source ?? null,
        location_edited_by: order.location_edited_by ?? null,
        location_edited_at: order.location_edited_at ?? null,
        created_from: order.created_from,
        created_at: order.created_at,
        updated_at: order.updated_at,
      };
    }
  }

  async searchServiceOrderWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchServiceOrderWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    let filtered = this.serviceOrders.filter(
      (order) => order.businessId === businessId,
    );

    if (cursor) {
      const cursorIndex = filtered.findIndex((o) => o.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async searchServiceOrderByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
  }: SearchServiceOrderByVehicleWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    let filtered = this.serviceOrders.filter(
      (order) =>
        order.vehicleId === vehicleId && order.businessId === businessId,
    );

    if (cursor) {
      const cursorIndex = filtered.findIndex((o) => o.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countServiceOrderForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const filteredServiceOrders =
      userRole === "MASTER"
        ? this.serviceOrders
        : this.serviceOrders.filter(
            (serviceOrder) => serviceOrder.businessId === businessId,
          );

    return filteredServiceOrders.length;
  }
}

export { InMemoryServiceOrderRepository };

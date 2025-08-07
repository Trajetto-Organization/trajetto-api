import {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
  UpdateServiceOrderPart,
} from "../dtos/service-order-part-dto";

interface IServiceOrderPartRepository {
  createServiceOrderPart: (
    serviceOrderPartData: CreateServiceOrderPartProps,
  ) => Promise<ServiceOrderPart>;
  listServiceOrderParts: (
    listServiceOrderPartByBusinessIdProps: ListServiceOrderPartByBusinessIdProps,
  ) => Promise<ListServiceOrderPartProps>;
  updateServiceOrderPart: ({
    serviceOrderPartData,
    serviceOrderPartId,
  }: UpdateServiceOrderPart) => Promise<ServiceOrderPart>;
  deleteServiceOrderPart: (
    serviceOrderPartId: string,
  ) => Promise<ServiceOrderPart>;
  findServiceOrderPartById: (
    serviceOrderPartId: string,
  ) => Promise<ServiceOrderPart | null>;
  findServiceOrderPartByPartId: (
    partId: string,
    serviceOrderId: string,
  ) => Promise<ServiceOrderPart | null>;
  calculateServiceOrderTotal: (serviceOrderId: string) => Promise<number>;
}

export { IServiceOrderPartRepository };

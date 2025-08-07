import {
  Business,
  CreateBusinessProps,
  ListBusinessByBusinessIdProps,
  ListBusinessProps,
  UpdateBusiness,
} from "../dtos/business-dto";

interface IBusinessRepository {
  createBusiness: (businessData: CreateBusinessProps) => Promise<Business>;
  listBusiness: (
    listBusinessProps: ListBusinessByBusinessIdProps,
  ) => Promise<ListBusinessProps>;
  updateBusiness: ({
    businessData,
    businessId,
  }: UpdateBusiness) => Promise<Business>;
  deleteBusiness: (businessId: string) => Promise<Business>;
  findBusinessById: (businessId: string) => Promise<Business | null>;
  findBusinessByCnpj: (cnpj: string) => Promise<Business | null>;
  findBusinessByCorporateReason: (
    corporateReason: string,
  ) => Promise<Business | null>;
  findBusinessByErpcode: (erpCode: string) => Promise<Business | null>;
  findBusinessByEmail: (email: string) => Promise<Business | null>;
}

export { IBusinessRepository };

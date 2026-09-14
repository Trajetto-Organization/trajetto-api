import {
  Business,
  CreateBusinessProps,
  CursorPaginatedBusiness,
  ListBusinessByBusinessIdProps,
  ListBusinessProps,
  SearchBusinessWithCursorProps,
  UpdateBusiness,
} from "../dtos/business-dto";

interface IBusinessRepository {
  createBusiness: (businessData: CreateBusinessProps) => Promise<Business>;
  listBusiness: (
    listBusinessProps: ListBusinessByBusinessIdProps,
  ) => Promise<ListBusinessProps>;
  searchBusinessWithCursor: (
    props: SearchBusinessWithCursorProps,
  ) => Promise<CursorPaginatedBusiness>;
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
  countBusinessDependencies: (
    businessId: string,
  ) => Promise<{ branches: number; users: number; drivers: number }>;
  updateVehicleLimit: (
    businessId: string,
    vehicle_limit: number,
  ) => Promise<Business>;
  updateAILimit: (
    businessId: string,
    ai_analysis_limit: number,
  ) => Promise<Business>;
  findAIUsage: (businessId: string) => Promise<{
    id: string;
    corporate_reason: string;
    fantasy_name: string | null;
    ai_analysis_limit: number;
  } | null>;
}

export { IBusinessRepository };

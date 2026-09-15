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

  /**
   * Flips the flag only if it is still where the caller last saw it.
   *
   * A toggle read the current value, negated it and wrote — so two people
   * flipping at the same moment both read the same state, both wrote the same
   * opposite, and two actions produced one change. The expected value goes
   * into the `where`: whoever runs second matches nothing and is told so,
   * instead of quietly agreeing with the first.
   *
   * Returns null when the precondition did not hold.
   */
  toggleBusinessActive: (
    businessId: string,
    expectedActive: boolean,
  ) => Promise<Business | null>;

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

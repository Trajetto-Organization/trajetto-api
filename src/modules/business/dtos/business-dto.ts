import { UserRole } from "@/modules/user/dtos/user-dto";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  BusinessGroupCount,
  BusinessSortKey,
  BusinessStatus,
  BusinessUf,
  PlaceCount,
} from "../usecases/list-business/business-list";

interface CreateBusinessProps {
  corporate_reason: string;
  fantasy_name?: string | null;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  cnpj: string;
  complement?: string | null;
  cnae: string;
  erp_code?: string | null;
  responsible_name: string;
  telephone: string;
  email: string;
  /** IANA zone of the company (Brazilian zones only); the column defaults it. */
  timezone?: string;
}

interface Business {
  id?: string;
  corporate_reason: string;
  fantasy_name?: string | null;
  cep: string;
  city: string;
  uf: string;
  street: string;
  address_number: string;
  cnpj: string;
  complement?: string | null;
  cnae: string;
  erp_code?: string | null;
  responsible_name: string;
  telephone: string;
  email: string;
  is_active?: boolean;
  /**
   * The company's clock (decision 1.1): every "today" and daily bucket is
   * computed in it. NOT NULL with a default in the table.
   */
  timezone?: string;
  ai_analysis_limit?: number;
  vehicle_limit?: number;
  // Registered fleet size — only populated by listBusiness (relation count).
  vehicle_count?: number;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface UpdateBusinessProps {
  id?: string | null;
  corporate_reason?: string | null;
  fantasy_name?: string | null;
  cep?: string | null;
  city?: string | null;
  uf?: string | null;
  street?: string | null;
  address_number?: string | null;
  cnpj?: string | null;
  complement?: string | null;
  cnae?: string | null;
  erp_code?: string | null;
  responsible_name?: string | null;
  telephone?: string | null;
  email?: string | null;
  timezone?: string | null;
}

/**
 * One page of companies and the breakdowns the cards and filters are
 * derived from (decision 8.8): never counted on the page.
 */
interface ListBusinessProps {
  data: Business[];
  /** Companies per (is_active, uf): search applied, the two facets not. */
  groups: BusinessGroupCount[];
  /** The cities with most companies, every filter applied. */
  topCities: PlaceCount[];
}

interface ListBusinessByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole: UserRole;
  search?: string;
  statuses?: BusinessStatus[];
  ufs?: BusinessUf[];
  sort?: BusinessSortKey;
  order?: SortOrder;
}

interface SearchBusinessWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  currentUserRole: UserRole;
  search?: string;
}

interface CursorPaginatedBusiness {
  data: Business[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface UpdateBusiness {
  businessData: UpdateBusinessProps;
  businessId: string;
}

export {
  Business,
  CreateBusinessProps,
  ListBusinessProps,
  UpdateBusiness,
  UpdateBusinessProps,
  ListBusinessByBusinessIdProps,
  SearchBusinessWithCursorProps,
  CursorPaginatedBusiness,
};

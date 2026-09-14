import { UserRole } from "@/modules/user/dtos/user-dto";

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
  ai_analysis_limit?: number;
  vehicle_limit?: number;
  // Registered fleet size — only populated by listBusiness (relation count).
  vehicle_count?: number;
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
}

interface ListBusinessProps {
  data: Business[];
  total: number;
}

interface ListBusinessByBusinessIdProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole: UserRole;
  search?: string;
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

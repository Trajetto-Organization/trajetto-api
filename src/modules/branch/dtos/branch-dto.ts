interface CreateBranchProps {
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
  businessId: string;
}

interface Branch {
  id: string;
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
  businessId: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ListAllBranchesProps {
  page: number;
  pageSize: number;
  currentUserRole: string;
  businessId: string;
  search?: string;
}

interface ListBranchProps {
  data: Branch[];
  total: number;
}

interface UpdateBranchProps {
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

interface UpdateBranch {
  branchData: UpdateBranchProps;
  branchId: string;
}

interface SearchBranchWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  search?: string;
}

interface CursorPaginatedBranch {
  data: Branch[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  Branch,
  CreateBranchProps,
  ListBranchProps,
  UpdateBranch,
  UpdateBranchProps,
  ListAllBranchesProps,
  SearchBranchWithCursorProps,
  CursorPaginatedBranch,
};

import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchProps,
  UpdateBranch,
  SearchBranchWithCursorProps,
  CursorPaginatedBranch,
} from "../dtos/branch-dto";

interface IBranchRepository {
  createBranch: (branchData: CreateBranchProps) => Promise<Branch>;
  listAllBranches: (
    listAllBranchesProps: ListAllBranchesProps,
  ) => Promise<ListBranchProps>;
  updateBranch: ({ branchData, branchId }: UpdateBranch) => Promise<Branch>;
  findBranchById: (branchId: string) => Promise<Branch | null>;
  findBranchByErpCode: (erp_code: string) => Promise<Branch | null>;
  findBranchByCnpj: (cnpj: string) => Promise<Branch | null>;
  findBranchByEmail: (email: string) => Promise<Branch | null>;
  findBranchByCorporateReason: (
    corporate_reason: string,
  ) => Promise<Branch | null>;
  deleteBranch: (branchId: string) => Promise<Branch>;
  countBranchDependencies: (
    branchId: string,
  ) => Promise<Record<string, number>>;
  searchBranchWithCursor: (
    props: SearchBranchWithCursorProps,
  ) => Promise<CursorPaginatedBranch>;
}

export { IBranchRepository };

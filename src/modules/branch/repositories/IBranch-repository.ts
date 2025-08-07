import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchBusinessProps,
  ListBranchProps,
  UpdateBranch,
} from "../dtos/branch-dto";

interface IBranchRepository {
  createBranch: (branchData: CreateBranchProps) => Promise<Branch>;
  listAllBranches: (
    listAllBranchesProps: ListAllBranchesProps,
  ) => Promise<ListBranchProps>;
  listBranchBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListBranchBusinessProps) => Promise<ListBranchProps>;
  updateBranch: ({ branchData, branchId }: UpdateBranch) => Promise<Branch>;
  findBranchById: (branchId: string) => Promise<Branch | null>;
  findBranchByErpCode: (erp_code: string) => Promise<Branch | null>;
  findBranchByCnpj: (cnpj: string) => Promise<Branch | null>;
  findBranchByEmail: (email: string) => Promise<Branch | null>;
  findBranchByCorporateReason: (
    corporate_reason: string,
  ) => Promise<Branch | null>;
  deleteBranch: (branchId: string) => Promise<Branch>;
}

export { IBranchRepository };

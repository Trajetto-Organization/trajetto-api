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

  /**
   * Flips the flag only if it is still where the caller last saw it.
   *
   * A toggle read the current value, negated it and wrote — so two people
   * acting at the same moment both read the same state, both wrote the same
   * opposite, and two actions produced one change. The expected value goes
   * into the `where`; whoever runs second matches nothing and is told so.
   *
   * Returns null when the precondition did not hold.
   */
  toggleBranchActive: (
    branchId: string,
    expectedActive: boolean,
  ) => Promise<Branch | null>;

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

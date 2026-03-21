import { v7 as uuidV7 } from "uuid";
import { IBranchRepository } from "../IBranch-repository";

import {
  Branch,
  CreateBranchProps,
  ListAllBranchesProps,
  ListBranchProps,
  UpdateBranch,
  SearchBranchWithCursorProps,
  CursorPaginatedBranch,
} from "../../dtos/branch-dto";

class InMemoryBranchRepository implements IBranchRepository {
  public branches: Branch[] = [];

  async createBranch(branchData: CreateBranchProps): Promise<Branch> {
    const branch: Branch = {
      id: uuidV7(),
      ...branchData,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.branches.push(branch);
    return branch;
  }

  async listAllBranches({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
  }: ListAllBranchesProps): Promise<ListBranchProps> {
    let filteredBranches = this.branches;

    if (currentUserRole !== "MASTER") {
      filteredBranches = this.branches.filter(
        (branch) => branch.businessId === businessId,
      );
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filteredBranches = filteredBranches.filter(
        (branch) =>
          branch.corporate_reason.toLowerCase().includes(searchLower) ||
          branch.cnpj.includes(search) ||
          branch.email.toLowerCase().includes(searchLower) ||
          (branch.fantasy_name &&
            branch.fantasy_name.toLowerCase().includes(searchLower)),
      );
    }

    const total = filteredBranches.length;
    const startIndex = (page - 1) * pageSize;

    const endIndex = startIndex + pageSize;
    const data = filteredBranches.slice(startIndex, endIndex);

    return { data, total };
  }

  async updateBranch({ branchData, branchId }: UpdateBranch): Promise<Branch> {
    const branchIndex = this.branches.findIndex(
      (branch) => branch.id === branchId,
    );

    if (branchIndex === -1) {
      throw new Error("Branch not found");
    }

    this.branches[branchIndex] = {
      ...this.branches[branchIndex],
      ...branchData,
      updated_at: new Date(),
    };

    return this.branches[branchIndex];
  }

  async findBranchById(branchId: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.id === branchId) || null;
  }

  async findBranchByErpCode(erp_code: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.erp_code === erp_code) || null;
  }

  async findBranchByCnpj(cnpj: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.cnpj === cnpj) || null;
  }

  async findBranchByEmail(email: string): Promise<Branch | null> {
    return this.branches.find((branch) => branch.email === email) || null;
  }

  async findBranchByCorporateReason(
    corporate_reason: string,
  ): Promise<Branch | null> {
    return (
      this.branches.find(
        (branch) => branch.corporate_reason === corporate_reason,
      ) || null
    );
  }

  async deleteBranch(branchId: string): Promise<Branch> {
    const branchIndex = this.branches.findIndex(
      (branch) => branch.id === branchId,
    );

    if (branchIndex === -1) {
      throw new Error("Branch not found");
    }

    const deletedBranch = this.branches[branchIndex];
    this.branches.splice(branchIndex, 1);

    return deletedBranch;
  }

  async searchBranchWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchBranchWithCursorProps): Promise<CursorPaginatedBranch> {
    let filtered = this.branches.filter(
      (branch) => branch.businessId === businessId,
    );

    if (cursor) {
      const cursorIndex = filtered.findIndex((b) => b.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemoryBranchRepository };

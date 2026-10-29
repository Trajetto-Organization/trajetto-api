import { Prisma } from "@prisma/client";

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
  /** With `tx`, inside the caller's transaction (a company's head office). */
  createBranch: (
    branchData: CreateBranchProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Branch>;
  /**
   * One company's page, sorted and filtered on the server, plus the
   * breakdown the cards and facets are derived from (decision 8.8).
   */
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

  updateBranch: (
    { branchData, branchId }: UpdateBranch,
    tx?: Prisma.TransactionClient,
  ) => Promise<Branch>;
  findBranchById: (branchId: string) => Promise<Branch | null>;
  /** Within one company: the ERP code is unique per business, not global. */
  findBranchByErpCode: (
    businessId: string,
    erp_code: string,
  ) => Promise<Branch | null>;
  /**
   * Platform-wide on purpose: the CNPJ is the branch's national identity and
   * its unique index stays global. Callers answer a hit with a neutral
   * message that names no company (decision 8.1).
   */
  findBranchByCnpj: (cnpj: string) => Promise<Branch | null>;
  /** Within one company: (businessId, email) is the table's unique. */
  findBranchByEmail: (
    businessId: string,
    email: string,
  ) => Promise<Branch | null>;
  /**
   * Within one company, ignoring case. The table's unique is
   * (businessId, corporate_reason); the check is stricter so "Filial Sul"
   * and "FILIAL SUL" are not two branches.
   */
  findBranchByCorporateReason: (
    businessId: string,
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

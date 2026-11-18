import { Prisma } from "@prisma/client";

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
  /**
   * With `tx`, inside the caller's transaction (the head office joins it);
   * without, in its own.
   */
  createBusiness: (
    businessData: CreateBusinessProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business>;
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
   *
   * With `tx`, it runs inside the caller's transaction, so the audit entry
   * commits with it (OUTBOX-10).
   */
  toggleBusinessActive: (
    businessId: string,
    expectedActive: boolean,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business | null>;

  updateBusiness: (
    { businessData, businessId }: UpdateBusiness,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business>;

  /**
   * Schedules the company's purge (plano-escala F3-25): inactive from now
   * (`deactivated_at`), SCHEDULED, the data going on `purgeAfter`. Only a
   * company never scheduled (`purge_state` NULL) moves: null otherwise, or
   * when it does not exist. The conditional write is the lock against a
   * second click.
   */
  schedulePurge: (
    businessId: string,
    purgeAfter: Date,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business | null>;

  /**
   * Reactivates a company whose purge is SCHEDULED: active again, the purge
   * columns cleared. Only from SCHEDULED — a purge that started (PURGING)
   * is never undone: null then, or when the company does not exist.
   */
  cancelPurge: (
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business | null>;

  /** The SCHEDULED companies whose purge falls in [from, to). */
  findScheduledPurges: (from: Date, to: Date) => Promise<Business[]>;
  deleteBusiness: (
    businessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business>;
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
  // `tx`: the limit and the event announcing it commit together (OUTBOX-10).
  updateVehicleLimit: (
    businessId: string,
    vehicle_limit: number,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business>;
  updateAILimit: (
    businessId: string,
    ai_analysis_limit: number,
    tx?: Prisma.TransactionClient,
  ) => Promise<Business>;
  findAIUsage: (businessId: string) => Promise<{
    id: string;
    corporate_reason: string;
    fantasy_name: string | null;
    ai_analysis_limit: number;
  } | null>;
}

export { IBusinessRepository };

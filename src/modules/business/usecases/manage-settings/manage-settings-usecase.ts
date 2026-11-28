import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { IBusinessSettingsRepository } from "@/modules/business/repositories/IBusiness-settings-repository";
import type { BusinessSettings } from "@/modules/business/dtos/business-settings-dto";
import type { User } from "@/modules/user/dtos/user-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { assertCallerRole } from "@/modules/business/usecases/errors/business-role-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import {
  GEOFENCE_RADIUS_MAX_M,
  GEOFENCE_RADIUS_MIN_M,
  describeSettingsChange,
  settingsAvailability,
  settingsChanges,
  settingsOrDefaults,
  type BusinessSettingsValues,
  type SettingsAvailability,
} from "@/shared/business/business-settings";
import { getBusinessEntitlements } from "@/shared/entitlements/entitlement-service";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { sendCatalogChangedEvent } from "@/websocket";

import database from "@/../infra/database";

/**
 * "Configurações da empresa" (plan of 02/11/2026, M1; decision D11): what a
 * company's admin decides for its own operation — the checklist on the route
 * (C4) and the geofence (E*). Read and written by the company's own
 * BUSINESS_ADMIN and by a MASTER; nobody else. The plan the MASTER sells
 * (modules, limits) stays on its own routes.
 */

/** Who edits them: the company's own admin, or a MASTER (D11). */
const SETTINGS_ROLES = ["MASTER", "BUSINESS_ADMIN"] as const;

interface BusinessSettingsView extends BusinessSettingsValues {
  businessId: string;
  /**
   * Which sections apply, by the modules the company has on (M6): the web
   * shows only these, and the app and the API ignore the others.
   */
  available: SettingsAvailability;
  /** The radius bounds, for the form (D12). */
  limits: { geofence_radius_min_m: number; geofence_radius_max_m: number };
  /** Null while the company never saved (it reads the defaults). */
  updated_at: Date | null;
  updated_by: { id: string; name: string } | null;
}

interface SettingsRequest {
  userId: string;
  businessId: string;
}

interface UpdateSettingsRequest extends SettingsRequest {
  data: Partial<BusinessSettingsValues>;
}

/** The caller, refused like the route would refuse them. */
async function settingsCaller(
  users: IUserRepository,
  { userId, businessId }: SettingsRequest,
): Promise<User> {
  const caller = await users.findUserById(userId);

  if (!caller) throw new ResourceNotFoundError();

  // Role, then tenant: the same answers as the route's guards, so the result
  // does not depend on which wall caught the request.
  assertCallerRole(caller, SETTINGS_ROLES);
  assertTenantAccess(caller, businessId);

  return caller;
}

async function settingsView(
  users: IUserRepository,
  businessId: string,
  stored: BusinessSettings | null,
): Promise<BusinessSettingsView> {
  const [entitlements, updatedBy] = await Promise.all([
    getBusinessEntitlements(businessId),
    stored?.updatedById ? users.findUserById(stored.updatedById) : null,
  ]);

  const enabledModules = entitlements
    .filter((row) => row.enabled)
    .map((row) => row.module);

  return {
    businessId,
    ...settingsOrDefaults(stored),
    available: settingsAvailability(enabledModules),
    limits: {
      geofence_radius_min_m: GEOFENCE_RADIUS_MIN_M,
      geofence_radius_max_m: GEOFENCE_RADIUS_MAX_M,
    },
    updated_at: stored?.updated_at ?? null,
    updated_by: updatedBy ? { id: updatedBy.id, name: updatedBy.name } : null,
  };
}

@injectable()
class GetBusinessSettingsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BusinessSettingsRepository")
    private settings: IBusinessSettingsRepository,
  ) {}

  async execute(request: SettingsRequest): Promise<BusinessSettingsView> {
    await settingsCaller(this.user, request);

    const business = await this.business.findBusinessById(request.businessId);

    if (!business) throw new BusinessNotFoundError();

    const stored = await this.settings.findByBusinessId(request.businessId);

    return settingsView(this.user, request.businessId, stored);
  }
}

@injectable()
class UpdateBusinessSettingsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BusinessSettingsRepository")
    private settings: IBusinessSettingsRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    data,
    ...request
  }: UpdateSettingsRequest): Promise<BusinessSettingsView> {
    const caller = await settingsCaller(this.user, request);
    const { businessId } = request;

    const business = await this.business.findBusinessById(businessId);

    if (!business) throw new BusinessNotFoundError();

    /**
     * The settings and their audit entry commit together (OUTBOX-10), and two
     * saves serialize on the company row: the second reads what the first
     * left, so each audit line states a real movement. NO KEY UPDATE, as the
     * plan changes take it: the stronger lock would also wait on every
     * foreign-key check against the company.
     */
    const saved = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "business" WHERE "id" = ${businessId} FOR NO KEY UPDATE`;

      const current = await this.settings.findByBusinessId(businessId, tx);
      const changes = settingsChanges(settingsOrDefaults(current), data);

      // Saving what is already there is not a change: no write, no audit
      // line, no refetch on every phone.
      if (changes.length === 0) return { row: current, changed: false };

      const row = await this.settings.save(
        { businessId, updatedById: caller.id, ...data },
        tx,
      );

      await this.outbox.publish(tx, {
        topic: "business-settings.changed",
        aggregateType: "business",
        aggregateId: businessId,
        businessId,
        actorId: caller.id,
        payload: {
          businessId,
          businessName: business.corporate_reason,
          changes: changes.map(({ field, from, to }) => ({ field, from, to })),
          description: changes.map(describeSettingsChange).join("; "),
          actor: {
            id: caller.id,
            name: caller.name,
            email: caller.email,
            role: caller.role,
          },
        },
      });

      return { row, changed: true };
    });

    // After the commit: the open screens and the drivers' apps refetch and
    // apply the new values in seconds (a hint; the API is the source).
    if (saved.changed) sendCatalogChangedEvent(businessId, "settings");

    return settingsView(this.user, businessId, saved.row);
  }
}

export { GetBusinessSettingsUseCase, UpdateBusinessSettingsUseCase };
export type { BusinessSettingsView };

import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";

import {
  buildFunnel,
  dayProgress,
  summarisePunctuality,
  type FunnelStatus,
  type PunctualitySummary,
} from "@/shared/route/control-tower-rules";

import { isPositionFresh } from "@/shared/route/driver-position-rules";

interface ControlTowerRequest {
  userId: string;
  businessId?: string;
}

interface TowerPosition {
  driverId: string;
  driverName: string | null;

  routeId: string | null;
  routeCode: number | null;

  vehiclePlate: string | null;

  latitude: number;
  longitude: number;

  speed: number | null;
  heading: number | null;
  battery: number | null;

  recordedAt: string;

  /** Whether the dot still means "where they are" or "where they were". */
  fresh: boolean;
}

interface TowerEvent {
  id: string;
  type: string;
  actor: string;

  deliveryId: string;
  recipientName: string | null;

  driverName: string | null;

  occurredAt: string;
}

interface ControlTower {
  positions: TowerPosition[];

  funnel: Array<{ status: FunnelStatus; label: string; total: number }>;
  progress: { finished: number; total: number; rate: number | null };

  punctuality: PunctualitySummary;

  events: TowerEvent[];
}

/**
 * How far back the map looks for a dot.
 *
 * Twelve hours, not "today": an operation that starts at five in the morning
 * and a query that starts at midnight agree, but one that runs past midnight
 * does not — and the night shift would watch every truck disappear at 00:00.
 */
const POSITION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** How many events the "últimos eventos" widget shows. */
const EVENT_LIMIT = 15;

/**
 * Everything the tower draws, in one request.
 *
 * One endpoint and not five, because the panel refreshes all of it together
 * and five requests on a timer is five times the connections for a screen a
 * dispatcher leaves open all day. The widgets are FIXED — no customisation —
 * so there is nothing to negotiate per client.
 *
 * Manager surface. A driver token is refused rather than shown the whole
 * operation, the same rule the monitoring panel already applies: the app's
 * permission table opens delivery_manage for the driver's own work, and this
 * is everybody's.
 */
@injectable()
class ControlTowerUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: ControlTowerRequest): Promise<ControlTower> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.driverId) {
      throw new AppError(
        "A torre de controle é superfície do gestor.",
        403,
        "DRIVER_CANNOT_VIEW_PANELS",
      );
    }

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const [positions, funnelCounts, routes, events] = await Promise.all([
      this.positions.listLatestByBusiness(
        resolvedBusinessId,
        new Date(now.getTime() - POSITION_WINDOW_MS),
      ),

      database.delivery.groupBy({
        by: ["status"],
        where: { businessId: resolvedBusinessId, created_at: { gte: startOfToday } },
        _count: { _all: true },
      }),

      database.route.findMany({
        where: {
          businessId: resolvedBusinessId,
          scheduled_date: { gte: startOfToday },
          status: { not: "CANCELLED" },
        },
        select: { planned_departure_at: true, started_at: true },
      }),

      database.deliveryEvent.findMany({
        where: { delivery: { businessId: resolvedBusinessId } },
        orderBy: { created_at: "desc" },
        take: EVENT_LIMIT,
        select: {
          id: true,
          type: true,
          actor: true,
          created_at: true,
          delivery: {
            select: {
              id: true,
              recipient_name: true,
              driver: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    const counts = funnelCounts.map((entry) => ({
      status: entry.status as string,
      total: entry._count._all,
    }));

    return {
      positions: positions.map((position) => ({
        driverId: position.driverId,
        driverName: position.driverName,

        routeId: position.routeId,
        routeCode: position.routeCode,

        vehiclePlate: position.vehiclePlate,

        latitude: position.latitude,
        longitude: position.longitude,

        speed: position.speed,
        heading: position.heading,
        battery: position.battery,

        recordedAt: position.recorded_at.toISOString(),

        fresh: isPositionFresh(position.recorded_at, now),
      })),

      funnel: buildFunnel(counts),
      progress: dayProgress(counts),

      punctuality: summarisePunctuality(routes),

      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        actor: event.actor,

        deliveryId: event.delivery.id,
        recipientName: event.delivery.recipient_name,

        driverName: event.delivery.driver?.name ?? null,

        occurredAt: event.created_at.toISOString(),
      })),
    };
  }
}

export {
  ControlTowerUseCase,
  EVENT_LIMIT,
  POSITION_WINDOW_MS,
  type ControlTower,
  type TowerEvent,
  type TowerPosition,
};

import database from "@/../infra/database";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type { IChatRepository } from "../../../repositories/IChat-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicket } from "../../../dtos/support-ticket-dto";

import {
  createDriverTicket,
  driverSubject,
  resolveDeliveryTicket,
  resolveRouteTicket,
  type OpenedBy,
} from "../../shared/ticket-factory";
import { routeLegacyMessage } from "../../shared/ticket-rules";

/** One run's ceiling: a rolling deploy writes a handful, never thousands. */
const REPAIR_BATCH = 200;

/**
 * Fallback only, for a database with no record of the backfill migration:
 * the real bound is when that database ran it (`ticketsBackfilledAt`), since
 * the backfill filed exactly the messages written before it (design §9.3).
 * A fixed instant would skip, in a database migrated earlier than it (CI
 * clock, restored dump), every message written in between.
 */
const TICKETS_INTRODUCED_AT = new Date("2026-10-05T12:05:00.000Z");

/**
 * How far back a run looks. A rolling deploy lasts minutes and the job runs
 * every minute; the window only bounds the walk past the mass notices,
 * which stay ticketless forever.
 */
const REPAIR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function repairWindowStart(now: Date, backfilledAt: Date | null): Date {
  const lookback = new Date(now.getTime() - REPAIR_LOOKBACK_MS);
  const introduced = backfilledAt ?? TICKETS_INTRODUCED_AT;

  return lookback > introduced ? lookback : introduced;
}

const SYSTEM: OpenedBy = {
  via: "LEGACY_ROUTING",
  userId: null,
  actorKind: "SYSTEM",
  actorName: null,
};

/**
 * Files the messages the previous image wrote without a ticket during a
 * rolling deploy (design §9.3): the delivery's ticket, the route's, or the
 * driver's open general ticket (a new one when there is none). Conditional
 * on `ticketId IS NULL`, so two runs never file one message twice. Removed
 * together with the legacy routing.
 */
class RepairUnticketedMessagesUseCase {
  constructor(
    private tickets: ISupportTicketRepository,
    private chat: IChatRepository,
    private delivery: IDeliveryRepository,
    private user: IUserRepository,
    private driver: IDriverRepository,
  ) {}

  async execute(): Promise<number> {
    const messages = await this.tickets.listUnticketedMessages(
      REPAIR_BATCH,
      repairWindowStart(new Date(), await this.tickets.ticketsBackfilledAt()),
    );
    const deps = { tickets: this.tickets, chat: this.chat };

    let repaired = 0;

    for (const message of messages) {
      const driverUser = await this.user.findUserByDriverId(message.driverId);
      const ticket = await this.ticketFor(message, driverUser?.id ?? null, deps);

      if (!ticket) continue;

      const attached = await database.$transaction(async (tx) => {
        const done = await this.tickets.attachMessage(message.id, ticket.id, tx);

        if (done) {
          await this.tickets.touchOnMessage(
            {
              id: ticket.id,
              at: message.created_at,
              side: driverUser?.id === message.senderId ? "DRIVER" : "STAFF",
            },
            tx,
          );
        }

        return done;
      });

      if (attached) repaired += 1;
    }

    return repaired;
  }

  /**
   * The same routing a live legacy send gets (§4.9), judged at the moment
   * the message was written: a reply to what the tower had said in the 30
   * minutes before it lands in that ticket.
   */
  private async ticketFor(
    message: {
      threadId: string;
      businessId: string;
      driverId: string;
      deliveryId: string | null;
      routeId: string | null;
      created_at: Date;
    },
    driverUserId: string | null,
    deps: { tickets: ISupportTicketRepository; chat: IChatRepository },
  ): Promise<SupportTicket | null> {
    const recent = await this.tickets.findLastStaffMessageTicket(
      message.threadId,
      driverUserId,
      message.created_at,
    );

    const decision = routeLegacyMessage({
      recentStaffTicket: recent
        ? { id: recent.ticket.id, status: recent.ticket.status, at: recent.at }
        : null,
      now: message.created_at,
      deliveryId: message.deliveryId,
      explicitRouteId: message.routeId,
      derivedRouteId: null,
      latestOpenDriverTicketId: null,
    });

    if (decision.target === "TICKET" && recent) return recent.ticket;

    if (message.deliveryId) {
      const found = await this.delivery.findDeliveryById(message.deliveryId);

      if (found && found.businessId === message.businessId) {
        const resolved = await resolveDeliveryTicket(deps, {
          businessId: message.businessId,
          driverId: message.driverId,
          holderDriverId: found.driverId ?? null,
          deliveryId: message.deliveryId,
          recipientName: found.recipient_name,
          opened: SYSTEM,
        });

        // Null: the delivery moved on since; the driver's own ticket takes it.
        if (resolved) return resolved.ticket;
      }
    }

    if (message.routeId) {
      const route = await this.chat.findRoute(message.routeId);

      if (route && route.businessId === message.businessId) {
        const resolved = await resolveRouteTicket(deps, {
          businessId: message.businessId,
          driverId: message.driverId,
          route,
          opened: SYSTEM,
        });

        if (resolved) return resolved.ticket;
      }
    }

    const open = await this.tickets.findLatestOpenDriverTicket(
      message.businessId,
      message.driverId,
    );

    if (open) return open;

    return createDriverTicket(deps, {
      businessId: message.businessId,
      driverId: message.driverId,
      subject: driverSubject(
        (await this.driver.findDriverById(message.driverId))?.name ?? "o motorista",
      ),
      opened: SYSTEM,
    });
  }
}

export {
  RepairUnticketedMessagesUseCase,
  REPAIR_BATCH,
  TICKETS_INTRODUCED_AT,
  repairWindowStart,
};

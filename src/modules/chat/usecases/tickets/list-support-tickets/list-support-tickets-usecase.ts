import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type {
  SupportTicketCounts,
  SupportTicketKind,
  SupportTicketScope,
  SupportTicketStatusFilter,
} from "../../../dtos/support-ticket-dto";

import {
  driverTicketView,
  presentTicket,
  type DriverTicketView,
  type TicketSummary,
} from "../../shared/ticket-presenter";
import { resolveTicketScope } from "../ticket-access";

interface ListSupportTicketsRequest {
  userId: string;
  businessId?: string;
  status: SupportTicketStatusFilter;
  scope: SupportTicketScope;
  kind?: SupportTicketKind;
  driverId?: string;
  deliveryId?: string;
  routeId?: string;
  occurrenceId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

interface ListSupportTicketsResponse {
  data: Array<TicketSummary | (DriverTicketView & { unreadCount: number })>;
  total: number;
  counts: SupportTicketCounts;
}

/**
 * The tickets of the company (design §4.2), newest conversation first, with
 * the requester's unread per ticket and the counts behind the filters. A
 * driver token lists only his own tickets, in the driver's view.
 */
@injectable()
class ListSupportTicketsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
  ) {}

  async execute(
    request: ListSupportTicketsRequest,
  ): Promise<ListSupportTicketsResponse> {
    const scope = await resolveTicketScope(
      this.user,
      request.userId,
      request.businessId,
    );
    const forDriver = Boolean(scope.driverId);

    const [{ data, total }, counts] = await Promise.all([
      this.tickets.list({
        businessId: scope.businessId,
        requesterUserId: scope.user.id,
        driverId: scope.driverId ?? undefined,
        status: request.status,
        scope: forDriver ? "ALL" : request.scope,
        kind: request.kind,
        // A driver's own tickets already are his: the filter is the tower's.
        filterDriverId: forDriver ? undefined : request.driverId,
        deliveryId: request.deliveryId,
        routeId: request.routeId,
        occurrenceId: request.occurrenceId,
        search: request.search,
        page: request.page,
        pageSize: request.pageSize,
      }),
      this.tickets.counts({
        businessId: scope.businessId,
        requesterUserId: scope.user.id,
        driverId: scope.driverId ?? undefined,
      }),
    ]);

    const ids = data.map((row) => row.id);

    const [unread, lastMessages] = await Promise.all([
      this.tickets.unreadCounts(ids, scope.user.id, forDriver),
      this.tickets.lastMessages(ids),
    ]);

    return {
      data: data.map((row) => {
        const summary = presentTicket(row, {
          unreadCount: unread.get(row.id) ?? 0,
          lastMessage: lastMessages.get(row.id) ?? null,
        });

        return forDriver
          ? { ...driverTicketView(summary), unreadCount: summary.unreadCount }
          : summary;
      }),
      total,
      counts,
    };
  }
}

export { ListSupportTicketsUseCase };
export type { ListSupportTicketsRequest, ListSupportTicketsResponse };

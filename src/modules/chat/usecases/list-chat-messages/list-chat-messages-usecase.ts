import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IChatRepository } from "../../repositories/IChat-repository";
import type { ISupportTicketRepository } from "../../repositories/ISupport-ticket-repository";

import { UploadService } from "@/shared/services/upload-service";

import { resolveChatScope } from "../shared/chat-scope";
import {
  PresentedChatMessage,
  presentChatMessage,
} from "../shared/chat-presenter";

import {
  ChatMessageNotFoundError,
  ChatThreadNotFoundError,
} from "../errors/chat-errors";
import { SupportTicketNotFoundError } from "../errors/support-ticket-errors";
import {
  driverTicketView,
  presentTicket,
  type DriverTicketView,
  type TicketSummary,
} from "../shared/ticket-presenter";

interface ListChatMessagesRequest {
  userId: string;
  threadId?: string;

  /** Staff alternative to threadId: which driver's conversation to open. */
  driverId?: string;

  /** Walks towards the present instead of into the past. */
  after?: { created_at: Date; id: string };

  /**
   * Centre the page on this message — "jump to this message" from a search
   * hit. Takes precedence over both cursors.
   */
  aroundMessageId?: string;
  before?: { created_at: Date; id: string };
  limit: number;
  search?: string;
  businessId?: string;

  /** Narrow the thread to one delivery's / one route's messages. */
  deliveryId?: string;
  routeId?: string;

  /** Only this support ticket's messages (decision 14.5). */
  ticketId?: string;
}

interface ListChatMessagesResponse {
  /** Null when the driver has no conversation yet — an empty, valid chat. */
  threadId: string | null;
  data: PresentedChatMessage[];
  nextCursor: { created_at: string; id: string } | null;

  /** The cursor towards the present, and whether anything is out there. */
  previousCursor: { created_at: string; id: string } | null;
  hasNewer: boolean;

  counterpartLastReadAt: Date | null;

  /**
   * The driver's app account, or null when he has none.
   *
   * It rides here so the conversation view can stand on its own. The panel
   * used to infer this from the thread list, which is paginated AND filtered
   * by the search box — so opening a driver from a message-text hit showed
   * "no app access" and "say hello, this conversation starts now" over a
   * history that existed all along.
   */
  driverUser: { id: string; last_seen_at: Date | null } | null;

  /** Grey double check — only a staff viewer ever gets a value here. */
  counterpartDeliveredAt: Date | null;

  /**
   * The tickets the messages of this page belong to, for the subject
   * separators (design §8). The driver gets the reduced view.
   */
  tickets: Array<TicketSummary | DriverTicketView>;

  /**
   * The other side's read cursor per ticket cited on the page (a ticket
   * read moves only the ticket cursor, not the thread one). A message is read
   * when it is covered by counterpartLastReadAt OR by its ticket's entry
   * here. Tickets the other side never read are absent.
   */
  counterpartTicketReadAt: Record<string, Date>;
}

@injectable()
class ListChatMessagesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    // Optional so callers built before the tickets keep working.
    @inject("SupportTicketRepository")
    private tickets?: ISupportTicketRepository,
  ) {}

  async execute({
    userId,
    threadId,
    driverId,
    before,
    after,
    aroundMessageId,
    limit,
    search,
    businessId: requestedBusinessId,
    deliveryId,
    routeId,
    ticketId,
  }: ListChatMessagesRequest): Promise<ListChatMessagesResponse> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    // A ticket names its own thread. Out of the company, or another
    // driver's for a driver token, it answers exactly like a missing one.
    const ticket =
      ticketId && this.tickets
        ? await this.tickets.findById(ticketId, scope.businessId)
        : null;

    if (ticketId && (!ticket || (scope.driverId && ticket.driverId !== scope.driverId))) {
      throw new SupportTicketNotFoundError();
    }

    // Whose conversation this is. A driver token can only ever be its own,
    // whatever the query asks for; the staff picks, by thread or by driver.
    const targetDriverId = scope.driverId ?? ticket?.driverId ?? driverId ?? null;

    // A driver resolves their own thread from the token; a foreign threadId
    // answers "not found", never "not yours" — same non-leak rule as
    // list-delivery.
    const found = ticket
      ? await this.chat.findThreadById(ticket.threadId)
      : threadId
      ? await this.chat.findThreadById(threadId)
      : targetDriverId
        ? await this.chat.findThreadByDriver(scope.businessId, targetDriverId)
        : null;

    // Another company's thread, or another driver's for a driver token, is a
    // thread that does not exist — and goes down exactly the path a random id
    // goes. Refusing it on its own branch (404 here, 200 "empty chat" for the
    // random id next to a driverId) told the caller which ids are real
    // (IDOR sweep, 10/2026).
    const thread =
      found &&
      found.businessId === scope.businessId &&
      !(scope.driverId && found.driverId !== scope.driverId)
        ? found
        : null;

    // Asked by driver and there is no conversation yet: that is not an error,
    // it is an empty chat. The staff side gets the same answer the driver
    // side has always had — a panel opening a driver who was never written to
    // must render a blank thread, not a failure.
    if (!thread && targetDriverId) {
      return {
        threadId: null,
        data: [],
        nextCursor: null,
        previousCursor: null,
        hasNewer: false,
        counterpartLastReadAt: null,
        counterpartDeliveredAt: null,
        driverUser: await this.resolveDriverUser(scope.businessId, targetDriverId),
        tickets: [],
        counterpartTicketReadAt: {},
      };
    }

    if (!thread || thread.businessId !== scope.businessId) {
      throw new ChatThreadNotFoundError();
    }

    // The anchor is resolved HERE, not on the client: only the server knows
    // the message's (created_at, id) pair, and only it can check the message
    // really lives in this thread before centring a page on it.
    const anchor = aroundMessageId
      ? await this.chat.findMessageById(aroundMessageId)
      : null;

    if (aroundMessageId && (!anchor || anchor.threadId !== thread.id)) {
      throw new ChatMessageNotFoundError();
    }

    // A window centred on a message the filter hides would open on nothing.
    if (
      anchor &&
      ((deliveryId && anchor.deliveryId !== deliveryId) ||
        (routeId && anchor.routeId !== routeId) ||
        (ticketId && anchor.ticketId !== ticketId))
    ) {
      throw new ChatMessageNotFoundError();
    }

    const result = await this.chat.listMessages({
      threadId: thread.id,
      viewerIsDriverSide: Boolean(scope.driverId),
      before,
      after,
      around: anchor
        ? { created_at: anchor.created_at, id: anchor.id }
        : undefined,
      limit,
      search,
      deliveryId,
      routeId,
      ticketId,
    });

    const data = await Promise.all(
      result.data.map((message) =>
        presentChatMessage(message, this.uploadService),
      ),
    );

    const viewerIsDriverSide = Boolean(scope.driverId);
    const driverUser = await this.resolveDriverUser(scope.businessId, thread.driverId);

    const ticketCursors = await this.ticketReadCursors(
      result.data,
      ticketId ?? null,
      // The driver himself is the viewer on his side: his id is the token's.
      viewerIsDriverSide ? userId : (driverUser?.id ?? null),
      viewerIsDriverSide,
    );

    // A view filtered to one ticket answers that ticket's cursor too.
    const ticketCursor = ticketId ? ticketCursors.get(ticketId) : undefined;

    return {
      threadId: thread.id,
      data,
      driverUser,
      nextCursor: result.nextCursor,
      previousCursor: result.previousCursor,
      hasNewer: result.hasNewer,
      counterpartLastReadAt: latestDate(result.counterpartLastReadAt, ticketCursor ?? null),
      counterpartDeliveredAt: result.counterpartDeliveredAt,
      tickets: await this.citedTickets(result.data, scope.businessId, viewerIsDriverSide),
      counterpartTicketReadAt: Object.fromEntries(ticketCursors),
    };
  }

  /** The other side's cursor on each ticket cited on the page. */
  private async ticketReadCursors(
    messages: Array<{ ticketId: string | null }>,
    filterTicketId: string | null,
    driverUserId: string | null,
    viewerIsDriverSide: boolean,
  ): Promise<Map<string, Date>> {
    if (!this.tickets) return new Map();

    const ids = new Set(
      messages.map((message) => message.ticketId).filter((id): id is string => Boolean(id)),
    );

    if (filterTicketId) ids.add(filterTicketId);

    return this.tickets.counterpartReadCursors([...ids], driverUserId, viewerIsDriverSide);
  }

  /** The tickets cited on the page, presented for the separators. */
  private async citedTickets(
    messages: Array<{ ticketId: string | null }>,
    businessId: string,
    forDriver: boolean,
  ): Promise<Array<TicketSummary | DriverTicketView>> {
    if (!this.tickets) return [];

    const ids = [
      ...new Set(
        messages
          .map((message) => message.ticketId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const rows = await this.tickets.findManyRows(ids, businessId);

    return rows.map((row) => {
      const summary = presentTicket(row);

      return forDriver ? driverTicketView(summary) : summary;
    });
  }

  /**
   * The driver's app account, scoped to the caller's company.
   *
   * The tenant check is the point: a driverId arrives from the query string,
   * so answering for a driver of another company would leak whether that
   * driver exists and whether he has an account. Out of scope reads exactly
   * like a driver with no app access.
   */
  private async resolveDriverUser(
    businessId: string,
    driverId: string,
  ): Promise<{ id: string; last_seen_at: Date | null } | null> {
    const driver = await this.driver.findDriverById(driverId);

    if (!driver || driver.businessId !== businessId) return null;

    const user = await this.user.findUserByDriverId(driverId);

    if (!user) return null;

    return { id: user.id, last_seen_at: user.last_seen_at ?? null };
  }
}

function latestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;

  return a > b ? a : b;
}

export { ListChatMessagesUseCase };

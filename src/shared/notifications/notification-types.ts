import { NotificationCategory } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { User } from "@/modules/user/dtos/user-dto";

/**
 * Contract between use cases (that publish events) and the pipeline (that
 * turns them into notifications).
 *
 * A payload must be self-contained: everything a render needs, captured at
 * the moment the event happened. Deliveries may run seconds later on another
 * replica — the render never goes back to the database for display data,
 * so a record edited meanwhile still notifies what actually occurred.
 */

interface FineCreatedPayload {
  fineId: string;
  businessId: string;
  amount: number;
  points: number | null;
  /** ISO string — Json columns don't round-trip Date objects. */
  violationDate: string;
  /**
   * The company's zone (Business.timezone), captured with the event so the
   * render prints the infraction's day without a query. Optional: events
   * published before it existed read in the default zone.
   */
  timeZone?: string;
  location: string | null;
  observation: string | null;
  vehiclePlate: string;
  driverName: string;
  branchName: string;
  violationCode: string;
  actor: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

interface VehicleChecklistCreatedPayload {
  checklistId: string;
  businessId: string;
  vehiclePlate: string;
  vehicleDescription: string;

  /** MOBILE_APP | WEB_DASHBOARD. Optional: events published before the field existed. */
  origin?: string;
}

interface FuelCreatedPayload {
  fuelId: string;
  businessId: string;
  vehiclePlate: string;
  vehicleDescription: string;

  /** MOBILE_APP | WEB_DASHBOARD. Optional: events published before the field existed. */
  origin?: string;
}

// Published by the AI pipeline ONLY when the verification found something
// actionable (mismatch, fraud signs, contradicted checklist items). Clean
// results stay silent — the record status already tells that story.
interface AIVerificationIssuePayload {
  recordType: "fuel" | "checklist";
  recordId: string;
  businessId: string;
  vehiclePlate: string | null;
  vehicleDescription: string | null;
  overallStatus: string;
  details: string | null;
}

/**
 * A receipt the AI reading flagged (decision 6.9) — one that looks wrong, or
 * a photo too poor to read — for the driver who sent it. A suggestion: the
 * office still decides.
 */
interface DeliveryProofAIFlaggedPayload {
  businessId: string;
  deliveryId: string;
  driverUserId: string;
  recipientName: string;

  /**
   * What is wrong, in pt-BR and lower case (driverFeedbackFor): one phrase
   * per failed criterion, most damning first, or the one phrase for a photo
   * too poor to read.
   */
  problems: string[];

  /** The card's sentence (describeAssessment). */
  summary: string;
}

interface ServiceOrderCreatedPayload {
  serviceOrderId: string;
  businessId: string;
  vehicleId: string;
  vehiclePlate: string | null;
  totalAmount: number;
  currentMileage: number | null;
  newMileage: number | null;
  isCompleted: boolean;
  responsibleUserId: string;
}

interface AccountPayableCreatedPayload {
  accountPayableId: string;
  businessId: string;
  amount: number;
  serviceOrderId: string | null;
  registrationUserId: string;
}

interface ServiceOrderUpdatedPayload {
  serviceOrderId: string;
  businessId: string;
  vehicleId: string;
  vehiclePlate: string | null;
  totalAmount: number;

  /**
   * Set only when this update handed the order to a new responsible — an
   * unchanged assignment updates the order without paging anyone.
   */
  responsibleUserId: string | null;
}

interface AccountPayableUpdatedPayload {
  accountPayableId: string;
  businessId: string;
  amount: number;
  serviceOrderId: string | null;

  /** Same hand-over rule as the service order above. */
  registrationUserId: string | null;
}

interface KanbanCardCreatedPayload {
  cardId: string;
  businessId: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  /** The company's zone the due day is printed in; absent on older events. */
  timeZone?: string;
  isCompleted: boolean;

  /** Null = nobody assigned; the event only feeds the activity trail. */
  assignedUserId: string | null;

  /** Auto-created from a service order, which changes the activity wording. */
  fromServiceOrder: boolean;
}

interface KanbanCardUpdatedPayload {
  cardId: string;
  businessId: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  /** The company's zone the due day is printed in; absent on older events. */
  timeZone?: string;
  isCompleted: boolean;

  /**
   * Set only when this update handed the card to a new user — an unchanged
   * assignment updates the card without paging anyone.
   */
  assignedUserId: string | null;
}

/**
 * Generic audit-trail event: the payload already is the activity to record.
 *
 * This is the migration path for the dozens of use cases whose only
 * notification is an activity entry — they publish this one topic instead of
 * each growing a bespoke topic nobody would ever render differently.
 */
interface ActivityRecordedPayload {
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;

  /** Hierarchical visibility fields used by MASTER-level activities. */
  tenantName?: string | null;
  visibilityLevel?: string;
  performingUserRole?: string;
}

interface MasterUserCreatedPayload {
  masterUserId: string;
  masterName: string;
  masterEmail: string;
  actorUserId: string;
}

interface MasterUserWelcomedPayload {
  masterUserId: string;
  performingUserName: string;
  performingUserEmail: string;
}

interface MasterUserUpdatedPayload {
  masterUserId: string;
  masterName: string;
  beforeName: string;
  changesNotificationText: string;
  changesActivityText: string;
  actorUserId: string;
  performingUserName: string;
  performingUserEmail: string;
}

interface MasterUserAccountUpdatedPayload {
  masterUserId: string;
  masterName: string;
  changesNotificationText: string;
  performingUserName: string;
  performingUserEmail: string;
}

/**
 * A company's plan changed. `actor` is captured in the payload because the
 * render must name who did it even if that account is edited — or deleted —
 * before the delivery runs.
 */
interface BusinessModuleChangedPayload {
  businessId: string;
  businessName: string;
  module: string;
  enabled: boolean;
  previousEnabled: boolean;
  actor: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

interface BusinessLimitChangedPayload {
  businessId: string;
  businessName: string;
  /** "vehicle" (contracted fleet size) or "ai" (monthly analysis quota). */
  limit: "vehicle" | "ai";
  previousValue: number;
  newValue: number;
  actor: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

interface DeliveryOccurrenceReportedPayload {
  deliveryId: string;
  businessId: string;
  recipientName: string;
  occurrenceTypeName: string;
  blocksDelivery: boolean;
  description: string | null;
  photosCount: number;
  reporterName: string;
  /** pt-BR label of the status after the occurrence (e.g. "Insucesso"). */
  deliveryStatusAfter: string;
}

/**
 * A driver's report waits for the tower (decision 6.3): the operators must
 * read it and decide while the driver waits at the address. The answers go
 * already labelled and formatted, so the notice reads the form as it was.
 */
interface DeliveryOccurrenceAuthorizationRequestedPayload {
  occurrenceId: string;
  deliveryId: string;
  businessId: string;
  recipientName: string;
  occurrenceTypeName: string;
  blocksDelivery: boolean;
  description: string | null;
  reporterName: string;
  /**
   * A driver waiting at the address (true), or a request filed from the
   * panel by a profile that cannot decide it (false). Absent on rows written
   * before the field existed, which were all drivers'.
   */
  fromDriver?: boolean;
  photosCount: number;
  /** The form's answers, in the form's order: "Rótulo: valor". */
  answers: Array<{ label: string; value: string }>;
  /** ISO — when the tower was asked. */
  requestedAt: string;
  /**
   * Decision 14.3: DELIVERED asks to PROVE the delivery ("Entrega aguardando
   * autorização"). Absent on rows queued before it existed: NOT_DELIVERED.
   */
  category?: "DELIVERED" | "NOT_DELIVERED";
}

/** Nobody decided within the window: the company's administrators hear it. */
interface DeliveryOccurrenceAuthorizationEscalatedPayload
  extends DeliveryOccurrenceAuthorizationRequestedPayload {
  /** Whole minutes the request had waited when it was escalated. */
  waitingMinutes: number;
}

/** The tower's answer, for the driver who asked (push, mandatory). */
interface DeliveryOccurrenceAuthorizationDecidedPayload {
  occurrenceId: string;
  deliveryId: string;
  businessId: string;

  /** The reporter's user — the driver waiting for the answer. */
  driverUserId: string | null;

  recipientName: string;
  occurrenceTypeName: string;
  decision: "APPROVED" | "DENIED";

  /** Why (required on a denial). */
  note: string | null;

  deciderName: string;

  /** pt-BR label of the delivery's status after the decision. */
  deliveryStatusAfter: string;

  /**
   * The same status as its code (FAILED, IN_TRANSIT...), for the app to tell
   * an approval that ended the delivery from one that keeps it open. Absent
   * on rows queued before it was published.
   */
  deliveryStatus?: string;

  /** Decision 14.3: "Entrega autorizada" vs "Ocorrência autorizada". Absent: NOT_DELIVERED. */
  category?: "DELIVERED" | "NOT_DELIVERED";

  /** The occurrence's support ticket, closed by this decision (design §5.4). */
  ticketId?: string | null;
}

/**
 * A SAC message headed for a driver whose app may be closed. Push-only on
 * purpose: a conversation is not a notice board — it must reach the phone's
 * tray, but a row per message in the notifications feed would bury the
 * feed's real content. The chat screen itself is the in-app surface.
 */
interface ChatMessageSentPayload {
  messageId: string;
  threadId: string;
  businessId: string;

  /** The driver's user — the one recipient of the push. */
  recipientUserId: string;

  senderName: string;

  /** TEXT | IMAGE | AUDIO — decides the tray line when there is no body. */
  kind: string;

  /** First characters of the text (or caption), already trimmed. */
  bodyPreview: string | null;

  /**
   * The support ticket the message landed in (decision 14.5), so the tap
   * opens the chat on that subject. Absent on a mass notice and on rows
   * queued before tickets existed.
   */
  ticketId?: string;
  ticketNumber?: number;
  ticketSubject?: string;
}

/**
 * The two route events that have somebody to tell.
 *
 * Deliberately two and not four. A departure and a completion are facts the
 * dispatcher's board already shows, and turning each into a notification means
 * a company with thirty drivers gets sixty bells a day for things nobody has
 * to act on — the activity trail records them, which is what a fact without an
 * action is for. What a driver DOES have to act on is work arriving and work
 * being called off, and neither of those is visible to someone whose phone is
 * in their pocket.
 */
interface RouteReleasedPayload {
  routeId: string;
  businessId: string;

  /**
   * The user linked to the route's driver, captured when the event happened.
   * Null when the driver has no login yet — a real case in operations that
   * register drivers before handing out phones, and one that must resolve to
   * "nobody to tell" rather than to an error in the pipeline.
   */
  driverUserId: string | null;
  code: number;
  routeName: string | null;
  stopCount: number;

  /** The day the route is for, already formatted for the phone. */
  scheduledLabel: string;
}

/**
 * The dispatcher changed the stops of a route already released to the driver
 * (decision 14.7, design §7.2). One per plan version: the event key is
 * route:{routeId}:plan:{planVersion}.
 */
interface RoutePlanChangedPayload {
  routeId: string;
  businessId: string;

  /** Null means there is nobody to tell. */
  driverUserId: string | null;
  code: number;
  planVersion: number;
}

interface RouteCancelledPayload {
  routeId: string;
  businessId: string;

  /** Same as above: null means there is nobody to tell. */
  driverUserId: string | null;
  code: number;
  routeName: string | null;
  reason: string;

  /** True when the driver had already left with it — the urgent case. */
  hadDeparted: boolean;
}

/**
 * A dispatcher moved a delivery's status by hand, and it crossed the driver's
 * working list.
 *
 * Only crossings are published — see `driverShouldHearOverride`. A move within
 * the list changes nothing the driver can act on.
 */
interface DeliveryStatusOverriddenPayload {
  deliveryId: string;
  businessId: string;

  /** Null means there is nobody to tell. */
  driverUserId: string | null;

  recipientName: string;

  /** Street and city, so the driver recognises the stop without opening it. */
  addressLabel: string;

  fromLabel: string;
  toLabel: string;

  /** From the company's catalogue — always present on an override. */
  reason: string;

  /** What the operator typed at the moment of the change, when they typed. */
  note: string | null;

  /**
   * True when the delivery LEFT the working list — the urgent case, because
   * the driver may be on the way to an address that was just called off.
   */
  removedFromWorklist: boolean;
}

/**
 * What the person waiting for a delivery is told about, and nothing more.
 *
 * Carries the contact details rather than an id to look them up by, because
 * the policy has to be able to decide "there is nobody to tell" without a
 * query — and because an outbox row is a snapshot: a phone number corrected
 * after the message was queued should not silently redirect a message that
 * was already about to go.
 *
 * The carrier's NAME is deliberately absent. It is the same for every delivery
 * a company ever makes and changes almost never, so putting it here would be
 * copying one constant into a million rows; the policy reads it once when it
 * renders.
 */
interface DeliveryCustomerPayload {
  deliveryId: string;
  businessId: string;

  recipientName: string;
  recipientEmail: string | null;
  recipientTelephone: string | null;

  invoiceNumber: string | null;
  code: string | null;

  city: string;
  uf: string;

  scheduledDate: Date | string | null;
  deliveredAt: Date | string | null;
  receivedBy: string | null;
}

/**
 * Our breaker, a 410 or a destination refused for good switched a customer's
 * webhook endpoint off. Its events are being held, not lost, and somebody at
 * the company has to know — it used to happen in silence.
 */
interface WebhookEndpointDisabledPayload {
  businessId: string;
  endpointId: string;
  endpointName: string;
  url: string;

  /** A full sentence, in pt-BR, as the monitor shows it. */
  reason: string;

  disabledAt: string;
}

interface TopicPayloadMap {
  "fine.created": FineCreatedPayload;
  "vehicle-checklist.created": VehicleChecklistCreatedPayload;
  "fuel.created": FuelCreatedPayload;
  "ai-verification.issue": AIVerificationIssuePayload;
  "service-order.created": ServiceOrderCreatedPayload;
  "service-order.updated": ServiceOrderUpdatedPayload;
  "account-payable.created": AccountPayableCreatedPayload;
  "account-payable.updated": AccountPayableUpdatedPayload;
  "kanban-card.created": KanbanCardCreatedPayload;
  "kanban-card.updated": KanbanCardUpdatedPayload;
  "activity.recorded": ActivityRecordedPayload;
  "master-user.created": MasterUserCreatedPayload;
  "master-user.welcomed": MasterUserWelcomedPayload;
  "master-user.updated": MasterUserUpdatedPayload;
  "master-user.account-updated": MasterUserAccountUpdatedPayload;
  "business-module.changed": BusinessModuleChangedPayload;
  "delivery-occurrence.reported": DeliveryOccurrenceReportedPayload;
  // Decision 6.3: the tower's authorization of a driver's report.
  "delivery-occurrence.authorization_requested": DeliveryOccurrenceAuthorizationRequestedPayload;
  "delivery-occurrence.authorization_escalated": DeliveryOccurrenceAuthorizationEscalatedPayload;
  "delivery-occurrence.authorization_decided": DeliveryOccurrenceAuthorizationDecidedPayload;
  "business-limit.changed": BusinessLimitChangedPayload;
  "chat-message.sent": ChatMessageSentPayload;
  "route.released": RouteReleasedPayload;
  "route.cancelled": RouteCancelledPayload;
  "route.plan_changed": RoutePlanChangedPayload;
  "delivery.status_overridden": DeliveryStatusOverriddenPayload;

  // The three moments a carrier tells the person waiting for their delivery.
  "delivery.dispatched": DeliveryCustomerPayload;
  // The driver is heading to this address now (decision 6.4).
  "delivery.on_the_way": DeliveryCustomerPayload;
  "delivery.delivered": DeliveryCustomerPayload;
  "delivery.failed": DeliveryCustomerPayload;

  "webhook-endpoint.disabled": WebhookEndpointDisabledPayload;

  // The driver hears that the receipt they sent looks wrong (decision 6.9).
  "delivery-proof.ai-flagged": DeliveryProofAIFlaggedPayload;
}

type NotificationTopic = keyof TopicPayloadMap;

interface RenderContext {
  /** Front-end base URL for in-app/email links. */
  baseUrl: string;
}

/**
 * Who is being rendered for. Links are role-dependent — a driver opens
 * `/driver/...`, an admin opens `/dashboard/...` — so a render can't always
 * be computed from the payload alone.
 */
interface RecipientRenderContext {
  id: string;
  role?: string;
  driverId?: string | null;
}

interface RenderedInApp {
  type: string;
  title: string;
  message: string;
  link: string;
  entityId: string;
}

interface RenderedActivity {
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;

  /** Hierarchical visibility fields used by MASTER-level activities. */
  tenantName?: string | null;
  visibilityLevel?: string;
  performingUserRole?: string;
}

interface RenderedPush {
  title: string;
  body: string;

  /** Rides to the app on tap — e.g. { url: "/chat" } to open a screen. */
  data?: Record<string, unknown>;
}

/**
 * Somebody a notification reaches who has no account.
 *
 * Deliberately not shaped like a `User`: no role, no permissions, no
 * preferences, no in-app inbox. Only the two ways to reach them and the token
 * that identifies their link.
 */
interface ExternalRecipient {
  id: string;

  name: string | null;
  email: string | null;
  telephone: string | null;

  access_token: string;

  opted_out_at: Date | string | null;
}

/**
 * What a company says to the person waiting for a delivery, already rendered.
 *
 * The voice is the company's, not the product's: a carrier that addresses
 * "prezado cliente" and one that uses the shipper's brand are both right, and
 * a single hard-coded sentence would make Trajetto speak over them.
 */
interface RenderedExternalMessage {
  subject: string;
  body: string;

  /** Where the message sends them. Their tracking page, not our dashboard. */
  link: string;
}

interface PolicyDeps {
  userRepository: IUserRepository;

  /**
   * Only the policies that address outsiders ever touch these, which is why
   * they are optional: eighteen existing policies neither know nor care that
   * the pipeline learnt to reach people without accounts.
   */
  externalRecipientRepository?: unknown;
  messageTemplateRepository?: unknown;
  businessRepository?: unknown;

  /**
   * The tower's requests (decision 6.3): whether one still waits, so a
   * notice about a request already decided or superseded is not sent.
   */
  occurrenceAuthorizationRepository?: unknown;
}

/**
 * What the system does when a topic fires: who hears about it and what each
 * channel says. Adding a notification to the product = adding an entry to
 * the policy registry — use cases only publish events.
 *
 * Render functions are pure over the payload so they can be unit-tested
 * without a database or a running pipeline.
 */
interface NotificationPolicyEntry<TPayload> {
  resolveRecipients(payload: TPayload, deps: PolicyDeps): Promise<User[]>;

  /**
   * People with no account who must hear about this. Optional, and absent on
   * every internal topic.
   *
   * Separate from `resolveRecipients` rather than widening its return type,
   * because the two are governed by different rules end to end: a User has
   * preferences, an in-app inbox, a push device and a role that shapes the
   * link; an outsider has a phone number and a way to say stop. Merging them
   * would have meant a null check at every one of those points.
   */
  resolveExternalRecipients?(
    payload: TPayload,
    deps: PolicyDeps,
  ): Promise<ExternalRecipient[]>;

  /**
   * What the outsider is told, in the company's own words.
   *
   * Async because the template is the company's and lives in a table. Returns
   * null when the company has no active template for this moment and channel —
   * which is a decision, not a failure: a carrier that has not written the
   * "saiu para entrega" message does not want one sent.
   */
  renderExternal?(
    payload: TPayload,
    recipient: ExternalRecipient,
    deps: PolicyDeps,
    channel: string,
  ): Promise<RenderedExternalMessage | null>;

  /**
   * Why this message is no longer worth sending, or null to send it. Asked
   * on EVERY attempt, right before the send, of an outsider's message and of
   * a user's e-mail, WhatsApp or push (never the in-app row, the inbox's
   * record): the three customer messages are separate events retried on
   * their own schedules, so a "saiu para entrega" in backoff could otherwise
   * land after the "entregue" that followed it; a tower request decided
   * while its rows waited must not ring an operator. A reason fails the row
   * as non-retryable, with the reason as its lastError — the same way an
   * opt-out does.
   */
  supersededReason?(payload: TPayload, deps: PolicyDeps): Promise<string | null>;

  /**
   * Which preference row governs this topic. The recipient's per-category
   * choices (or, without a row, their legacy global toggles) decide the
   * channels.
   */
  category: NotificationCategory;

  /**
   * Delivered in-app no matter what the preferences say. Reserved for events
   * the user must see — their account changed, their access was created.
   * Preferences control noise, not critical notices.
   */
  mandatory?: boolean;

  /**
   * Blocks the e-mail channel for topics whose in-app content should not
   * also land in the inbox — e.g. a welcome note whose real content (the
   * credentials) already went out as a dedicated e-mail.
   */
  suppressEmail?: boolean;

  /**
   * Absent = this topic notifies nobody in-app (an activity-only event).
   * Also reused as the e-mail subject/body/link, as the old flow did.
   * Renders that don't vary per recipient simply ignore the third argument.
   */
  renderInApp?(
    payload: TPayload,
    ctx: RenderContext,
    recipient: RecipientRenderContext,
  ): RenderedInApp;

  /** Absent = this topic never sends WhatsApp. */
  renderWhatsApp?(payload: TPayload): string;

  /** Absent = no activity trail entry. Recorded once, for the actor. */
  renderActivity?(payload: TPayload): RenderedActivity;

  /**
   * Standalone push content. Push normally follows the in-app render (it is
   * in-app, on the phone's tray) — this hook exists for push-only topics
   * like chat, whose in-app surface is their own screen rather than a
   * notification row. When present, PUSH deliveries exist even without
   * renderInApp and this render wins over the in-app fallback.
   */
  renderPush?(payload: TPayload, recipient: RecipientRenderContext): RenderedPush;
}

export type {
  DeliveryCustomerPayload,
  ExternalRecipient,
  RenderedExternalMessage,
  RouteReleasedPayload,
  DeliveryStatusOverriddenPayload,
  RouteCancelledPayload,
  RoutePlanChangedPayload,
  FineCreatedPayload,
  VehicleChecklistCreatedPayload,
  FuelCreatedPayload,
  AIVerificationIssuePayload,
  DeliveryProofAIFlaggedPayload,
  ServiceOrderCreatedPayload,
  ServiceOrderUpdatedPayload,
  AccountPayableCreatedPayload,
  AccountPayableUpdatedPayload,
  KanbanCardCreatedPayload,
  KanbanCardUpdatedPayload,
  ActivityRecordedPayload,
  MasterUserCreatedPayload,
  MasterUserWelcomedPayload,
  MasterUserUpdatedPayload,
  MasterUserAccountUpdatedPayload,
  BusinessModuleChangedPayload,
  BusinessLimitChangedPayload,
  TopicPayloadMap,
  DeliveryOccurrenceReportedPayload,
  DeliveryOccurrenceAuthorizationRequestedPayload,
  DeliveryOccurrenceAuthorizationEscalatedPayload,
  DeliveryOccurrenceAuthorizationDecidedPayload,
  ChatMessageSentPayload,
  NotificationTopic,
  RenderContext,
  RecipientRenderContext,
  RenderedInApp,
  RenderedActivity,
  RenderedPush,
  PolicyDeps,
  NotificationPolicyEntry,
  WebhookEndpointDisabledPayload,
};

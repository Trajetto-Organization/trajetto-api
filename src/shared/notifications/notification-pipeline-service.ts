import { resolve } from "node:path";

import { NotificationChannel, Prisma } from "@prisma/client";
import { container } from "tsyringe";

import database from "@/../infra/database";
import { env } from "@/env";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { sendNotificationToUser } from "@/websocket";

import { IMailProvider } from "@/shared/providers/mail-provider/IMail-provider";
import { MailDeliveryError } from "@/shared/providers/mail-provider/errors/mail-delivery-error";

import { getNotificationPolicy } from "./notification-policy";
import { sendExpoPushMessages } from "./push-provider";
import {
  NotificationPolicyEntry,
  NotificationTopic,
  TopicPayloadMap,
} from "./notification-types";

import {
  DELIVERY_CONCURRENCY,
  DELIVERY_LEASE_SECONDS,
  DELIVERY_RETRY_DELAYS_MS,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_RETRY_DELAYS_MS,
  PER_DELIVERY_TIMEOUT_MS,
  assertDeliveryLeaseInvariant,
  channelsForRecipient,
  nextRetryDelayMs,
  resolveRecipientChannelFlags,
  withRetryJitter,
} from "./pipeline-rules";

/**
 * The interval is a background sweep, not the primary trigger: publishing an
 * event calls `wake()` and gets processed within milliseconds. The sweep only
 * exists for what a wake can't cover — scheduled retries, leases orphaned by
 * a dead replica, and events published by another replica — so it can be
 * slow, keeping idle instances (and dev query logs) quiet.
 */
const SWEEP_INTERVAL_MS = 30_000;

const OUTBOX_BATCH_SIZE = 10;
const DELIVERY_BATCH_SIZE = 20;

// Fails at import time if batch/concurrency/timeout ever outgrow the lease.
// Silently breaking this invariant means a second replica reclaiming rows
// that are still being sent - a duplicate WhatsApp, not a slow one.
assertDeliveryLeaseInvariant(DELIVERY_BATCH_SIZE);

/** The e-mail body the pipeline renders for every channel EMAIL delivery. */
const NOTIFICATION_TEMPLATE_MODULE = "notification";
const NOTIFICATION_TEMPLATE_FILE = "notification.hbs";

type AnyPolicy = NotificationPolicyEntry<TopicPayloadMap[NotificationTopic]>;
type AnyPayload = TopicPayloadMap[NotificationTopic];

interface ClaimedEvent {
  id: string;
  topic: string;
  payload: unknown;
  businessId: string | null;
  actorId: string | null;
  attempts: number;
}

interface ClaimedDelivery {
  id: string;
  outboxEventId: string;
  userId: string;
  channel: NotificationChannel;
  attempts: number;
}

/** The slice of an outbox row a delivery needs to render itself. */
interface ClaimedEventRow {
  topic: string;
  payload: unknown;
  businessId: string | null;
}

/**
 * What `findUserById` gives the channels. Kept structural (instead of the
 * Prisma model) so the cache does not pin this file to the shape of the
 * user repository.
 */
type RecipientUser = NonNullable<
  Awaited<ReturnType<IUserRepository["findUserById"]>>
>;

/** A failure that retrying can never fix (recipient deleted, no policy). */
class NonRetryableDeliveryError extends Error {}

/**
 * Consumes the transactional outbox and executes notification deliveries.
 *
 * Runs inside every API replica. Coordination is entirely in Postgres: each
 * claim is an UPDATE over a `FOR UPDATE SKIP LOCKED` subselect that also
 * takes over rows whose lease expired — so N replicas never process the same
 * row twice, and a replica dying mid-batch only delays its rows by one lease.
 * Retries are persisted (`availableAt` + backoff), never held in memory.
 */
class NotificationPipelineService {
  private static instance: NotificationPipelineService;

  private outboxTimer: NodeJS.Timeout | null = null;
  private deliveryTimer: NodeJS.Timeout | null = null;

  private outboxRunning = false;
  private deliveryRunning = false;

  /**
   * Recipients looked up during the batch in flight, keyed by user id.
   *
   * One event fans out to the same person across in-app, e-mail, WhatsApp
   * and push - four deliveries that used to cost four multi-join user
   * queries. The map is per batch (set on claim, cleared in `finally`) and
   * safe because `deliveryRunning` already guarantees a single batch per
   * replica at a time. Promises are cached, not values, so concurrent
   * workers share one in-flight lookup instead of racing three more.
   */
  private recipientCache: Map<string, Promise<RecipientUser>> | null = null;

  private constructor() {}

  public static getInstance(): NotificationPipelineService {
    if (!NotificationPipelineService.instance) {
      NotificationPipelineService.instance = new NotificationPipelineService();
    }

    return NotificationPipelineService.instance;
  }

  public async initialize(): Promise<void> {
    this.outboxTimer = setInterval(() => {
      this.runOutboxCycle().catch((error) => {
        console.error("[NotificationPipeline] Outbox cycle error:", error);
      });
    }, SWEEP_INTERVAL_MS);

    this.deliveryTimer = setInterval(() => {
      this.runDeliveryCycle().catch((error) => {
        console.error("[NotificationPipeline] Delivery cycle error:", error);
      });
    }, SWEEP_INTERVAL_MS);

    // Drain whatever accumulated while the API was down (or is owed a retry)
    // now, instead of making the first sweep wait a full interval.
    this.wake();

    console.log("[NotificationPipeline] Pipeline de notificações iniciado");
  }

  /**
   * Processes pending work now instead of waiting for the sweep. Called right
   * after an outbox publish commits; expansion chains into a delivery cycle,
   * so a freshly created fine notifies within milliseconds. Safe to call at
   * any time — cycles are reentrancy-guarded and idempotent.
   */
  public wake(): void {
    this.runOutboxCycle()
      .then((expandedAny) => {
        if (expandedAny) return this.runDeliveryCycle();
      })
      .catch((error) => {
        console.error("[NotificationPipeline] Wake error:", error);
      });
  }

  public async shutdown(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);

    this.outboxTimer = null;
    this.deliveryTimer = null;

    // Let an in-flight cycle finish; leases cover anything interrupted.
    const deadline = Date.now() + 10_000;

    while (
      (this.outboxRunning || this.deliveryRunning) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[NotificationPipeline] Pipeline de notificações encerrado");
  }

  // ==========================================================================
  // Outbox: event → deliveries
  // ==========================================================================

  private async runOutboxCycle(): Promise<boolean> {
    if (this.outboxRunning) return false;
    this.outboxRunning = true;

    let processedAny = false;

    try {
      // Drain: a full batch means there is probably more behind it.
      for (;;) {
        const events = await this.claimEvents();
        processedAny = processedAny || events.length > 0;

        for (const event of events) {
          try {
            await this.expandEvent(event);
          } catch (error) {
            await this.recordEventFailure(event, error);
          }
        }

        if (events.length < OUTBOX_BATCH_SIZE) break;
      }
    } finally {
      this.outboxRunning = false;
    }

    return processedAny;
  }

  private async claimEvents(): Promise<ClaimedEvent[]> {
    return database.$queryRaw<ClaimedEvent[]>`
      UPDATE "domain_outbox_event" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "domain_outbox_event"
        WHERE ("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now())
        ORDER BY "created_at"
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "topic", "payload", "businessId", "actorId", "attempts"
    `;
  }

  private async expandEvent(event: ClaimedEvent): Promise<void> {
    const policy = getNotificationPolicy(event.topic);

    if (!policy) {
      await database.domainOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "FAILED",
          lastError: `No notification policy registered for topic "${event.topic}"`,
        },
      });

      return;
    }

    const payload = event.payload as AnyPayload;

    const userRepository =
      container.resolve<IUserRepository>("UserRepository");

    const recipients = await policy.resolveRecipients(payload, {
      userRepository,
    });

    // Per-category choices, fetched in one query for the whole batch. A user
    // without a row falls back to their legacy global toggles.
    const preferences = recipients.length
      ? await database.notificationPreference.findMany({
          where: {
            category: policy.category,
            userId: { in: recipients.map((recipient) => recipient.id) },
          },
        })
      : [];

    const preferenceByUser = new Map(
      preferences.map((preference) => [preference.userId, preference]),
    );

    // Who has a registered mobile device — a PUSH delivery only exists for
    // them, so web-only users never accumulate dead push rows.
    const pushOwners = recipients.length
      ? new Set(
          (
            await database.pushDeviceToken.findMany({
              where: {
                userId: { in: recipients.map((recipient) => recipient.id) },
              },
              select: { userId: true },
            })
          ).map((row) => row.userId),
        )
      : new Set<string>();

    const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];

    for (const recipient of recipients) {
      const channels = channelsForRecipient(
        resolveRecipientChannelFlags(
          recipient,
          preferenceByUser.get(recipient.id),
        ),
        {
          hasInAppContent: Boolean(policy.renderInApp),
          hasEmailContent: Boolean(policy.renderInApp) && !policy.suppressEmail,
          hasWhatsAppContent: Boolean(policy.renderWhatsApp),
          isMandatory: Boolean(policy.mandatory),
          hasPushDevice: pushOwners.has(recipient.id),
          hasStandalonePushContent: Boolean(policy.renderPush),
        },
      );

      for (const channel of channels) {
        rows.push({ outboxEventId: event.id, userId: recipient.id, channel });
      }
    }

    // The activity trail entry is one delivery for the actor, so it rides the
    // same idempotency: the old flow created it once per recipient, stamping
    // duplicate activities whenever more than one admin was notified.
    if (policy.renderActivity && event.actorId) {
      rows.push({
        outboxEventId: event.id,
        userId: event.actorId,
        channel: NotificationChannel.ACTIVITY,
      });
    }

    // skipDuplicates + the (event, user, channel) unique key make a re-run
    // after a crash a no-op instead of a second batch of notifications.
    await database.$transaction([
      database.notificationDelivery.createMany({
        data: rows,
        skipDuplicates: true,
      }),
      database.domainOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "PUBLISHED",
          processedAt: new Date(),
          lastError: null,
        },
      }),
    ]);
  }

  private async recordEventFailure(
    event: ClaimedEvent,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    const baseDelay = nextRetryDelayMs(event.attempts, OUTBOX_RETRY_DELAYS_MS);
    const delay = baseDelay === null ? null : withRetryJitter(baseDelay);

    console.error(
      `[NotificationPipeline] Falha ao expandir evento ${event.id} (tentativa ${event.attempts}):`,
      message,
    );

    await database.domainOutboxEvent
      .update({
        where: { id: event.id },
        data:
          delay === null
            ? { status: "FAILED", lastError: message }
            : {
                status: "PENDING",
                availableAt: new Date(Date.now() + delay),
                lastError: message,
              },
      })
      .catch((updateError) => {
        // The lease recovers the row if even this update fails.
        console.error(
          `[NotificationPipeline] Falha ao registrar erro do evento ${event.id}:`,
          updateError,
        );
      });
  }

  // ==========================================================================
  // Deliveries: one row = one recipient × one channel
  // ==========================================================================

  private async runDeliveryCycle(): Promise<void> {
    if (this.deliveryRunning) return;
    this.deliveryRunning = true;

    try {
      // Drain: a full batch means there is probably more behind it.
      for (;;) {
        const deliveries = await this.claimDeliveries();
        if (deliveries.length === 0) return;

        const events = await database.domainOutboxEvent.findMany({
          where: { id: { in: deliveries.map((d) => d.outboxEventId) } },
        });

        const eventsById = new Map(events.map((event) => [event.id, event]));

        this.recipientCache = new Map();

        try {
          // Bounded concurrency instead of one-at-a-time: a batch used to
          // cost the SUM of every provider round-trip, so one slow WhatsApp
          // held the in-app notifications behind it. A shared cursor (rather
          // than fixed slices) keeps every worker busy when the durations
          // are uneven, which across channels they always are.
          let cursor = 0;

          const worker = async (): Promise<void> => {
            while (cursor < deliveries.length) {
              const delivery = deliveries[cursor++];

              await this.runOneDelivery(delivery, eventsById);
            }
          };

          await Promise.all(
            Array.from(
              { length: Math.min(DELIVERY_CONCURRENCY, deliveries.length) },
              worker,
            ),
          );
        } finally {
          this.recipientCache = null;
        }

        if (deliveries.length < DELIVERY_BATCH_SIZE) break;
      }
    } finally {
      this.deliveryRunning = false;
    }
  }

  /**
   * One delivery, start to finish, never throwing: a failure here is a row
   * update, not an exception that would abort its sibling workers.
   */
  private async runOneDelivery(
    delivery: ClaimedDelivery,
    eventsById: Map<string, ClaimedEventRow>,
  ): Promise<void> {
    try {
      const event = eventsById.get(delivery.outboxEventId);

      if (!event) {
        throw new NonRetryableDeliveryError("Outbox event no longer exists");
      }

      await this.withDeliveryTimeout(
        this.executeDelivery(delivery, {
          topic: event.topic,
          payload: event.payload as unknown as AnyPayload,
          businessId: event.businessId,
        }),
        `${delivery.channel} delivery ${delivery.id}`,
      );

      await database.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      await this.recordDeliveryFailure(delivery, error);
    }
  }

  /**
   * Stops WAITING on a delivery that overran its budget - it cannot cancel
   * the work already in flight (each provider owns its own request timeout),
   * but it keeps one hung await from holding the row past its lease, which
   * is what would let another replica send the same message again.
   */
  private async withDeliveryTimeout<T>(
    work: Promise<T>,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${label} excedeu ${PER_DELIVERY_TIMEOUT_MS}ms e foi abandonada`,
                ),
              ),
            PER_DELIVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async claimDeliveries(): Promise<ClaimedDelivery[]> {
    return database.$queryRaw<ClaimedDelivery[]>`
      UPDATE "notification_delivery" SET
        "status" = 'PROCESSING',
        "leaseExpiresAt" = now() + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "notification_delivery"
        WHERE ("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now())
        ORDER BY "created_at"
        LIMIT ${DELIVERY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "outboxEventId", "userId", "channel", "attempts"
    `;
  }

  private async executeDelivery(
    delivery: ClaimedDelivery,
    event: {
      topic: string;
      payload: AnyPayload;
      businessId: string | null;
    },
  ): Promise<void> {
    const policy = getNotificationPolicy(event.topic) as AnyPolicy | null;

    if (!policy) {
      throw new NonRetryableDeliveryError(
        `No notification policy registered for topic "${event.topic}"`,
      );
    }

    switch (delivery.channel) {
      case NotificationChannel.IN_APP:
        return this.deliverInApp(delivery, event.payload, policy, event);
      case NotificationChannel.EMAIL:
        return this.deliverEmail(delivery, event.payload, policy);
      case NotificationChannel.WHATSAPP:
        return this.deliverWhatsApp(delivery, event.payload, policy);
      case NotificationChannel.PUSH:
        return this.deliverPush(delivery, event.payload, policy);
      case NotificationChannel.ACTIVITY:
        return this.deliverActivity(delivery, event.payload, policy, event);
      default:
        throw new NonRetryableDeliveryError(
          `Unknown delivery channel "${delivery.channel}"`,
        );
    }
  }

  /**
   * System-tray push via Expo. A push-only topic (chat) renders through
   * `renderPush`; every other topic reuses the in-app render (push IS the
   * in-app message, on the phone's tray) and its data payload tells the app
   * to open the notifications screen on tap. Dead tokens reported by the
   * provider are pruned so they stop generating work.
   */
  private async deliverPush(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<void> {
    if (!policy.renderPush && !policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel PUSH for a topic without push or in-app content",
      );
    }

    const user = await this.findRecipient(delivery.userId);
    const recipient = { id: user.id, role: user.role, driverId: user.driverId };

    const content = policy.renderPush
      ? (() => {
          const rendered = policy.renderPush!(payload, recipient);

          return {
            title: rendered.title,
            body: rendered.body,
            data: rendered.data ?? { url: "/notifications" },
          };
        })()
      : (() => {
          const rendered = policy.renderInApp!(
            payload,
            { baseUrl: env.HTTP_REQUEST },
            recipient,
          );

          return {
            title: rendered.title,
            body: rendered.message,
            data: {
              url: "/notifications",
              link: rendered.link ?? null,
              type: rendered.type,
            },
          };
        })();

    const devices = await database.pushDeviceToken.findMany({
      where: { userId: delivery.userId },
    });

    if (devices.length === 0) {
      throw new NonRetryableDeliveryError(
        "Recipient no longer has a registered push device",
      );
    }

    const { deliveredAny, invalidTokens } = await sendExpoPushMessages(
      devices.map((device) => device.token),
      content,
    );

    if (invalidTokens.length > 0) {
      await database.pushDeviceToken
        .deleteMany({ where: { token: { in: invalidTokens } } })
        .catch(() => undefined);
    }

    if (!deliveredAny) {
      // Every device was dead: nothing left to push at, and retrying cannot
      // conjure a device back.
      if (invalidTokens.length === devices.length) {
        throw new NonRetryableDeliveryError(
          "Every push token of the recipient is no longer registered",
        );
      }

      throw new Error("Expo não aceitou nenhum ticket de push");
    }
  }

  private async deliverInApp(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    event: { businessId: string | null },
  ): Promise<void> {
    if (!policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel IN_APP for a topic without in-app content",
      );
    }

    const user = await this.findRecipient(delivery.userId);

    const rendered = policy.renderInApp(
      payload,
      { baseUrl: env.HTTP_REQUEST },
      { id: user.id, role: user.role, driverId: user.driverId },
    );

    try {
      const notification = await database.notification.create({
        data: {
          userId: delivery.userId,
          type: rendered.type,
          title: rendered.title,
          message: rendered.message,
          link: rendered.link,
          entityId: rendered.entityId,
          businessId: event.businessId,
          deliveryId: delivery.id,
        },
      });

      sendNotificationToUser(delivery.userId, {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        link: notification.link || undefined,
        read: notification.read,
        entityId: notification.entityId || undefined,
        businessId: notification.businessId,
        created_at: notification.created_at,
      });
    } catch (error) {
      // Unique deliveryId hit: a previous attempt already created the row
      // (crash before the DELIVERED mark). Done — and no duplicate emit.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }

      throw error;
    }
  }

  private async deliverEmail(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<void> {
    if (!policy.renderInApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel EMAIL for a topic without in-app content",
      );
    }

    const user = await this.findRecipient(delivery.userId);

    const rendered = policy.renderInApp(
      payload,
      { baseUrl: env.HTTP_REQUEST },
      { id: user.id, role: user.role, driverId: user.driverId },
    );

    const mailProvider = container.resolve<IMailProvider>("MailProvider");

    // Same path the deleted worker built: templates are read from `src`,
    // which the image ships, in every environment.
    const templatePath = resolve(
      process.cwd(),
      "src",
      "modules",
      NOTIFICATION_TEMPLATE_MODULE,
      "views",
      NOTIFICATION_TEMPLATE_FILE,
    );

    const [firstName] = user.name?.split(" ") ?? ["Usuario"];

    try {
      // Awaited on purpose: this row only becomes DELIVERED when the
      // transport actually accepted the message. Handing it to another queue
      // and reporting success is what made a failed e-mail invisible.
      await mailProvider.sendMail({
        to: user.email,
        subject: `Trajetto - ${rendered.title}`,
        path: templatePath,
        // The delivery id is unique per (event, recipient, channel), so it
        // is exactly the reference a mail provider needs to tell two
        // notifications apart - and to recognise our own retry.
        referenceId: delivery.id,
        variables: {
          name: firstName,
          year: new Date().getFullYear(),
          title: rendered.title,
          message: rendered.message,
          link: rendered.link || `${env.HTTP_REQUEST}/notifications`,
          logo: env.CLOUDINARY_LOGO_IMAGE,
        },
      });
    } catch (error) {
      // A permanent refusal (invalid recipient, bad credentials, missing
      // template) must not burn the retry budget.
      if (error instanceof MailDeliveryError && !error.retryable) {
        throw new NonRetryableDeliveryError(error.message);
      }

      throw error;
    }
  }

  private async deliverWhatsApp(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
  ): Promise<void> {
    if (!policy.renderWhatsApp) {
      throw new NonRetryableDeliveryError(
        "Delivery channel WHATSAPP for a topic without WhatsApp content",
      );
    }

    const user = await this.findRecipient(delivery.userId);

    if (!user.whatsapp_phone) {
      throw new NonRetryableDeliveryError(
        "Recipient no longer has a WhatsApp phone configured",
      );
    }

    const whatsAppProvider =
      container.resolve<IWhatsAppProvider>("WhatsAppProvider");

    const result = await whatsAppProvider.sendMessage({
      phoneNumber: user.whatsapp_phone,
      message: policy.renderWhatsApp(payload),
    });

    if (result.success) return;

    const reason = result.message || "Falha ao enviar WhatsApp";

    // The provider classifies Meta's answer: a rejected template or a number
    // without WhatsApp can never succeed, and retrying it four times only
    // spends the account quality rating. `retryable !== false` keeps the old
    // behaviour for anything the provider chose not to classify.
    if (result.retryable === false) {
      throw new NonRetryableDeliveryError(reason);
    }

    throw new Error(reason);
  }

  private async deliverActivity(
    delivery: ClaimedDelivery,
    payload: AnyPayload,
    policy: AnyPolicy,
    event: { businessId: string | null },
  ): Promise<void> {
    if (!policy.renderActivity) {
      throw new NonRetryableDeliveryError(
        "Delivery channel ACTIVITY for a topic without activity content",
      );
    }

    const rendered = policy.renderActivity(payload);

    // Same dynamic import the old NotificationService used — the activity
    // module imports shared services, so a static import here would cycle.
    const { CreateActivityUseCase } = await import(
      "@/modules/activity/usecases/create-activity/create-activity-usecase"
    );

    const createActivityUseCase = container.resolve(CreateActivityUseCase);

    await createActivityUseCase.execute({
      type: rendered.type,
      action: rendered.action,
      entityId: rendered.entityId,
      description: rendered.description,
      status: rendered.status,
      performedBy: delivery.userId,
      businessId: event.businessId,
      tenantName: rendered.tenantName,
      visibilityLevel: rendered.visibilityLevel,
      performingUserRole: rendered.performingUserRole,
    });
  }

  private async findRecipient(userId: string): Promise<RecipientUser> {
    const cached = this.recipientCache?.get(userId);
    if (cached) return cached;

    const lookup = (async (): Promise<RecipientUser> => {
      const userRepository =
        container.resolve<IUserRepository>("UserRepository");

      const user = await userRepository.findUserById(userId);

      if (!user) {
        throw new NonRetryableDeliveryError("Recipient user no longer exists");
      }

      return user;
    })();

    // Cached before the await so two workers on the same recipient share one
    // query. A rejected lookup is evicted: the next delivery of this batch
    // deserves a real attempt instead of a memoised failure.
    this.recipientCache?.set(userId, lookup);

    lookup.catch(() => this.recipientCache?.delete(userId));

    return lookup;
  }

  private async recordDeliveryFailure(
    delivery: ClaimedDelivery,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    const baseDelay =
      error instanceof NonRetryableDeliveryError
        ? null
        : nextRetryDelayMs(delivery.attempts, DELIVERY_RETRY_DELAYS_MS);

    // Jitter keeps a rate-limited batch from marching back in lockstep.
    const delay = baseDelay === null ? null : withRetryJitter(baseDelay);

    console.error(
      `[NotificationPipeline] Falha na entrega ${delivery.id} (${delivery.channel}, tentativa ${delivery.attempts}):`,
      message,
    );

    await database.notificationDelivery
      .update({
        where: { id: delivery.id },
        data:
          delay === null
            ? { status: "FAILED", lastError: message }
            : {
                status: "PENDING",
                availableAt: new Date(Date.now() + delay),
                lastError: message,
              },
      })
      .catch((updateError) => {
        console.error(
          `[NotificationPipeline] Falha ao registrar erro da entrega ${delivery.id}:`,
          updateError,
        );
      });
  }
}

export { NotificationPipelineService };

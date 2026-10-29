-- Service by ticket and the operations alert (decisions 14.5 and 14.6;
-- design: docs/desenho/tickets-de-atendimento.md §2 and §9.1). The expand step;
-- the backfill of the existing conversations is 20261005120600.
--
-- Expand-safe: new tables and enums are unknown to the serving image,
-- chat_message."ticketId" is nullable (a pre-ticket image keeps inserting
-- without it; the repair job routes those rows) and user.ops_alert_sound_enabled
-- has a default. The CHECK that every non-broadcast message has a ticket is
-- the CONTRACT step of the next release (design §9.4), not this one: it would
-- refuse the N-1 image's inserts.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "SupportTicketKind" AS ENUM ('OCCURRENCE', 'DELIVERY', 'ROUTE', 'DRIVER', 'LEGACY');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupportTicketOpenedVia" AS ENUM ('OCCURRENCE_REPORT', 'DRIVER_APP', 'PANEL', 'LEGACY_ROUTING', 'MIGRATION');
CREATE TYPE "SupportTicketOutcome" AS ENUM ('RESOLVED', 'APPROVED', 'DENIED', 'MIGRATED');
CREATE TYPE "SupportTicketEventType" AS ENUM ('OPENED', 'ASSIGNED', 'UNASSIGNED', 'CLOSED', 'REOPENED', 'OCCURRENCE_LINKED', 'AUTHORIZATION_DECIDED', 'AUTHORIZATION_SUPERSEDED');

-- ---------------------------------------------------------------------------
-- support_ticket
-- ---------------------------------------------------------------------------

CREATE TABLE "support_ticket" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "SupportTicketKind" NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "occurrenceId" TEXT,
    "routeId" TEXT,
    "opened_via" "SupportTicketOpenedVia" NOT NULL,
    "openedById" TEXT,
    "assigneeId" TEXT,
    "assigned_at" TIMESTAMP(3),
    "first_staff_reply_at" TIMESTAMP(3),
    "closedById" TEXT,
    "closed_at" TIMESTAMP(3),
    "close_outcome" "SupportTicketOutcome",
    "close_note" TEXT,
    "reopened_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "last_driver_message_at" TIMESTAMP(3),
    "last_staff_message_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "client_submission_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

-- "#128" per company; the create's Idempotency-Key per company; one ticket
-- per occurrence.
CREATE UNIQUE INDEX "support_ticket_businessId_number_key" ON "support_ticket"("businessId", "number");
CREATE UNIQUE INDEX "support_ticket_businessId_client_submission_id_key" ON "support_ticket"("businessId", "client_submission_id");
CREATE UNIQUE INDEX "support_ticket_occurrenceId_key" ON "support_ticket"("occurrenceId");

-- The list: one company's tickets by status, most recent conversation first.
CREATE INDEX "support_ticket_businessId_status_last_message_at_idx" ON "support_ticket"("businessId", "status", "last_message_at" DESC);
-- A thread's subjects (the driver's feed separators) and the CASCADE from it.
CREATE INDEX "support_ticket_threadId_created_at_idx" ON "support_ticket"("threadId", "created_at");
CREATE INDEX "support_ticket_driverId_idx" ON "support_ticket"("driverId");

-- Raw SQL: Prisma cannot declare a partial index (pinned in
-- tests/E2E/raw-sql-objects.test.ts; `migrate dev` will offer to drop them,
-- say no).
--
-- One OPEN ticket per delivery and per route: what makes get-or-create safe
-- across replicas (two openings at once converge on one ticket through
-- P2002 + re-read). An occurrence needs none: occurrenceId is unique.
CREATE UNIQUE INDEX "support_ticket_open_delivery_uq" ON "support_ticket" ("deliveryId")
  WHERE "status" = 'OPEN' AND "kind" = 'DELIVERY';
CREATE UNIQUE INDEX "support_ticket_open_route_uq" ON "support_ticket" ("routeId")
  WHERE "status" = 'OPEN' AND "kind" = 'ROUTE';

-- "Meus" and "Sem atendente", and the summary that feeds the alert balloon.
CREATE INDEX "support_ticket_open_assignee_idx" ON "support_ticket" ("assigneeId", "last_message_at" DESC)
  WHERE "status" = 'OPEN' AND "assigneeId" IS NOT NULL;
CREATE INDEX "support_ticket_open_unassigned_idx" ON "support_ticket" ("businessId", "created_at")
  WHERE "status" = 'OPEN' AND "assigneeId" IS NULL;

-- Sparse foreign keys: the tickets of one delivery or route, and the SET NULL
-- when the delivery, route or user goes.
CREATE INDEX "support_ticket_deliveryId_partial_idx" ON "support_ticket" ("deliveryId") WHERE "deliveryId" IS NOT NULL;
CREATE INDEX "support_ticket_routeId_partial_idx" ON "support_ticket" ("routeId") WHERE "routeId" IS NOT NULL;
CREATE INDEX "support_ticket_openedById_partial_idx" ON "support_ticket" ("openedById") WHERE "openedById" IS NOT NULL;
CREATE INDEX "support_ticket_assigneeId_partial_idx" ON "support_ticket" ("assigneeId") WHERE "assigneeId" IS NOT NULL;
CREATE INDEX "support_ticket_closedById_partial_idx" ON "support_ticket" ("closedById") WHERE "closedById" IS NOT NULL;

ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "chat_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, never CASCADE: reversing an import removes deliveries and routes,
-- and the conversation is a record that must outlive them.
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "delivery_occurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- support_ticket_event: the immutable trail
-- ---------------------------------------------------------------------------

CREATE TABLE "support_ticket_event" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" "SupportTicketEventType" NOT NULL,
    "actor_kind" "DeliveryEventActor" NOT NULL,
    "actorId" TEXT,
    "actor_name" TEXT,
    "target_user_id" TEXT,
    "target_user_name" TEXT,
    "outcome" "SupportTicketOutcome",
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_ticket_event_ticketId_created_at_idx" ON "support_ticket_event"("ticketId", "created_at");
CREATE INDEX "support_ticket_event_businessId_created_at_idx" ON "support_ticket_event"("businessId", "created_at" DESC);
-- The SET NULL when a user is removed (the snapshot name stays).
CREATE INDEX "support_ticket_event_actorId_partial_idx" ON "support_ticket_event" ("actorId") WHERE "actorId" IS NOT NULL;

ALTER TABLE "support_ticket_event" ADD CONSTRAINT "support_ticket_event_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_event" ADD CONSTRAINT "support_ticket_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- support_ticket_read: read cursor per ticket per participant
-- ---------------------------------------------------------------------------

CREATE TABLE "support_ticket_read" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_ticket_read_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "support_ticket_read_ticketId_userId_key" ON "support_ticket_read"("ticketId", "userId");
CREATE INDEX "support_ticket_read_userId_idx" ON "support_ticket_read"("userId");

ALTER TABLE "support_ticket_read" ADD CONSTRAINT "support_ticket_read_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_read" ADD CONSTRAINT "support_ticket_read_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- support_ticket_counter: "#N" per company
-- ---------------------------------------------------------------------------

-- INSERT ... ON CONFLICT ("businessId") DO UPDATE SET last_number =
-- last_number + 1 RETURNING last_number, inside the creating transaction.
CREATE TABLE "support_ticket_counter" (
    "businessId" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "support_ticket_counter_pkey" PRIMARY KEY ("businessId")
);

-- ---------------------------------------------------------------------------
-- chat_message."ticketId" and the alert sound preference
-- ---------------------------------------------------------------------------

ALTER TABLE "chat_message" ADD COLUMN "ticketId" TEXT;

-- A ticket's history in order and its unread count, filtering inside the
-- index like ("threadId", created_at, "senderId") does. Plain build: the
-- chat tables were created after the production baseline. On a large staging
-- database, build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and
-- this name; this statement then does nothing.
CREATE INDEX IF NOT EXISTS "chat_message_ticketId_created_at_senderId_idx"
  ON "chat_message"("ticketId", "created_at", "senderId");

ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Decision 14.6: on by default (the meeting asked the occurrence to "explode
-- on the screen"; whoever does not want the sound turns it off).
ALTER TABLE "user" ADD COLUMN "ops_alert_sound_enabled" BOOLEAN NOT NULL DEFAULT true;

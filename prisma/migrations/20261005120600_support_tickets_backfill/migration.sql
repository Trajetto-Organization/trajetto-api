-- The existing conversations become tickets (decision 14.5; design:
-- docs/desenho/tickets-de-atendimento.md §9.2). Nothing is deleted and
-- nothing is invented: no message is guessed into a subject beyond what it
-- already says (its delivery and route marks stay on it, and the filters keep
-- working inside the LEGACY ticket).
--
--   1. one LEGACY ticket per chat_thread that has a non-broadcast message;
--   2. every non-broadcast message joins its thread's LEGACY ticket;
--   3. the thread read cursors are copied to the LEGACY ticket (no false
--      unread counts);
--   4. every PENDING authorization request whose delivery has a driver gets an
--      OPEN OCCURRENCE ticket (a request with no driver stays decidable from
--      the tower's queue, with no ticket);
--   5. the per-company counter starts after the highest number;
--   6. the result is checked here, and the migration aborts on any mismatch.
--
-- Every step is idempotent (a re-run creates, moves and copies nothing).
-- Mass notices (broadcast_id) stay outside tickets: a notice is not service.
--
-- Volume: the chat module has not shipped (tables created after the
-- production baseline). On a database with real chat volume, measure first
-- (SELECT count(*) FROM chat_message; pg_relation_size('chat_message')); if
-- step 2 does not fit the deploy window, run it beforehand as a script, by
-- thread, WHERE "ticketId" IS NULL — the same statement.

-- A message written by a pre-ticket image while this runs would land with no
-- ticket after step 2 and fail check 6. Inserts wait for the backfill instead
-- (reads go on); the repair job routes whatever a pre-ticket image writes
-- afterwards (design §9.3).
LOCK TABLE "chat_message" IN SHARE ROW EXCLUSIVE MODE;

-- 1. The LEGACY ticket of each thread. Numbered per company in the order the
--    conversations began, after any number already taken. OPEN only when the
--    driver spoke last, less than 24 h ago (somebody is waiting for an answer
--    at deploy time; a product parameter, not a measurement); CLOSED as
--    MIGRATED otherwise, closed by nobody (the system). The driver's side is
--    the user linked to the thread's driver, as in the chat's unread count.
INSERT INTO "support_ticket"
  ("id", "number", "kind", "status", "subject", "businessId", "threadId", "driverId",
   "opened_via", "first_staff_reply_at", "closed_at", "close_outcome",
   "last_message_at", "last_driver_message_at", "last_staff_message_at",
   "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       COALESCE(taken.max_number, 0)
         + row_number() OVER (PARTITION BY t."businessId" ORDER BY s.first_at, t."id"),
       'LEGACY'::"SupportTicketKind",
       CASE WHEN s.waiting THEN 'OPEN' ELSE 'CLOSED' END::"SupportTicketStatus",
       'Conversa anterior aos atendimentos',
       t."businessId",
       t."id",
       t."driverId",
       'MIGRATION'::"SupportTicketOpenedVia",
       s.first_staff_at,
       CASE WHEN s.waiting THEN NULL ELSE now() END,
       CASE WHEN s.waiting THEN NULL ELSE 'MIGRATED' END::"SupportTicketOutcome",
       s.last_at,
       s.last_driver_at,
       s.last_staff_at,
       s.first_at,
       now()
  FROM "chat_thread" t
  JOIN (
    SELECT m."threadId",
           min(m."created_at") AS first_at,
           max(m."created_at") AS last_at,
           max(m."created_at") FILTER (WHERE m."senderId" = du."id") AS last_driver_at,
           max(m."created_at") FILTER (WHERE du."id" IS NULL OR m."senderId" <> du."id") AS last_staff_at,
           min(m."created_at") FILTER (WHERE du."id" IS NULL OR m."senderId" <> du."id") AS first_staff_at,
           (max(m."created_at") FILTER (WHERE m."senderId" = du."id")) = max(m."created_at")
             AND max(m."created_at") > now() - interval '24 hours' AS waiting
      FROM "chat_message" m
      JOIN "chat_thread" mt ON mt."id" = m."threadId"
      LEFT JOIN "user" du ON du."driverId" = mt."driverId"
     WHERE m."broadcast_id" IS NULL
     GROUP BY m."threadId"
  ) s ON s."threadId" = t."id"
  LEFT JOIN (
    SELECT "businessId", max("number") AS max_number
      FROM "support_ticket" GROUP BY "businessId"
  ) taken ON taken."businessId" = t."businessId"
 WHERE NOT EXISTS (
   SELECT 1 FROM "support_ticket" x
    WHERE x."threadId" = t."id" AND x."kind" = 'LEGACY');

-- Their trail: OPENED when the conversation began and, for the closed ones,
-- CLOSED as MIGRATED now. Both by the system.
INSERT INTO "support_ticket_event"
  ("id", "ticketId", "businessId", "type", "actor_kind", "created_at")
SELECT gen_random_uuid()::text, k."id", k."businessId",
       'OPENED'::"SupportTicketEventType", 'SYSTEM'::"DeliveryEventActor", k."created_at"
  FROM "support_ticket" k
 WHERE k."opened_via" = 'MIGRATION'
   AND NOT EXISTS (
     SELECT 1 FROM "support_ticket_event" e
      WHERE e."ticketId" = k."id" AND e."type" = 'OPENED');

INSERT INTO "support_ticket_event"
  ("id", "ticketId", "businessId", "type", "actor_kind", "outcome", "created_at")
SELECT gen_random_uuid()::text, k."id", k."businessId",
       'CLOSED'::"SupportTicketEventType", 'SYSTEM'::"DeliveryEventActor",
       'MIGRATED'::"SupportTicketOutcome", k."closed_at"
  FROM "support_ticket" k
 WHERE k."opened_via" = 'MIGRATION'
   AND k."close_outcome" = 'MIGRATED'
   AND NOT EXISTS (
     SELECT 1 FROM "support_ticket_event" e
      WHERE e."ticketId" = k."id" AND e."type" = 'CLOSED');

-- 2. Every non-broadcast message joins its thread's LEGACY ticket.
UPDATE "chat_message" m
   SET "ticketId" = k."id"
  FROM "support_ticket" k
 WHERE k."threadId" = m."threadId"
   AND k."kind" = 'LEGACY'
   AND m."broadcast_id" IS NULL
   AND m."ticketId" IS NULL;

-- 3. Each participant's thread cursor becomes their cursor on the LEGACY
--    ticket, at the same instant.
INSERT INTO "support_ticket_read"
  ("id", "ticketId", "userId", "last_read_at", "created_at", "updated_at")
SELECT gen_random_uuid()::text, k."id", r."userId", r."last_read_at", now(), now()
  FROM "chat_thread_read" r
  JOIN "support_ticket" k ON k."threadId" = r."threadId" AND k."kind" = 'LEGACY'
ON CONFLICT ("ticketId", "userId") DO NOTHING;

-- 4. The open authorization requests. Their driver's channel first (it may
--    never have had a message), then one OPEN OCCURRENCE ticket each, created
--    when the request was, numbered after everything above. Subject
--    "{type} — {recipient}", cut at 160 like the use case.
INSERT INTO "chat_thread" ("id", "businessId", "driverId", "created_at", "updated_at")
SELECT gen_random_uuid()::text, pending."businessId", pending."driverId", now(), now()
  FROM (
    SELECT DISTINCT o."businessId", d."driverId"
      FROM "delivery_occurrence" o
      JOIN "delivery" d ON d."id" = o."deliveryId"
     WHERE o."authorization_status" = 'PENDING'
       AND d."driverId" IS NOT NULL
  ) pending
ON CONFLICT ("businessId", "driverId") DO NOTHING;

INSERT INTO "support_ticket"
  ("id", "number", "kind", "status", "subject", "businessId", "threadId", "driverId",
   "deliveryId", "occurrenceId", "opened_via", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       COALESCE(taken.max_number, 0)
         + row_number() OVER (PARTITION BY o."businessId" ORDER BY o."created_at", o."id"),
       'OCCURRENCE'::"SupportTicketKind",
       'OPEN'::"SupportTicketStatus",
       left(ot."name" || ' — ' || d."recipient_name", 160),
       o."businessId",
       t."id",
       d."driverId",
       d."id",
       o."id",
       'MIGRATION'::"SupportTicketOpenedVia",
       o."created_at",
       now()
  FROM "delivery_occurrence" o
  JOIN "delivery" d ON d."id" = o."deliveryId"
  JOIN "occurrence_type" ot ON ot."id" = o."occurrenceTypeId"
  JOIN "chat_thread" t ON t."businessId" = o."businessId" AND t."driverId" = d."driverId"
  LEFT JOIN (
    SELECT "businessId", max("number") AS max_number
      FROM "support_ticket" GROUP BY "businessId"
  ) taken ON taken."businessId" = o."businessId"
 WHERE o."authorization_status" = 'PENDING'
   AND d."driverId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "support_ticket" x WHERE x."occurrenceId" = o."id");

INSERT INTO "support_ticket_event"
  ("id", "ticketId", "businessId", "type", "actor_kind", "created_at")
SELECT gen_random_uuid()::text, k."id", k."businessId",
       'OPENED'::"SupportTicketEventType", 'SYSTEM'::"DeliveryEventActor", k."created_at"
  FROM "support_ticket" k
 WHERE k."opened_via" = 'MIGRATION'
   AND NOT EXISTS (
     SELECT 1 FROM "support_ticket_event" e
      WHERE e."ticketId" = k."id" AND e."type" = 'OPENED');

-- 5. The counter continues from the highest number of each company.
INSERT INTO "support_ticket_counter" ("businessId", "last_number")
SELECT "businessId", max("number")
  FROM "support_ticket"
 GROUP BY "businessId"
ON CONFLICT ("businessId")
DO UPDATE SET "last_number" = GREATEST("support_ticket_counter"."last_number", EXCLUDED."last_number");

-- 6. Checked before anything commits.
DO $$
DECLARE
  problem TEXT;
BEGIN
  -- Every non-broadcast message has a ticket...
  SELECT string_agg(m."id", ', ') INTO problem
    FROM "chat_message" m
   WHERE m."ticketId" IS NULL AND m."broadcast_id" IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'mensagens sem ticket depois da migração: %', problem;
  END IF;

  -- ...on its own thread, so each thread keeps exactly its messages (the
  -- ones in its tickets plus its broadcasts).
  SELECT string_agg(m."id", ', ') INTO problem
    FROM "chat_message" m
    JOIN "support_ticket" k ON k."id" = m."ticketId"
   WHERE k."threadId" <> m."threadId";
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'mensagens em ticket de outra conversa: %', problem;
  END IF;

  -- Every pending request with a driver has its ticket.
  SELECT string_agg(o."id", ', ') INTO problem
    FROM "delivery_occurrence" o
    JOIN "delivery" d ON d."id" = o."deliveryId"
   WHERE o."authorization_status" = 'PENDING'
     AND d."driverId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "support_ticket" k WHERE k."occurrenceId" = o."id");
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'pedidos de autorização sem ticket: %', problem;
  END IF;

  -- The counter of each company is its highest number.
  SELECT string_agg(k."businessId", ', ') INTO problem
    FROM (SELECT "businessId", max("number") AS max_number
            FROM "support_ticket" GROUP BY "businessId") k
    LEFT JOIN "support_ticket_counter" c ON c."businessId" = k."businessId"
   WHERE c."last_number" IS DISTINCT FROM k.max_number;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'contador de tickets diferente do maior número: %', problem;
  END IF;
END $$;

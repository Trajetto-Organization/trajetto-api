-- The app's existing checklists become MOBILE_APP (owner's test of the driver
-- app, 05/11/2026: every checklist the app sent showed "Web" in the panel).
-- The column is the previous migration's
-- (20261105120000_vehicle_checklist_created_from), WEB_DASHBOARD on every row
-- until this runs; this marks the ones either signal says came from the app.
--
--   1. The activity trail recorded the creation as from the app. Since
--      20260914 (the notification pipeline) a created checklist is written to
--      "activity" as type 'Checklist Veicular', action 'create', "entityId" =
--      the checklist, with a description ending in ' | Origem: Aplicativo'
--      when the body said MOBILE_APP (vehicle-checklist-created-policy.ts).
--      Earlier entries name no origin, and the app build still in drivers'
--      hands (trajetto-mobile `main`, posting through the legacy multipart
--      adapter) never sends the field, so the trail says 'Origem: Web' for
--      its checklists: this signal alone misses them.
--   2. client_submission_id is set. Every app build since 10/08/2026 sends it
--      on every checklist, as a body field and as the Idempotency-Key header
--      the controller copies into it, the multipart build included, whoever
--      is logged in. No other client ever has: the web's checklist action
--      posts the form's fields and the photo keys, with no key and no
--      Idempotency-Key header (the panel's keys, IDEMP-14, cover fines,
--      bills, orders, deliveries, routes and chat, never checklists or
--      refuellings; checked in trajetto-ui's history too), and no API-key
--      route creates a checklist. From this release the API reads a new
--      checklist the same way (shared/vehicle/record-origin.ts).
--
-- What neither signal catches stays WEB_DASHBOARD, as it reads today: an app
-- checklist from a build older than 10/08/2026 whose trail entry predates the
-- origin. updated_at is left alone: the origin is how the row was always
-- made, not an edit, and moving it would list every app checklist as edited
-- at deploy time.
--
-- Idempotent (only WEB_DASHBOARD rows are touched): docs/deploy.md has it run
-- again by hand once this release serves, for the app checklists the previous
-- image wrote as WEB_DASHBOARD in between.
--
-- Locks and volume. Its own migration, so the ADD COLUMN's ACCESS EXCLUSIVE
-- lock was released before this reads anything: the UPDATE takes ROW
-- EXCLUSIVE on vehicle_checklist, which no read and no INSERT waits for. The
-- rows it marks stay locked until it commits, so an edit, a deletion or the
-- AI verification of one of those waits, and after the API's lock_timeout
-- (5 s) fails with a 500. activity has no index on type, action or entityId:
-- the IN list does not depend on the row, so it is read in one pass and
-- hashed, bounded by created_at because the origin is in the description only
-- since 81a14dd (14/09/2026), which activity_created_at_idx serves when the
-- bound is selective. Production volume was not measured: measure the trail
-- first (SELECT count(*), pg_size_pretty(pg_total_relation_size('activity'))
-- FROM activity, and the part read, SELECT count(*) FROM activity WHERE
-- created_at >= '2026-09-14') and deploy off-peak if it is large.

SET lock_timeout = '5s';

UPDATE "vehicle_checklist"
   SET "created_from" = 'MOBILE_APP'
 WHERE "created_from" = 'WEB_DASHBOARD'
   AND (
     "client_submission_id" IS NOT NULL
     OR "id" IN (
       SELECT "entityId"
         FROM "activity"
        WHERE "created_at" >= '2026-09-14'
          AND "type" = 'Checklist Veicular'
          AND "action" = 'create'
          AND "description" LIKE '% | Origem: Aplicativo'
     )
   );

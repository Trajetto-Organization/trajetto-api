-- "Em rota" becomes a fact about a route rather than a value somebody typed.
--
-- Until now IN_ROUTE was an option in the vehicle form and nothing ever wrote
-- or cleared it, so a vehicle marked that way stayed that way: true until the
-- truck came back and nobody remembered to change the dropdown. From this
-- release the route owns the value — it is set when a route departs and
-- cleared when the route ends — and the API refuses it from any other writer.
--
-- That leaves the rows already in this state stranded: no route will ever end
-- for them, because they never had one, so nothing would ever hand them back.
-- This corrects exactly those, and only those.
--
-- Deliberately NOT touching a vehicle that is genuinely out: the subquery
-- keeps every vehicle attached to a route that is running right now, which is
-- the state the new code is about to start maintaining.
--
-- Idempotent and safe to re-run: after it, no row matches.
UPDATE "vehicle"
SET "status" = 'ACTIVE', "updated_at" = NOW()
WHERE "status" = 'IN_ROUTE'
  AND "id" NOT IN (
    SELECT "vehicleId"
    FROM "route"
    WHERE "status" = 'IN_PROGRESS'
      AND "vehicleId" IS NOT NULL
  );

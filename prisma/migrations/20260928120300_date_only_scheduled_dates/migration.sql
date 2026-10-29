-- The planned day of a delivery and of a route become civil dates (decision 1.3).
--
-- What the operator picks is a day, not an instant. Stored as a timestamp it
-- was an instant, and every screen rendered it in the browser's zone: a route
-- of 17/09 showed as "16/09/2026 às 21:00". The values written so far are the
-- local midnight the web sent (03:00Z of the chosen day in Brasilia time),
-- the UTC midnight the spreadsheet and the assignment wrote (00:00Z), or an
-- ISO date the API parsed as UTC midnight — every one of them falls on the
-- intended day when read in UTC.
--
-- Hence `::date` on the timestamp WITHOUT time zone: it takes the day of the
-- stored UTC wall clock and never consults the session's TimeZone. The
-- tempting `(col AT TIME ZONE 'UTC')::date` does: it goes through timestamptz,
-- whose cast to date uses the session zone, so under America/Sao_Paulo it
-- moves every 00:00Z value to the day before
-- (tests/E2E/schema-expand-contract.test.ts pins both facts).
--
-- Prisma reads a `date` as midnight UTC of that day and writes a Date by
-- taking its UTC day, so the column type in the client does not change.
--
-- Both tables were created after the production baseline (the delivery module
-- has not shipped), so no running image reads them. The ALTER rewrites each
-- table under an exclusive lock and rebuilds its indexes
-- (route_businessId_status_scheduled_date_idx included) — instant at today's
-- size. At the Comprovei scale this would be an expand/contract column swap.
ALTER TABLE "delivery" ALTER COLUMN "scheduled_date" TYPE DATE USING ("scheduled_date"::date);

ALTER TABLE "route" ALTER COLUMN "scheduled_date" TYPE DATE USING ("scheduled_date"::date);

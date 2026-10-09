-- Marks the occurrence type the platform creates as a system type.
--
-- The proof audit creates "Comprovante rejeitado" in each company on the first
-- rejection (review-proof-audit-usecase.ts, `ensureByName`, looked up by that
-- exact name). Created as an ordinary active type, it showed up in the
-- driver's list of occurrences to report and inflated "Ocorrências hoje —
-- relatadas pelo motorista" (DLVP-OCC-3). is_system (20260928120200) lets
-- both leave it out; this backfills the rows that already exist.
--
-- By name, because the name is what the code finds it by: a company that
-- created a type with this name by hand has it reused by every rejection,
-- which makes it the system type in practice. Idempotent.
UPDATE "occurrence_type"
   SET "is_system" = true
 WHERE "name" = 'Comprovante rejeitado'
   AND "is_system" = false;

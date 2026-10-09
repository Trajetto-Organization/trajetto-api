-- Data only: no DDL, nothing for the Prisma schema to model.
--
-- `deliveries:write` and `webhooks:manage` are published but no route
-- requires them yet (RESERVED_API_SCOPES in src/shared/integration/
-- api-key-rules.ts). A key that carries one would gain write access, in
-- silence, on the day a route starts requiring it — granted by somebody who,
-- when they granted it, was granting nothing. The API no longer issues them;
-- this takes them off keys issued before.
--
-- Nothing a key can do today changes: no route checks either scope. The
-- `WHERE` touches only the rows that carry one (none in production, where
-- api_key is created by this same release), so the statement is cheap and
-- idempotent.

UPDATE "api_key"
SET "scopes" = array_remove(array_remove("scopes", 'deliveries:write'), 'webhooks:manage')
WHERE "scopes" && ARRAY['deliveries:write', 'webhooks:manage']::TEXT[];

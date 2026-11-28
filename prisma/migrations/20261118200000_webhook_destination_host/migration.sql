-- ----------------------------------------------------------------------------
-- The destination host of each webhook endpoint (plano-escala F3-14)
-- ----------------------------------------------------------------------------
-- The dispatcher caps the calls in flight to one destination host across
-- every endpoint pointed at it (WEBHOOK_HOST_GLOBAL_CONCURRENCY): an
-- aggregator's ERP (Comprovei/Fusion) receives one endpoint per tenant at
-- the same host, and the cap per endpoint alone (F3-13) would let it take
-- four calls times its tenants at once. The host is the URL's, lower case,
-- without a trailing dot, as the code writes it with the URL
-- (destinationHostOf in src/shared/integration/webhook-dispatch-rules.ts).
--
-- Expand: a nullable column and the backfill of the endpoints that exist,
-- one UPDATE on a small table (at most ten endpoints per company), not a
-- hot one. The image of before, during the rolling deploy and after a
-- rollback, neither reads nor writes it; an endpoint it saves keeps a null
-- host, which counts as no host cap, until the dispatcher's minute fills
-- it (fillDestinationHosts in webhook-dispatch-service.ts).
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

ALTER TABLE "webhook_endpoint" ADD COLUMN IF NOT EXISTS "destination_host" TEXT;

-- The URL's host: after the scheme and any user info, up to the port, the
-- path, the query or the fragment; an IPv6 literal keeps its brackets.
UPDATE "webhook_endpoint"
SET "destination_host" = NULLIF(
  rtrim(
    lower(substring("url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(\[[^]]*\]|[^:/?#]+)')),
    '.'
  ),
  ''
)
WHERE "destination_host" IS NULL;

-- The receipts' read by fact (provider, message, status) without the unique
-- that goes with F5-06 (plano-escala): insertReceipts locks each fact and
-- reads which ones the ledger already holds, by these three columns.
-- Built before the contraction drops the unique, so the read never loses
-- its index (migrations/20261118120000_queue_contract).
-- requires-table: notification_provider_receipt

CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_provider_receipt_fact_idx" ON "notification_provider_receipt" ("provider", "providerMessageId", "status");

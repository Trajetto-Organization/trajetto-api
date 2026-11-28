-- The e-mail opt-outs (D38) also kept under each address of a list (owner,
-- 10/11/2026; the table is 20261103160000_customer_message_suppression).
--
-- The NF-e and the spreadsheet bring the recipient's e-mail as a list in one
-- field ("compras@cliente.com.br; financeiro@cliente.com.br"). Until this
-- release the imports stored it as written and the opt-out kept the whole
-- field, trimmed and lower-cased, as one EMAIL address. Now the imports store
-- only the valid addresses, joined by ";" with no spaces
-- (src/shared/delivery/recipient-email.ts), and an opt-out is kept and looked
-- up under the whole field AND under each address
-- (customer-message-suppression.ts, suppressionAddresses). A row the previous
-- image wrote for "a; b" would no longer match the next NF-e of the same
-- customer, stored as "a;b": the person would be written to again.
--
-- So every EMAIL row whose address holds a ";" or a "," gets one row per
-- entry: trimmed, lower-cased, with the first opt-out's date (the detail's
-- "since") and its source delivery. Only entries shaped like an address
-- ("x@y", no blank); a looser filter than the send's check only adds keys no
-- lookup ever names. The whole-field rows stay: the previous image still
-- looks them up during the rollout. The WhatsApp rows are not touched.
--
-- Idempotent (ON CONFLICT DO NOTHING on the unique key the opt-out writes
-- through): docs/deploy.md has it run again by hand once this release
-- serves, for the opt-outs the previous image writes in between.
--
-- Locks and volume: reads and writes only customer_message_suppression (one
-- row per address somebody opted out from; small), with ROW EXCLUSIVE, which
-- no read and no opt-out waits for, except an opt-out of the same company and
-- address in the same instant, which waits for the commit. No other table.

SET lock_timeout = '5s';

INSERT INTO "customer_message_suppression"
  ("id", "businessId", "channel", "address", "source_delivery_id", "created_at")
SELECT gen_random_uuid()::text,
       entries."businessId",
       entries."channel",
       entries."address",
       entries."source_delivery_id",
       entries."created_at"
  FROM (
    SELECT DISTINCT ON (whole."businessId", lower(btrim(entry.piece)))
           whole."businessId",
           whole."channel",
           lower(btrim(entry.piece)) AS "address",
           whole."source_delivery_id",
           whole."created_at"
      FROM "customer_message_suppression" AS whole
     CROSS JOIN LATERAL regexp_split_to_table(
             regexp_replace(whole."address", '\s', ' ', 'g'),
             '[;,]'
           ) AS entry(piece)
     WHERE whole."channel" = 'EMAIL'
       AND whole."address" ~ '[;,]'
     ORDER BY whole."businessId", lower(btrim(entry.piece)), whole."created_at"
  ) AS entries
 WHERE entries."address" ~ '^[^@ ]+@[^@ ]+$'
ON CONFLICT ("businessId", "channel", "address") DO NOTHING;

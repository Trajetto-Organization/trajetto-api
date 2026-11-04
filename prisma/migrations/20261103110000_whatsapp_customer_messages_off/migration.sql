-- Every company's customer WhatsApp starts switched off (plan of 02/11/2026,
-- item B3; decision D35).
--
-- A WhatsApp row used to carry the company's own text; from this release the
-- moment goes out as a fixed template approved by Meta (B2), and the row is
-- only its on/off switch. No company ever saw that fixed text, and no customer
-- WhatsApp ever left (META_WHATSAPP_* is configured in no environment), so a
-- row left active would start sending words its company never read. Each
-- company switches its moments back on in the web, knowingly; the owner tells
-- them (docs/deploy.md).
--
-- Expand-safe: a plain UPDATE of a boolean the serving image already reads.
-- That image, seeing the rows off, sends no customer WhatsApp — exactly what
-- it does today. The e-mail rows are untouched. The table is small (one row
-- per company, moment and channel).

SET lock_timeout = '5s';

UPDATE "delivery_message_template"
SET "is_active" = false, "updated_at" = now()
WHERE "channel" = 'WHATSAPP' AND "is_active" = true;

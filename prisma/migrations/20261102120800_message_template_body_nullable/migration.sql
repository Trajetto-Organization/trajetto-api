-- The customer's WhatsApp message stops being the company's text (plan of
-- 02/11/2026, item B3): the four moments go out as fixed templates approved
-- by Meta, and the web edits a WhatsApp row with an on/off switch only. Its
-- "body" (and "subject") lose their meaning; the e-mail keeps both.
--
-- Two releases, by the nullable-expand rule:
--   N (this one)  the column accepts NULL and the CHECK below keeps it
--                 required on the e-mail; the code ignores a WhatsApp row's
--                 body when it reads and renders, and its save keeps the
--                 previous body (or writes '') — never NULL.
--   N+1           writes NULL, and a contract-phase data migration clears the
--                 WhatsApp rows' body and subject.
--
-- The CHECK is validated here, over a small table (one row per company,
-- moment and channel) in which every row has a body.
--
-- nullable-expand: nothing writes a NULL body in this release; NULL is written from the next one, on WhatsApp rows only (plan of 02/11/2026, B3).

SET lock_timeout = '5s';

ALTER TABLE "delivery_message_template" ALTER COLUMN "body" DROP NOT NULL;

ALTER TABLE "delivery_message_template"
  ADD CONSTRAINT "delivery_message_template_email_body_chk"
  CHECK ("channel" <> 'EMAIL' OR "body" IS NOT NULL);

-- The e-mail becomes optional for a driver's login (decision D02 of the plan
-- of 02/11/2026, item D2): a driver signs in with the QR code or with CPF and
-- a password the manager set, and many have no mailbox at all.
--
-- Release N (this one) only loosens the column: every writer still sends an
-- e-mail and the request schemas still require one, so no NULL is written
-- while an image whose client reads the column as required can serve — the
-- previous image would fail to read such a row (P2032), during the rollout
-- and after a rollback. This release's client already reads it as optional.
-- Creating a driver without an e-mail is switched on in the NEXT release,
-- once this one (API, web and app treating the e-mail as optional) is live.
--
-- The unique index on "email" stays: Postgres never counts NULLs as equal, so
-- many drivers without an e-mail coexist, and the login and the password
-- reset keep their lookup. Catalog-only (no rewrite, no scan).
--
-- nullable-expand: nothing writes a NULL e-mail in this release; the driver without an e-mail is enabled only in the next one (plan of 02/11/2026, D2, two-release rule of §2.5).

SET lock_timeout = '5s';

ALTER TABLE "user" ALTER COLUMN "email" DROP NOT NULL;

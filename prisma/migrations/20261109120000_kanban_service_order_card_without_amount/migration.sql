-- The amount leaves the automatic cards of service orders (09/11/2026; wave
-- 3, owner's decision: a driver sees the orders he works on WITHOUT costs).
--
-- Since 9231f05 (21/08/2025) every service order has created a Kanban card,
-- titled "Manutenção <plate or the order's id>", for the order's responsible,
-- a driver included, with four lines of text:
--
--   Veículo: <plate>
--   Valor: <the order's total, "R$ 1.850,00">
--   Responsável: Atribuído | Não atribuído
--   Tipo: Interno | Externo
--
-- Wave 3 opened GET /kanban/card/:cardId to the card's designated user, and
-- the app shows the text whole; the WhatsApp of a card handed over to someone
-- carries it too. From this release the card is written without the second
-- line (serviceOrderCardDescription in kanban-service.ts); this takes it out
-- of the cards already written.
--
-- Only that line, and only where the text still opens the way the API wrote
-- it: the plate's line, then "Valor: ". A card whose text the office rewrote
-- is left as it is. updated_at is left alone: nobody edited the card, and
-- moving it would list every one of these cards as edited at deploy time.
--
-- Idempotent (a card without the line no longer matches): docs/deploy.md has
-- it run again by hand once this release serves, for the cards the previous
-- image wrote while the two overlapped.
--
-- Expand-safe: a plain UPDATE of a text the serving image only shows. Locks
-- and volume: ROW EXCLUSIVE on kanban_card, which no read and no INSERT waits
-- for; the cards it rewrites stay locked until it commits, so a move or an
-- edit of one of them waits for it. One card per service order, read in one
-- pass (nothing indexes the text).

SET lock_timeout = '5s';

UPDATE "kanban_card"
   SET "description" = regexp_replace(
         "description",
         '^(Veículo: [^\n]*)\nValor: [^\n]*',
         '\1'
       )
 WHERE "title" LIKE 'Manutenção %'
   AND "description" ~ '^Veículo: [^\n]*\nValor: ';

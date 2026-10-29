-- Endpoints subscribed to "document.*" start receiving what they asked for
-- (decision 5.9).
--
-- The panel's "Todos os eventos" for Documentos saved "document.*", but the
-- dispatcher's wildcard is a topic PREFIX (webhook-catalogue.ts, topicMatches)
-- and no topic starts with "document." — the document family is delivery.*,
-- occurrence.* and proof.*. Those endpoints received no document event at all,
-- silently (DLVB-22). Each "document.*" becomes the three family wildcards,
-- appended in catalogue order after the subscriptions the endpoint already
-- had, without duplicating one it already listed.
--
-- updated_at is left alone: nobody edited the endpoint. Idempotent — a second
-- run finds no "document.*".
UPDATE "webhook_endpoint" AS endpoint
   SET "topics" = array_remove(endpoint."topics", 'document.*')
                  || ARRAY(
                       SELECT family.topic
                         FROM unnest(ARRAY['delivery.*', 'occurrence.*', 'proof.*'])
                              WITH ORDINALITY AS family(topic, position)
                        WHERE NOT (family.topic = ANY (endpoint."topics"))
                        ORDER BY family.position
                     )
 WHERE 'document.*' = ANY (endpoint."topics");

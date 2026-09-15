-- O outro lado do monitor: o que o sistema do cliente pediu a nós.
--
-- `webhook_delivery` responde "o que mandamos e o que eles responderam". Esta
-- tabela responde a pergunta inversa, que é a que aparece no suporte primeiro:
-- "o ERP deles chamou, e o que aconteceu?". Sem isso a única resposta possível
-- é `api_key.last_used_at`, que diz que alguém chamou alguma coisa em algum
-- momento — e não ajuda ninguém.
--
-- AGREGADA, não um log por requisição. A cinco milhões de entregas por mês uma
-- linha por chamada é dezenas de milhões de linhas por mês para responder uma
-- pergunta que é sempre sobre contagem. Uma linha por chave × dia × rota ×
-- classe de status responde a mesma pergunta e cabe num índice.
CREATE TABLE "api_key_usage_daily" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,

    -- O dia em UTC. Data e não timestamp: a pergunta é sempre "quantas ontem",
    -- nunca "quantas às 14h32".
    "day" DATE NOT NULL,

    -- O padrão da rota, não a URL: `/integration/v1/deliveries/:id` e não
    -- `/integration/v1/deliveries/018f...`. Agregar por URL literal daria uma
    -- linha por documento consultado, que é o log por requisição de novo com
    -- outro nome.
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,

    -- 2, 4 ou 5. A classe responde "funcionou, o cliente errou, ou nós
    -- erramos" — que são as três conversas possíveis. O status exato está no
    -- log da aplicação para quem precisar descer.
    "status_class" SMALLINT NOT NULL,

    "count" BIGINT NOT NULL DEFAULT 0,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_key_usage_daily_pkey" PRIMARY KEY ("id")
);

-- A chave natural. É o que o upsert do acumulador usa, e é o que impede duas
-- réplicas de criarem duas linhas para o mesmo balde.
CREATE UNIQUE INDEX "api_key_usage_daily_bucket_key"
  ON "api_key_usage_daily"("apiKeyId", "day", "method", "route", "status_class");

-- A leitura da tela: uma empresa, os últimos dias, do mais recente para trás.
CREATE INDEX "api_key_usage_daily_businessId_day_idx"
  ON "api_key_usage_daily"("businessId", "day" DESC);

ALTER TABLE "api_key_usage_daily"
  ADD CONSTRAINT "api_key_usage_daily_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_key_usage_daily"
  ADD CONSTRAINT "api_key_usage_daily_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Uma linha por balde, atualizada o dia inteiro: é exatamente o padrão que
-- enche a tabela de versões mortas. O autovacuum padrão espera 20% de uma
-- tabela que é pequena em linhas e quente em UPDATEs, o que na prática é
-- esperar demais.
ALTER TABLE "api_key_usage_daily" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

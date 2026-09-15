-- Fatia 11: o contrato é NOSSO.
--
-- API pública versionada e catálogo versionado de tópicos de webhook, os
-- mesmos para qualquer TMS, ERP ou roteirizador. Quem se conecta a nós se
-- adapta ao nosso contrato — um conector por cliente é um conector por cliente
-- para manter, para sempre, e a referência ensinou isso do jeito difícil.

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

-- ---------------------------------------------------------------------------
-- A chave com que um sistema de fora se autentica.
--
-- A metade secreta NUNCA é guardada, só o hash: um dump do banco não pode
-- entregar a operação de todos os clientes a quem o ler.
-- ---------------------------------------------------------------------------
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 120,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_key_prefix_key" ON "api_key"("prefix");
CREATE INDEX "api_key_businessId_created_at_idx" ON "api_key"("businessId", "created_at");

-- ---------------------------------------------------------------------------
-- Onde o sistema do cliente quer ser avisado.
-- ---------------------------------------------------------------------------
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "headers" JSONB,
    "topics" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_endpoint_businessId_created_at_idx" ON "webhook_endpoint"("businessId", "created_at");

-- ---------------------------------------------------------------------------
-- Uma tentativa de contar um evento a um endpoint.
--
-- O payload é COPIADO, e essa é a decisão que o §4.6 registra: o outbox é fila
-- de trabalho e é expurgado, e um cliente pedindo o reenvio do evento de
-- terça-feira não pode depender de uma linha que apagamos na quarta. Arquivo
-- de auditoria e fila quente são coisas separadas.
-- ---------------------------------------------------------------------------
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "response_status" INTEGER,
    "response_body" TEXT,
    "latency_ms" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "resent_from_id" TEXT,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_delivery_businessId_created_at_idx" ON "webhook_delivery"("businessId", "created_at");
CREATE INDEX "webhook_delivery_endpointId_status_idx" ON "webhook_delivery"("endpointId", "status");

ALTER TABLE "api_key"
  ADD CONSTRAINT "api_key_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_endpoint"
  ADD CONSTRAINT "webhook_endpoint_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_delivery"
  ADD CONSTRAINT "webhook_delivery_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_delivery"
  ADD CONSTRAINT "webhook_delivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- O índice de claim, parcial — o reforço 1 do §4.6, aplicado à terceira fila.
--
-- O índice fica do tamanho do backlog e não do histórico. Numa transportadora
-- que dispara um webhook por evento de entrega, o backlog tem dezenas de
-- linhas e o arquivo tem milhões; um índice que carregue os dois faz cada
-- claim pagar pelo arquivo inteiro.
-- ---------------------------------------------------------------------------
CREATE INDEX "webhook_delivery_claim_idx"
  ON "webhook_delivery" ("availableAt")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- ---------------------------------------------------------------------------
-- Autovacuum por tabela — o reforço 2 do §4.6.
--
-- A fila é escrita, reivindicada e atualizada várias vezes por linha, e depois
-- fica parada. O vacuum roda cedo e pequeno em vez de tarde e grande.
--
-- Registrado honestamente, como nas outras filas: isto NÃO compra HOT update,
-- porque `status` é coluna de predicado do índice parcial acima e toda
-- atualização que a mexe reescreve a entrada do índice de qualquer jeito.
-- ---------------------------------------------------------------------------
ALTER TABLE "webhook_delivery" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01,
  fillfactor = 70
);

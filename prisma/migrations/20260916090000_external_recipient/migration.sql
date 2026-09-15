-- Fatia 9: o comprovante, a página pública e quem recebe a entrega.
--
-- Três coisas nascem juntas porque são uma só: a pessoa que espera a carga não
-- tem conta, precisa ser avisada pelos mesmos providers do resto do sistema, e
-- o que ela recebe é um link e um comprovante que ela consegue conferir.

-- CreateEnum
CREATE TYPE "DeliveryMessageTopic" AS ENUM ('DISPATCHED', 'DELIVERED', 'FAILED');

-- ---------------------------------------------------------------------------
-- O destinatário externo.
--
-- Um por entrega, de propósito. Uma tabela de contatos chaveada por telefone
-- seria tentadora e errada neste tamanho: o mesmo número pertence a pessoas
-- diferentes ao longo do tempo, e corrigir um contato numa entrega não pode
-- reescrever o registro de uma mensagem já enviada sobre outra.
-- ---------------------------------------------------------------------------
CREATE TABLE "external_recipient" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "access_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "opted_out_at" TIMESTAMP(3),
    "deliveryId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_recipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_recipient_access_token_key" ON "external_recipient"("access_token");
CREATE UNIQUE INDEX "external_recipient_deliveryId_key" ON "external_recipient"("deliveryId");
CREATE INDEX "external_recipient_businessId_created_at_idx" ON "external_recipient"("businessId", "created_at");

-- ---------------------------------------------------------------------------
-- O comprovante consolidado.
-- ---------------------------------------------------------------------------
CREATE TABLE "delivery_proof_document" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "verification_token" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_proof_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_proof_document_deliveryId_key" ON "delivery_proof_document"("deliveryId");
CREATE UNIQUE INDEX "delivery_proof_document_verification_token_key" ON "delivery_proof_document"("verification_token");
CREATE INDEX "delivery_proof_document_businessId_generated_at_idx" ON "delivery_proof_document"("businessId", "generated_at");

-- ---------------------------------------------------------------------------
-- O que a empresa diz a quem espera a entrega.
-- ---------------------------------------------------------------------------
CREATE TABLE "delivery_message_template" (
    "id" TEXT NOT NULL,
    "topic" "DeliveryMessageTopic" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_message_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_message_template_businessId_topic_channel_key" ON "delivery_message_template"("businessId", "topic", "channel");

-- ---------------------------------------------------------------------------
-- O livro de entregas de notificação passa a endereçar quem não é usuário.
--
-- Um livro só, e não dois: o laço de retentativa, o lease, a chave de dedupe e
-- a contabilidade do provider são a parte difícil, e uma tabela paralela para
-- envios externos seria uma segunda cópia de tudo isso, divergindo.
-- ---------------------------------------------------------------------------
ALTER TABLE "notification_delivery"
  ADD COLUMN "externalRecipientId" TEXT,
  ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX "notification_delivery_externalRecipientId_idx" ON "notification_delivery"("externalRecipientId");

ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "notification_delivery_externalRecipientId_fkey"
  FOREIGN KEY ("externalRecipientId") REFERENCES "external_recipient"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_recipient"
  ADD CONSTRAINT "external_recipient_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_recipient"
  ADD CONSTRAINT "external_recipient_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_proof_document"
  ADD CONSTRAINT "delivery_proof_document_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_proof_document"
  ADD CONSTRAINT "delivery_proof_document_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_message_template"
  ADD CONSTRAINT "delivery_message_template_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A unicidade, agora em DOIS índices parciais.
--
-- Esta é a parte que o Prisma não expressa e que não pode ficar de fora. Um
-- @@unique sobre uma coluna que virou nullable NÃO protege nada em Postgres:
-- cada NULL conta como distinto, então duas linhas (evento, NULL, WHATSAPP)
-- conviveriam e o cliente receberia a mesma mensagem duas vezes na primeira
-- retentativa de um evento.
--
-- Um índice por tipo de destinatário resolve: cada um cobre exatamente as
-- linhas em que a sua coluna existe.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "notification_delivery_outboxEventId_userId_channel_key";

CREATE UNIQUE INDEX "notification_delivery_user_event_channel_idx"
  ON "notification_delivery" ("outboxEventId", "userId", "channel")
  WHERE "userId" IS NOT NULL;

CREATE UNIQUE INDEX "notification_delivery_external_event_channel_idx"
  ON "notification_delivery" ("outboxEventId", "externalRecipientId", "channel")
  WHERE "externalRecipientId" IS NOT NULL;

-- Exatamente um dos dois. Sem isto, uma linha sem nenhum destinatário passaria
-- pelos dois índices parciais acima sem violar nada e ficaria na fila para
-- sempre, sendo reivindicada e falhando a cada ciclo do worker.
ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "notification_delivery_one_recipient"
  CHECK (
    ("userId" IS NOT NULL AND "externalRecipientId" IS NULL)
    OR
    ("userId" IS NULL AND "externalRecipientId" IS NOT NULL)
  );

-- Fatia 10: a IA lê o canhoto e SUGERE; uma pessoa decide.
--
-- A auditoria registrou que IA sem veredito humano não fecha o ciclo
-- probatório. Então o que a máquina produz é uma sugestão numa coluna, e a
-- decisão de alguém é outra — separadas de propósito: juntá-las tornaria
-- impossível perguntar depois com que frequência a máquina acertou, que é a
-- única forma de saber se vale continuar pagando por ela.

-- CreateEnum
CREATE TYPE "ProofAuditStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
--
-- Fora de transação não é necessário no PG 12+ desde que o valor não seja
-- usado no mesmo comando, e não é: nenhuma linha aqui referencia DELIVERY_PROOF.
ALTER TYPE "AIAnalysisType" ADD VALUE IF NOT EXISTS 'DELIVERY_PROOF';

-- CreateTable
CREATE TABLE "delivery_proof_audit" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "status" "ProofAuditStatus" NOT NULL DEFAULT 'PENDING',
    "ai_suggestion" JSONB,
    "ai_confidence" DOUBLE PRECISION,
    "ai_analyzed_at" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "businessId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_proof_audit_pkey" PRIMARY KEY ("id")
);

-- Uma auditoria por entrega. Uma recomprovação substitui a sugestão e reabre a
-- linha, em vez de enfileirar um segundo card para o mesmo endereço.
CREATE UNIQUE INDEX "delivery_proof_audit_deliveryId_key" ON "delivery_proof_audit"("deliveryId");

CREATE INDEX "delivery_proof_audit_businessId_status_created_at_idx"
  ON "delivery_proof_audit"("businessId", "status", "created_at");

ALTER TABLE "delivery_proof_audit"
  ADD CONSTRAINT "delivery_proof_audit_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, explicitamente. Quem revisou um comprovante é parte da resposta que
-- o suporte dá sobre uma decisão que uma pessoa tomou; SetNull apagaria o nome
-- no dia em que esse usuário fosse desligado.
ALTER TABLE "delivery_proof_audit"
  ADD CONSTRAINT "delivery_proof_audit_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delivery_proof_audit"
  ADD CONSTRAINT "delivery_proof_audit_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A fila, num índice parcial.
--
-- O índice acima serve a qualquer consulta por status; este serve à única que
-- roda o tempo todo, que é "o que ainda está esperando nesta empresa". Numa
-- transportadora com cinco milhões de entregas por mês, a fila pendente tem
-- dezenas de linhas e o histórico tem milhões — um índice que carrega os dois
-- é um índice em que cada leitura da fila paga pelo histórico inteiro.
--
-- O Prisma não expressa índice parcial; por isso ele nasce aqui.
-- ---------------------------------------------------------------------------
CREATE INDEX "delivery_proof_audit_queue_idx"
  ON "delivery_proof_audit" ("businessId", "created_at")
  WHERE "status" = 'PENDING';

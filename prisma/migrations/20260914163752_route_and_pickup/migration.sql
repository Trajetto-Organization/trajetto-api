-- ============================================================================
-- Fatia 7 — a rota passa a existir como entidade
--
-- Até aqui "iniciar rota" era um verbo: um updateMany movendo toda entrega
-- PENDING de um motorista para IN_TRANSIT. Não havia o que consultar, ordenar,
-- liberar, acompanhar ou fechar. Era a lacuna estrutural nº 1 da auditoria, e
-- o motivo de fechá-la agora está lá: quanto mais features forem construídas
-- sobre Delivery como lista plana, mais caro fica introduzir Route.
--
-- O vínculo rota × entrega é N:N de propósito. Uma entrega que falha reentra
-- numa rota do dia seguinte como uma parada NOVA, e a parada anterior fica
-- exatamente como estava — esse registro é o que responde "o que aconteceu com
-- a nota X". Com Delivery.routeId (1:N) a reentrega apagaria a primeira
-- tentativa.
--
-- Delivery.driverId/vehicleId continuam existindo, mas mudam de natureza:
-- viram espelho da rota ativa, escritos só pelo serviço de rota. É
-- desnormalização deliberada — removê-los obrigaria a reescrever
-- list-deliveries, my-deliveries, operation-summary e os painéis dentro desta
-- mesma fatia.
--
-- NOTA SOBRE A GERAÇÃO DESTE ARQUIVO (a segunda vez que isso acontece)
--
-- O `prisma migrate dev` incluiu de novo DROP INDEX "chat_message_body_trgm_idx",
-- e a linha foi removida à mão. O índice de trigrama nasce em SQL cru porque o
-- schema do Prisma não expressa gin_trgm_ops, então TODA geração de migration
-- vai oferecer removê-lo. Não é um caso isolado: é permanente, e toda migration
-- gerada daqui para frente precisa ser lida com isso em mente.
-- ============================================================================

-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RouteStopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "delivery" ADD COLUMN     "kind" "DeliveryKind" NOT NULL DEFAULT 'DELIVERY';

-- AlterTable
ALTER TABLE "delivery_event" ADD COLUMN     "routeId" TEXT;

-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "name" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'PLANNED',
    "scheduled_date" TIMESTAMP(3) NOT NULL,
    "planned_departure_at" TIMESTAMP(3),
    "planned_arrival_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "businessId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stop" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "RouteStopStatus" NOT NULL DEFAULT 'PENDING',
    "arrived_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "routeId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "route_businessId_status_scheduled_date_idx" ON "route"("businessId", "status", "scheduled_date");

-- CreateIndex
CREATE INDEX "route_businessId_driverId_status_idx" ON "route"("businessId", "driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_businessId_code_key" ON "route"("businessId", "code");

-- CreateIndex
CREATE INDEX "route_stop_routeId_status_idx" ON "route_stop"("routeId", "status");

-- CreateIndex
CREATE INDEX "route_stop_deliveryId_idx" ON "route_stop"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "route_stop_routeId_sequence_key" ON "route_stop"("routeId", "sequence");

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- As duas invariantes que o schema do Prisma não consegue declarar
--
-- Ambas são índices únicos PARCIAIS. Poderiam viver só na validação do use
-- case, e é justamente por isso que estão aqui: validação no use case protege
-- contra o caminho que você lembrou de proteger, e o banco protege contra
-- todos os outros — inclusive o reenvio do outbox, o script de importação da
-- fatia 8 e a correção manual feita no psql às duas da manhã.
-- ============================================================================

-- R1 — uma entrega tem no máximo UMA parada aberta, em qualquer rota.
--
-- O predicado é sobre o status da PARADA, não o da rota: cancelar uma rota
-- cancela as paradas dela, e é isso que libera a entrega para entrar noutra.
-- Se o predicado olhasse o status da rota, uma rota cancelada com paradas
-- ainda PENDING deixaria a entrega presa para sempre.
CREATE UNIQUE INDEX "route_stop_active_delivery_idx"
  ON "route_stop" ("deliveryId")
  WHERE "status" IN ('PENDING', 'ARRIVED');

-- R6 — um veículo em no máximo UMA rota em andamento.
--
-- É o que "em rota" significa fisicamente: o caminhão está numa estrada só. E
-- é o que torna o status IN_ROUTE do veículo derivável sem ambiguidade, em vez
-- de digitado à mão num <Select> como é hoje.
--
-- Deliberadamente só sobre IN_PROGRESS: duas rotas RELEASED podem apontar para
-- o mesmo veículo, porque planejar é livre e o despachante monta a semana
-- inteira. Quem esbarra é a segunda largada.
CREATE UNIQUE INDEX "route_active_vehicle_idx"
  ON "route" ("vehicleId")
  WHERE "status" = 'IN_PROGRESS';

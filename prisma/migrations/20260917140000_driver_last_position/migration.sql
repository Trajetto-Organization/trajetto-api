-- Onde cada motorista está AGORA, separado de por onde ele passou.
--
-- A torre lia a última posição de cada motorista com `DISTINCT ON` sobre
-- `driver_position`. Medido com 261 mil linhas de um único dia: Seq Scan na
-- partição inteira mais um sort em disco de 14 MB, 408 ms no banco, para
-- devolver 40 linhas. O custo cresce com o número de PINGS, não com o número
-- de motoristas — e na régua de capacidade são 670 pings por segundo, ou 2,4
-- milhões de linhas por hora.
--
-- Uma linha por motorista, atualizada a cada descarga do app: a torre passa a
-- ler por índice o que ela sempre quis ler, e `driver_position` fica sendo o
-- que ela sempre foi, o histórico do trajeto.
CREATE TABLE "driver_last_position" (
    -- O motorista É a chave. Não existe "duas posições atuais".
    "driverId" TEXT NOT NULL,

    "businessId" TEXT NOT NULL,
    "routeId" TEXT,

    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,

    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,

    "battery" SMALLINT,

    -- Do aparelho, como na tabela de histórico.
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_last_position_pkey" PRIMARY KEY ("driverId")
);

-- A leitura da torre: uma empresa, o que reportou nas últimas horas.
CREATE INDEX "driver_last_position_businessId_recorded_at_idx"
  ON "driver_last_position"("businessId", "recorded_at" DESC);

ALTER TABLE "driver_last_position"
  ADD CONSTRAINT "driver_last_position_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "driver"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_last_position"
  ADD CONSTRAINT "driver_last_position_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Aqui a foreign key VALE a pena, ao contrário de `driver_position`: é uma
-- linha por motorista, escrita uma vez a cada descarga, e apagar um motorista
-- tem que tirar o ponto dele do mapa no mesmo instante.

-- Uma linha por motorista atualizada o dia inteiro é o padrão que mais enche
-- a tabela de versões mortas. O autovacuum padrão espera 20% de uma tabela
-- minúscula, o que na prática é esperar demais.
ALTER TABLE "driver_last_position" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

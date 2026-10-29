-- Fatia 12: a torre de controle.
--
-- Pings de posição do app, só enquanto a rota está IN_PROGRESS. É a única
-- tabela do produto que cresce por TEMPO em vez de por evento de negócio: a
-- trezentos motoristas pingando a cada trinta segundos são 864 mil linhas por
-- dia, e em três meses é uma tabela que ninguém consegue mais apagar de dentro.
--
-- Particionada por dia DESDE O INÍCIO, e não "quando doer". Converter uma
-- tabela grande em particionada depois exige reescrevê-la inteira com lock
-- exclusivo, que numa operação que roda das cinco da manhã às dez da noite não
-- tem janela. O expurgo vira DROP TABLE de uma partição: instantâneo, sem
-- tupla morta, sem autovacuum.

CREATE TABLE "driver_position" (
    "id" TEXT NOT NULL,

    "driverId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,

    -- A rota que estava em andamento. Sem ela a trilha é um monte de pontos
    -- sem contexto: "onde o motorista estava" é uma pergunta que só tem
    -- resposta útil junto de "fazendo o quê".
    "routeId" TEXT,

    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,

    -- Do GPS do aparelho, em metros. Um ponto com cem metros de erro num mapa
    -- de rua é um ponto que coloca o caminhão no quarteirão errado, e a tela
    -- precisa poder descartá-lo.
    "accuracy" DOUBLE PRECISION,

    -- km/h e graus, quando o aparelho souber. Nulo é a resposta honesta de um
    -- telefone parado.
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,

    "battery" SMALLINT,

    -- Quando o APARELHO registrou, não quando chegou aqui. O motorista passa
    -- por região sem sinal e o app descarrega vinte pontos de uma vez; usar a
    -- hora de chegada colapsaria meia hora de trajeto num instante só.
    "recorded_at" TIMESTAMP(3) NOT NULL,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- A chave primária precisa conter a coluna de particionamento. Não é
    -- burocracia do Postgres: sem ela o índice único não poderia ser local a
    -- cada partição, e um índice global derrotaria o DROP instantâneo.
    CONSTRAINT "driver_position_pkey" PRIMARY KEY ("id", "recorded_at")
) PARTITION BY RANGE ("recorded_at");

-- O mapa pergunta sempre a mesma coisa: os pontos deste motorista, deste
-- período, do mais recente para trás.
CREATE INDEX "driver_position_driverId_recorded_at_idx"
  ON "driver_position"("driverId", "recorded_at" DESC);

-- E a torre pergunta pela empresa inteira.
CREATE INDEX "driver_position_businessId_recorded_at_idx"
  ON "driver_position"("businessId", "recorded_at" DESC);

-- ---------------------------------------------------------------------------
-- As partições.
--
-- Criadas com antecedência por um cron (`ensure-driver-position-partitions`).
-- As de hoje e dos próximos dias saem daqui para que o primeiro INSERT depois
-- do deploy não caia num período sem partição — o que no Postgres não é um
-- aviso, é um erro, e seria a torre nascendo quebrada.
--
-- Sem partição DEFAULT de propósito: uma DEFAULT faz cada ATTACH futuro
-- precisar varrê-la inteira para provar que nada ali pertenceria à partição
-- nova. O cron é quem garante que nunca falta uma.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  day DATE := (CURRENT_DATE - INTERVAL '1 day')::DATE;
  last_day DATE := (CURRENT_DATE + INTERVAL '7 days')::DATE;
BEGIN
  WHILE day <= last_day LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "driver_position"
         FOR VALUES FROM (%L) TO (%L)',
      'driver_position_' || to_char(day, 'YYYYMMDD'),
      day,
      day + 1
    );

    day := day + 1;
  END LOOP;
END $$;

-- Sem foreign key para driver e business.
--
-- Não é descuido: uma FK obriga cada INSERT a consultar a tabela referenciada,
-- e este é o caminho de escrita mais quente do produto — centenas de milhares
-- de linhas por dia cujo único leitor é um mapa. O businessId já vem de uma
-- rota que foi validada, e uma posição órfã é um ponto que não desenha, não um
-- dado corrompido. A contrapartida é que apagar uma empresa não leva as
-- posições junto; o expurgo por partição resolve isso em dias.

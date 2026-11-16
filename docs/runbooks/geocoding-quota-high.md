# geocoding-quota-high — Consumo do dia da geocodificação perto da cota

**Dispara quando:** as consultas do dia (UTC) da conta do geocodificador, somadas em `provider_quota_day`, passam de 70% de `LOCATIONIQ_DAILY_QUOTA`. Sem `LOCATIONIQ_DAILY_QUOTA` definida, nada é julgado.

## O que significa

A conta do LocationIQ (a mesma chave do job `geocode-deliveries`, da busca logo depois do commit, da busca de endereço do painel e da geocodificação reversa do comprovante) já gastou mais de 70% das consultas que o plano dá por dia. Os orçamentos de cada caminho somam no máximo 90% da cota (o boot confere), então o resto do dia ainda cabe. O alerta aparece quando um orçamento foi posto acima do que o plano aguenta, quando uma planilha grande drena o dia, ou quando a cota do plano mudou e a variável não. Passados 100%, o provedor responde 429 e todas as consultas pausam até a meia-noite UTC: entregas sem ponto ("Sem localização"), busca do painel fora e comprovantes sem o endereço do GPS.

## Primeira ação

1. Veja quanto cada caminho gastou hoje (a linha com dois-pontos é a parte de uma empresa na busca e já está somada na linha `address-search`):

   ```sql
   SELECT "scope", "used", "updated_at"
   FROM "provider_quota_day"
   WHERE "provider" = 'geocoder'
     AND "day" = (now() AT TIME ZONE 'UTC')::date
   ORDER BY "used" DESC
   LIMIT 20;
   ```

2. Compare com os orçamentos do _Environment_ da `trajetto-api`: `DELIVERY_GEOCODING_DAILY_BUDGET` (job), `ADDRESS_SEARCH_DAILY_BUDGET` (busca) e `PROOF_REVERSE_DAILY_BUDGET` (comprovante).
3. Se o plano contratado mudou, corrija `LOCATIONIQ_DAILY_QUOTA` e `LOCATIONIQ_RATE_PER_SECOND` e os orçamentos pela tabela da decisão D40 (Developer: 17.000 + 2.500 + 3.000 de 25.000; Startup: 45.000 + 4.000 + 5.000 de 60.000) → **Save** → **Deploy**. O boot recusa uma soma acima de 90%.
4. Se é uma planilha grande e o plano ainda é o certo, nada a fazer hoje: o job para no orçamento e retoma à meia-noite UTC. Antes do próximo cliente grande, suba o plano.

## Como confirmar

Na linha seguinte do `ops-heartbeat` (um minuto) o motivo some se o consumo caiu abaixo de 70% da cota nova; senão, ele some à meia-noite UTC, quando o dia recomeça. No log da `trajetto-api`, `geocoding held: budget spent for today (N/M)` diz quando o job parou no orçamento.

## Quando escalar

Ao dono quando o alerta se repete por dois dias seguidos (o plano não dá conta do volume: a tabela por degrau da decisão D40 diz o próximo), ou quando o 429 de cota apareceu antes de o orçamento acabar (o log diz `provider daily quota until …`): o painel do LocationIQ conta consultas que não passaram pela API, como uma chave usada fora daqui.

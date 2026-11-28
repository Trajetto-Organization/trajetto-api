# volume-near-gate — Volume de entregas perto do portão aprovado

**Dispara quando:** as entregas dos últimos 7 dias, projetadas para o mês (× 30/7), passam de 70% de APPROVED_GATE_MONTHLY_DELIVERIES; ou as das últimas 24 h passam de PLATFORM_DAILY_DELIVERY_SOFT_CAP (vazio = sem teto).

## O que significa

A plataforma está criando entregas perto do volume que o hardware de hoje provou aguentar: o portão com relatório aprovado em `docs/desempenho` (10 000 por mês no degrau atual). É a régua de rampa (U-12): ela avisa antes de o pico de um cliente chegar no teto. Nada é recusado; o alerta só diz que a rampa precisa esperar. A contagem vem do `ops_sample` (cada processo conta o que criou depois do commit, e a linha `cluster` soma), então ela pode contar um pouco a menos, nunca a mais.

## Primeira ação

1. Confira o volume na série (a linha `cluster` de :00, :15, :30 ou :45 traz as somas):

   ```sql
   SELECT ts,
          metrics->'deliveries'->>'last_24h' AS ultimas_24h,
          metrics->'deliveries'->>'last_7d' AS ultimos_7_dias,
          metrics->'deliveries'->>'since' AS contando_desde
   FROM ops_sample
   WHERE role = 'cluster' AND metrics->'deliveries' ? 'last_7d'
   ORDER BY ts DESC
   LIMIT 4;
   ```

2. Segure a próxima coorte da rampa (V-07): nenhuma transportadora nova do cliente de escala entra até o degrau seguinte ter relatório aprovado.
3. Veja se é um pico só (uma importação grande, uma carga na staging) ou a tendência: compare as somas de 24 h dos últimos dias.

## Como confirmar

A projeção (`last_7d` × 30/7) cai abaixo de 70% do portão, ou as últimas 24 h abaixo do teto, e o motivo some na linha de quarto de hora seguinte.

## Quando escalar

Sempre ao dono: subir APPROVED_GATE_MONTHLY_DELIVERIES só com um relatório de portão novo em `docs/desempenho`, e o degrau de infraestrutura é decisão dele.

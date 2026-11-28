# collection-incomplete — Verificação incompleta

**Dispara quando:** uma parte do estado da operação não pôde ser lida.

## O que significa

O `ops-heartbeat` não conseguiu ler uma parte (uma tabela, o certificado, as métricas do banco), e as regras daquela parte ficam cegas. O motivo diz a parte e o erro; para as métricas do banco, o SQLSTATE.

## Primeira ação

1. O nome da parte diz onde olhar: uma tabela que não existe é migration faltando; `57014` é `statement_timeout` (o banco lento); `42501` é permissão.
2. Leia o log do `ops-heartbeat` na réplica que venceu o minuto.

## Como confirmar

O motivo some no minuto seguinte.

## Quando escalar

Uma parte cega por mais de uma hora: chame o dono, porque o alerta dela não dispara.

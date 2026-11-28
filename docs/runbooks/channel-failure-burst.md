# channel-failure-burst — Rajada de falhas num canal

**Dispara quando:** 50 entregas do mesmo canal falharam de vez em 10 min.

## O que significa

Muitas entregas de um canal esgotaram as tentativas em pouco tempo. Algumas falhas são dado do cliente (número sem WhatsApp, caixa que não existe); esta quantidade de uma vez é o canal.

## Primeira ação

1. Abra `/health/dead-letter?channel=<CANAL>` e leia o prefixo `[... code=...]` mais comum dos `lastError`.
2. Um código do provedor repetido (limite de envio, modelo pausado na Meta, domínio bloqueado) se resolve no painel do provedor.
3. Se for o [provider-down](./provider-down.md), siga aquele runbook.

## Como confirmar

Nenhuma rajada nova no minuto seguinte; o dead letter do canal para de crescer.

## Quando escalar

Modelo de WhatsApp pausado ou conta limitada pela Meta: chame o dono (é a conta da empresa).

# pitr-restore — Restaurar o banco até um momento

**Quando:** um apagamento acidental, uma migration ruim ou a perda do banco.

## O que significa

Voltar o banco a um instante anterior ao incidente. Com o PITR ligado (F1a na staging, F1b na produção), o pgBackRest restaura até o minuto; antes disso, só o dump diário do Dokploy (perda de até 24 h). Tudo o que foi gravado depois do instante escolhido se perde.

## Primeira ação

1. Escolha o instante (antes do incidente) e anote em UTC.
2. Pare a API (réplicas `0`) e o backup agendado, como em [deploy.md, Restaurar a partir do R2](../deploy.md#restaurar-a-partir-do-r2).
3. Com PITR: restaure com o pgBackRest até o instante (`--type=time`) num Database novo, nunca por cima da única cópia; os comandos exatos vêm com a imagem nova do Postgres e entram aqui junto dela. Sem PITR: restaure o dump pela aba _Backups_ do Database.
4. **Sempre**, antes de subir o runtime: rode a etapa de release no banco restaurado, com **Deploy** na `trajetto-api-migrate` (ou _Run workflow_ com `force_release`, na produção com a `image_tag` que está no ar), e espere `Running`. O banco restaurado pode estar atrás do código, e a etapa devolve os roles, os grants e a época do cluster que um restore perde; a `release_step_state` e a tag `<ambiente>-applied` vêm de antes do restore, então o pipeline sozinho pularia a etapa.
5. Volte as réplicas da API para `2` e religue o backup.

## Como confirmar

A linha `cluster` do `ops_sample` do minuto escolhido está lá (é a linha-marcador do ensaio), e nada depois dela; o login e as telas principais respondem.

```sql
SELECT max(ts) FROM ops_sample WHERE role = 'cluster';
```

## Quando escalar

Sempre com o dono: restaurar é escolher perder o que veio depois.

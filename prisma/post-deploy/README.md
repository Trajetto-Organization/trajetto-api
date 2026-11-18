# prisma/post-deploy

DDL que espera uma **pré-condição**, rodado pela etapa de release depois do
`prisma migrate deploy` e do `infra/sql`, e antes dos seeds (plano de escala,
F5-08 e decisão D20). O exemplo do plano é a troca das filas para tabelas
particionadas: ela só pode acontecer quando todas as imagens vivas anunciam
a capability, e até lá o passo fica pendente.

O contrato é o mesmo do `infra/sql` (o `README.md` de lá): arquivo
idempotente, em ordem de nome, que termina com `RAISE NOTICE` `'applied: …'`,
`'skipped: …'` ou `'pending: …'`; o estado fica em `release_step_state`, e um
passo pendente faz o deploy seguinte rodar a etapa de novo (ou um
_Run workflow_ com `force_release`).

Emergência: `POST_DEPLOY_STEPS=off` no _Environment_ da
`trajetto-api-migrate` pula esta pasta (o `infra/sql` continua rodando). O
estado de cada passo fica como estava; tire a variável depois.

Índice de tabela quente não vem aqui: vai em `prisma/concurrent`, antes das
migrations.

`rollback/` não é um passo: a etapa só lê os `.sql` desta pasta, não os das
subpastas. Lá fica a volta de um passo, rodada à mão
(`rollback/unpartition-queue.sql`, a volta da troca das filas,
[ADR 0014](../../docs/adr/0014-filas-particionadas.md)).

## A capability antes de uma contração

Uma contração (tirar uma chave estrangeira ou um unique, trocar uma tabela
por uma particionada, tirar um índice que o código antigo usava) quebra a
imagem que ainda depende do que ela tira, e essa imagem continua servindo
durante o rolling e volta num rollback. Por isso a contração não vai numa
migration: vai num arquivo daqui que pergunta antes a
`trajetto_capability_ready(<capability>, <janela>)` e termina `pending`
enquanto a resposta for não.

`00-queue-swap-ready.sql` cria a função em toda release (plano de escala
F5-07). Ela diz sim quando:

- o banco não tem nenhuma empresa (um banco novo: o molde do E2E, o
  `yarn dev` do zero), sem nada a proteger; ou
- nenhuma sessão deste banco está sem nome (`application_name`), e todo
  processo que gravou uma linha de `ops_sample` na janela anunciou a
  capability na mais nova, e pelo menos um gravou.

A imagem de antes do plano de escala não grava `ops_sample` nem dá nome às
sessões; toda sessão desta imagem se chama `trajetto-api`
(`src/shared/database/pg-driver.ts`), e as da etapa de release, do job de
partições, do `psql` e do `pg_dump` também têm nome. Uma sessão sem nome é
lida como a imagem velha, e segura a contração. As capabilities que esta
imagem anuncia estão em `src/shared/health/capabilities.ts`;
`trajetto_queue_swap_ready(<janela>)` é a das filas
(`queue-partition-agnostic-v1`).

Uma contração daqui também vai, como no-op, numa migration que só age num
banco sem empresa (o molde, o banco sombra do `prisma migrate dev`), com o
marcador `-- contract-phase:`: assim o histórico das migrations e o
`schema.prisma` continuam iguais, e o `prisma migrate dev` não propõe a
mesma mudança de novo.

Para conferir a resposta na mão, no `psql` do Database:

```sql
SELECT trajetto_capability_ready('queue-partition-agnostic-v1', interval '5 minutes');

SELECT pid, usename, application_name, backend_type, backend_start
FROM pg_stat_activity
WHERE datname = current_database() AND coalesce(application_name, '') = '';
```

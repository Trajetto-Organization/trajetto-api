# prisma/concurrent

DDL que não pode travar uma tabela quente, rodado pela etapa de release
**antes** do `prisma migrate deploy` (plano de escala, F2-01 e decisão D20).
Quem roda é `infra/scripts/prebuild-online-ddl.ts` (na imagem
`trajetto-api-migrate`, como `build/prebuild-online-ddl.js`); a regra está em
`infra/scripts/online-ddl.ts`.

## Quando usar

Índice novo (ou removido) numa tabela quente, a lista `HOT_TABLES` de
`src/shared/health/metrics-queries.ts`. Um `CREATE INDEX` comum segura um
lock SHARE na tabela durante todo o build e toda escrita espera; o Prisma
roda cada migration numa transação, onde o `CREATE INDEX CONCURRENTLY` não
roda. Então:

1. Um arquivo aqui, `<timestamp>_<nome>.sql`, constrói o índice com
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
2. A migration do mesmo índice mantém `CREATE INDEX IF NOT EXISTS` com o
   mesmo nome: na produção vira no-op (o índice já existe); num banco novo
   (o molde do E2E, o `yarn dev`) ela o constrói com a tabela vazia.
3. `tests/unitaires/lifecycle/migration-prebuild.test.ts` reprova uma
   migration nova que cria índice numa tabela quente sem o arquivo daqui, e
   um arquivo daqui sem a migration correspondente.

As colunas que o índice lê precisam existir **antes** da release do índice:
o passo roda antes das migrations, e um arquivo cujas tabelas ou colunas
ainda não existem é pulado (a migration constrói o índice sem
CONCURRENTLY).

## O que pode entrar

Só estes comandos (a lista permitida), um por `;`:

```sql
CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <nome> ON <tabela> ...;
DROP INDEX CONCURRENTLY IF EXISTS <nome>;
ALTER TABLE <tabela> ALTER COLUMN <coluna> SET STATISTICS <n>;
ALTER TABLE <tabela> SET (...);   -- ou RESET (...)
CREATE STATISTICS IF NOT EXISTS <nome> ... FROM <tabela>;
```

E, no topo, toda tabela que o arquivo toca:

```sql
-- requires-table: delivery_event
-- requires-column: delivery_event.txid
```

Sem `DO $$`, sem `ON ONLY`, sem schema no nome. DDL com pré-condição (uma
troca de tabela, um `OWNER TO`) vai em `prisma/post-deploy`, depois das
migrations.

## Como roda

- Cada espera de lock tem `lock_timeout` (`PREBUILD_LOCK_TIMEOUT_MS`, 3 s) e
  é repetida (`PREBUILD_LOCK_RETRIES`, 20 vezes): o CIC atrás de uma
  transação longa sai da fila em vez de segurar as escritas que entram
  atrás dele.
- Um índice que ficou inválido (um CIC que caiu no meio) é removido com
  `DROP INDEX CONCURRENTLY` e refeito.
- Tabela particionada: o passo cria o índice no pai com `ON ONLY`, faz um
  CIC em cada partição e as anexa (`ALTER INDEX ... ATTACH PARTITION`); o
  índice do pai fica válido com a última.
- No fim, nenhum índice que o passo administra pode estar inválido; outros
  inválidos aparecem como aviso no log.
- A segunda execução não faz nada. Um banco sem `_prisma_migrations` (novo)
  pula o passo inteiro.
- `PREBUILD_ONLINE_DDL=off` na Application `trajetto-api-migrate` desliga o
  passo, só em emergência.

Um CIC longo segura o `xmin` do cluster enquanto roda (o feed atrasa, não
pula): o índice de uma tabela grande sai numa release de madrugada.

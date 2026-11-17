# prisma/concurrent

DDL que não pode travar uma tabela quente, rodado pela etapa de release
**antes** do `prisma migrate deploy` (plano de escala, F2-01 e decisão D20)
e de novo logo depois dele, para o que a própria release acabou de criar.
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

### Coluna e índice na mesma release

O passo roda **duas vezes**: antes do `prisma migrate deploy` e logo
depois dele. Um arquivo cujas tabelas ou colunas ainda não existem é pulado
na primeira passada e aplicado na segunda, quando a migration já as criou.
É o caso de uma coluna nova e do índice dela na mesma release (o plano de
escala sai inteiro num push só): antes das migrations a coluna não existe.

Nesse caso a migration **não pode** construir o índice com a tabela cheia,
porque ela roda antes da segunda passada e seguraria as escritas durante o
build. Ela o constrói só com a tabela vazia (um banco novo: o molde do E2E,
o `yarn dev`, o banco sombra do Prisma), e com linhas quem constrói é a
segunda passada, com CONCURRENTLY, antes de a API nova subir:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "delivery_event" LIMIT 1) THEN
    CREATE INDEX IF NOT EXISTS "delivery_event_feed_idx" ON "delivery_event" ("businessId", (COALESCE("txid", 0)), "id");
  END IF;
END $$;
```

O arquivo daqui declara `-- requires-column` de toda coluna que o índice
lê e que uma migration acrescenta com `ADD COLUMN`; sem isso a primeira
passada tentaria o CIC numa coluna que ainda não existe e a etapa falharia.
O `migration-prebuild.test.ts` cobra as duas coisas: a declaração e o bloco
acima na migration (para qualquer coluna acrescentada com `ADD COLUMN`,
porque o repositório não sabe o que já está em produção; para uma coluna
antiga o bloco é um no-op). Com `PREBUILD_ONLINE_DDL=off`, um índice assim
fica faltando até a etapa rodar de novo com o passo ligado.

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
- Quando o passo desiste de um índice (uma duplicata num `UNIQUE`, um lock
  que não veio em nenhuma tentativa), ele remove o que o CIC deixou antes
  de sair com erro: a release falhou, a versão anterior segue servindo, e
  um `UNIQUE` inválido continuaria recusando as duplicatas que ela grava.
  Numa tabela particionada, um `UNIQUE` que falha numa partição sai
  inteiro (o pai e as partições já anexadas); um índice comum fica, e a
  próxima execução continua de onde parou. Se nem a remoção conseguir o
  lock, o log diz o `DROP` a rodar à mão.
- Tabela particionada: o passo cria o índice no pai com `ON ONLY`, faz um
  CIC em cada partição e as anexa (`ALTER INDEX ... ATTACH PARTITION`); o
  índice do pai fica válido com a última.
- No fim, nenhum índice que o passo administra pode estar inválido; outros
  inválidos aparecem como aviso no log.
- A segunda execução não faz nada. Um banco sem `_prisma_migrations` (novo)
  pula a primeira passada inteira; na segunda, as migrations já criaram
  tudo com as tabelas vazias, e ela não faz nada.
- Depois das migrations, um arquivo cujas tabelas ou colunas continuam
  faltando vira aviso no log (nenhuma migration as cria: arquivo velho).
- `PREBUILD_ONLINE_DDL=off` na Application `trajetto-api-migrate` desliga o
  passo, só em emergência.

Um CIC longo segura o `xmin` do cluster enquanto roda (o feed atrasa, não
pula): o índice de uma tabela grande sai numa release de madrugada.

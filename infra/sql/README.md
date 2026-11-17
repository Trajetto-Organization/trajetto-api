# infra/sql

SQL do cluster que não cabe numa migration: **roles, donos e grants**
(plano de escala, F5-08 e decisão D18). A etapa de release roda estes
arquivos **depois** do `prisma migrate deploy`, em ordem de nome, em **toda**
release, e também o molde do E2E e o `yarn dev`
(`infra/scripts/release-steps.ts`). Reaplicar sempre é o ponto: um
`pg_restore --no-owner` (restore, PITR, failover) apaga grants e donos, e só
um arquivo reaplicado converge de novo. Depois de qualquer restore, rode a
etapa antes de subir o runtime (`docs/deploy.md`, seção 15).

## O contrato de cada arquivo

- `<NN>-<nome>.sql`, idempotente: testa o próprio estado e só muda o que
  falta.
- Termina com um `RAISE NOTICE` que diz o que fez, e o último vale como o
  estado do passo, gravado em `release_step_state`:
  - `'applied: <o quê>'`: mudou algo;
  - `'skipped: <por quê>'`: já estava feito;
  - `'pending: <o que espera>'`: espera um estado (um lock que não veio, uma
    capability). O próximo deploy roda a etapa de novo sozinho
    (`GET /health/rollout`), ou um _Run workflow_ com `force_release`.
- Roda como uma consulta só (sem `BEGIN`, o arquivo inteiro é uma transação),
  com `lock_timeout` de 5 s se o arquivo não definir outro. Um erro reprova a
  etapa: a API não é implantada.
- Nunca deixa a sessão diferente (o runner desfaz `SET ROLE` e os tempos
  entre um arquivo e outro, mas não uma transação aberta).

## O que nunca entra aqui (com teste)

`tests/unitaires/lifecycle/infra-sql-rules.test.ts` reprova:

- `CREATE ROLE` fora de um teste de existência, ou sem `NOLOGIN`;
- `ALTER ROLE` com `LOGIN`, `NOLOGIN` ou `PASSWORD`, `CREATE USER` e
  `DROP ROLE` (ou `DROP USER`);
- um arquivo sem o `RAISE NOTICE` de estado;
- uma migration do Prisma que referencia um role: `CREATE ROLE`,
  `ALTER ROLE`, `DROP ROLE`, `GRANT`, `REVOKE`, `OWNER TO` ou `SET ROLE`.

O login e a senha de qualquer role são sempre do dono, à mão no Postgres: um
release nunca tranca o runtime fora do banco.

## Os arquivos

| Arquivo                | O que garante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `10-partitions.sql`    | o role `trajetto_partitions` (NOLOGIN), com USAGE e CREATE no schema, dono de cada tabela particionada e de todas as partições (plano de escala, F2-07). O job de partições cria, anexa, destaca e apaga como esse role, e é por ele que um login sem superusuário faz isso depois do corte dos roles                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `20-runtime-roles.sql` | os roles do runtime (plano de escala, F3-19), todos NOLOGIN: o grupo `trajetto_app` (SELECT, INSERT, UPDATE e DELETE em toda tabela, menos a trilha e as tabelas da etapa de release; USAGE nas sequências), `trajetto_http`, `trajetto_worker` e `trajetto_batch` dentro dele, e `trajetto_read` fora (só SELECT). Na trilha (`delivery_event`, e a `delivery_event_part` quando existir), http e worker leem, inserem e preenchem só o endereço do GPS; só o batch altera e apaga. Os tetos de cada role (`lock_timeout`, `idle_in_transaction_session_timeout`, `statement_timeout`), o batch nos roles de estatística e no `trajetto_partitions`, e os privilégios padrão do usuário da migração para as tabelas novas. Partição não recebe grant |

O `10-partitions.sql` troca o dono só do que tem outro dono, com
`lock_timeout` de 3 s por tabela: uma tabela cujo lock não veio fica
`pending` e o próximo release tenta de novo. A lista de tabelas é a do
registro de partições (`src/shared/database/partitions.ts`), mais as que o
plano ainda vai criar; uma tabela que não existe é pulada.

O `20-runtime-roles.sql` compara o catálogo com o que deve ser e muda só a
diferença: o que falta é concedido, e o que sobra para um dos cinco roles
(um grant feito à mão, uma partição criada pelo usuário da migração) é
revogado. Um grant recusado (lock, privilégio) fica `pending`. Nunca dá
LOGIN nem senha: o login de cada role e a troca das URLs são do dono
(`docs/deploy.md`, seção dos roles do banco). A guarda
`tests/unitaires/database/delivery-event-writes-guard.test.ts` recusa no
`src/` toda escrita na trilha que o grant recusaria.

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

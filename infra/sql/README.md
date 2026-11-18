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
- `ALTER ROLE` que não seja `SET`, `RESET` (também `IN DATABASE`) ou
  atributos que só tiram poder (`NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`): `LOGIN`, `NOLOGIN`,
  `PASSWORD`, `VALID UNTIL`, `CONNECTION LIMIT`, `RENAME` e um atributo
  vindo de variável ficam de fora;
- `CREATE USER`, `DROP ROLE` (ou `DROP USER`) e `DROP OWNED`;
- `REVOKE` no banco (`ON DATABASE`, o `CONNECT`) e `ALTER DATABASE` que
  não seja `SET` ou `RESET` (`CONNECTION LIMIT`, `ALLOW_CONNECTIONS`);
- um arquivo sem o `RAISE NOTICE` de estado.

As regras leem o SQL dinâmico também: um comando montado de pedaços de texto
(`'ALTER ROLE ' || quote_ident(r) || ' PASSWORD ' || ...`) conta como o
comando que ele roda. Um texto de `NOTICE` que só cita uma dessas palavras
também é lido assim: reescreva a frase. O teste também reprova:

- uma migration do Prisma que referencia um role: `CREATE ROLE`,
  `ALTER ROLE`, `DROP ROLE`, `GRANT`, `REVOKE`, `OWNER TO` ou `SET ROLE`.

O login e a senha de qualquer role são sempre do dono, à mão no Postgres: um
release nunca tranca o runtime fora do banco.

## Os arquivos

| Arquivo                 | O que garante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `10-partitions.sql`     | o role `trajetto_partitions` (NOLOGIN), com USAGE e CREATE no schema, dono de cada tabela particionada e de todas as partições (plano de escala, F2-07). O job de partições cria, anexa, destaca e apaga como esse role, e é por ele que um login sem superusuário faz isso depois do corte dos roles                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `15-untrusted-code.sql` | um event trigger que recusa, antes de rodar, todo DDL de um role que não seja superusuário nem membro do dono das tabelas (o usuário das migrations), menos o que o job de partições faz (`CREATE`, `ALTER` e `DROP TABLE`): nenhuma função, operador, tipo, regra ou gatilho de quem só tem o CREATE das partições. Sem ele, o login do batch plantaria no schema uma sobrecarga que o superusuário da etapa e das migrations rodaria                                                                                                                                                                                                                                                                                                                                              |
| `20-runtime-roles.sql`  | os roles do runtime (plano de escala, F3-19), todos NOLOGIN: o grupo `trajetto_app` (SELECT, INSERT, UPDATE e DELETE em toda tabela, menos a trilha e as tabelas da etapa de release; USAGE nas sequências), `trajetto_http`, `trajetto_worker` e `trajetto_batch` dentro dele, e `trajetto_read` fora (só SELECT). Na trilha (`delivery_event`, e a `delivery_event_part` e a `delivery_event_legacy` quando existirem), http e worker leem, inserem e preenchem só o endereço do GPS; só o batch altera e apaga. Os tetos de cada role (`lock_timeout`, `idle_in_transaction_session_timeout`, `statement_timeout`), o batch nos roles de estatística e no `trajetto_partitions`, e os privilégios padrão do usuário da migração para as tabelas novas. Partição não recebe grant |
| `50-cluster-epoch.sql`  | a linha de `cluster_epoch` (plano de escala, U-14): a época do cluster, que sobe quando o `system_identifier` ou a timeline mudam (PITR, promote, cluster novo); o cursor do feed da integração a carrega                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

O `50-cluster-epoch.sql` (plano de escala, U-14) mantém a linha de
`cluster_epoch` (a tabela é de uma migration; a linha é daqui): compara o
`system_identifier` de `pg_control_system()` e a timeline de
`pg_control_checkpoint()` com o par guardado e, quando mudaram (um PITR, um
promote, um cluster novo), sobe a época em um. A primeira execução grava a
época 1. É a época que o cursor do feed da integração carrega (F2-04): depois
de um PITR ou de um failover os xids voltam a ser usados, e a época separa as
duas histórias. Até a etapa rodar, o `ops-heartbeat` alerta
`cluster-epoch-stale`.

O `10-partitions.sql` troca o dono só do que tem outro dono. Como o arquivo
é uma transação, o lock do pai fica preso até o fim e cada ping espera
junto: por isso as esperas do arquivo inteiro dividem **um** orçamento de
3 s (abaixo do `lock_timeout` de 5 s da URL do runtime), e, gasto o
orçamento, uma tabela só troca de dono se o lock estiver livre na hora. Uma
tabela cujo lock não veio fica `pending` e o próximo release tenta de novo.
O pai vem antes das partições, na ordem do INSERT (pai, depois partição): a
ordem inversa travaria um ping no meio do caminho em deadlock. A lista de tabelas é a do
registro de partições (`src/shared/database/partitions.ts`), mais as que o
plano ainda vai criar; uma tabela que não existe é pulada.

O `15-untrusted-code.sql` fecha o que o CREATE no schema do
`trajetto_partitions` abriria (revisão de segurança dos itens F3-19 e
F1-25): o `trajetto_batch` é membro dele, e o Postgres roda a sobrecarga
que melhor casa com uma chamada sem schema, esteja onde estiver
(CVE-2018-1058). Uma `public.array_to_string(text[], text)` criada com as
credenciais do batch rodaria como superusuário na release seguinte, perto
das chaves do PITR. O event trigger deixa o role criar, alterar e apagar
tabelas, e mais nada; a função dele fica num superusuário, com o
`search_path` fixo, e uma função de mesmo nome feita antes por outro role
é tomada de volta. Só um superusuário cria event trigger: com outro
usuário, o passo fica `pending`. Fora do alcance dele: uma tabela do role
roda os próprios defaults e CHECKs como quem grava nela, então uma
migration que precise gravar numa tabela particionada grava como
`trajetto_partitions` (`SET LOCAL ROLE`), nunca como o superusuário.

O `20-runtime-roles.sql` compara o catálogo com o que deve ser e muda só a
diferença: o que falta é concedido, e o que sobra para um dos cinco roles
(um grant feito à mão, uma partição criada pelo usuário da migração) é
revogado. Um grant recusado (lock, privilégio) fica `pending`. Nunca dá
LOGIN nem senha: o login de cada role e a troca das URLs são do dono
(`docs/deploy.md`, seção dos roles do banco). A guarda
`tests/unitaires/database/delivery-event-writes-guard.test.ts` recusa no
`src/` toda escrita na trilha que o grant recusaria.

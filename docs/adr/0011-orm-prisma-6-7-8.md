# ADR 0011 — ORM: Prisma 7.10.1 com adapter-pg (no-go na 1ª tentativa, go na 2ª; o 8 não saiu)

- **Status:** aceito em 28/10/2026. A primeira tentativa deu no-go (abaixo);
  a [segunda tentativa](#resultado-da-segunda-tentativa) deu **go**, e o
  **Prisma 7.10.1** foi [adotado](#integração-sobre-a-staging) numa
  publicação própria, depois da publicação das outras correções da rodada
  (ainda no 6.1).
- **Escopo:** `trajetto-api`.
- **Spec:** §15 de `README_AJUSTES_FINAIS_TRAJETTO.md` (avaliar e, se seguro,
  atualizar do Prisma 6 para o 8).
- **Prazo que pesa:** o Prisma 6 recebe patches de segurança só até
  **19/11/2026**.

## Contexto

O dono quer o Prisma 8, depois de ver ganho de velocidade e de tamanho em
outro projeto. A cifra de "~87% do driver `pg` nativo" vem do blog do Prisma
(Prisma 8 contra Prisma 7, um workload, sem Prisma 6) e foi tratada como
hipótese externa, não como medida do Trajetto.

Versões em 28/10/2026:

| Item                        | Hoje (staging)               | Ensaio                                                                  |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `prisma` / `@prisma/client` | 6.1.0 / 6.1.0                | 7.10.1 / 7.10.1 (alinhados)                                             |
| Driver                      | engine Rust (Node-API, musl) | `@prisma/adapter-pg` 7.10.1 + `pg` 8.23.1 (`@types/pg` 8.23.1)          |
| Gerador                     | `prisma-client-js`           | `prisma-client-js` (deprecado no 7, ainda suportado)                    |
| Node / TypeScript / módulos | 22.21.1 / 5.7.2 / CommonJS   | iguais (o 7.10.1 pede Node `^20.19 \|\| ^22.12 \|\| >=24` e TS `>=5.4`) |
| PostgreSQL / Redis          | 16 / 7                       | iguais                                                                  |

**O Prisma 8 não está disponível.** No registro npm (`npm view … dist-tags`,
28/10/2026), `prisma` latest é **8.0.0-rc.28** e `@prisma/client` latest é
**7.10.1**: não existe `@prisma/client` 8.0.0. A página de status do Prisma
dá o 8 como _release candidate_. Atenção: `npx prisma` sem versão instala hoje
um RC do 8.

Mesmo GA, o 8 não serviria sem reescrita (matriz abaixo): exige o gerador
`prisma-client`, TypeScript 5.9+, e não tem transação interativa com
`isolationLevel`/`timeout`/`maxWait`, `$extends`, `increment`, `hasSome` nem
`Prisma.sql`, que a API usa.

| Recurso que a API usa                               | 6.1     | 7.10.1                                                            | 8.0 RC                   |
| --------------------------------------------------- | ------- | ----------------------------------------------------------------- | ------------------------ |
| CommonJS + `prisma-client-js`                       | sim     | sim (deprecado)                                                   | não (só `prisma-client`) |
| TypeScript 5.7                                      | sim     | sim                                                               | não (5.9+)               |
| `$transaction` interativa com `isolationLevel` etc. | sim     | sim                                                               | não                      |
| `$extends` (contadores dos testes de fan-out)       | sim     | sim                                                               | não                      |
| `increment`, `hasSome`, P2002/P2025                 | sim     | sim                                                               | não                      |
| `Prisma.sql` / `join` / `raw`                       | sim     | sim                                                               | não (`db.raw.sql`)       |
| preview `metrics` (`$metrics.json()`)               | sim     | **removido**                                                      | —                        |
| pool pela `DATABASE_URL` (`connection_limit` etc.)  | sim     | **ignorado pelo `pg`**: mapeado à mão                             | —                        |
| `meta.target` no P2002                              | colunas | **nome do índice**, em `meta.driverAdapterError.cause.constraint` | —                        |
| conflito serializável (40001) no COMMIT             | P2034   | **`DriverAdapterError` cru** (`TransactionWriteConflict`)         | —                        |
| banco caindo no COMMIT (57P01, conexão resetada)    | P1017   | **`DriverAdapterError` cru** (`postgres`, `ConnectionClosed`)     | —                        |
| parâmetros de SQL cru tipados                       | sim     | **não** (o `pg` manda sem tipo)                                   | —                        |
| `migrate deploy` / `_prisma_migrations`             | sim     | sim (mesmo schema engine)                                         | sistema novo (`db sign`) |

## Decisão

**Não subir o Prisma 7.10.1 nesta rodada (no-go).** A API fica no 6.1.0.

O ensaio de migração (branch local `feat/prisma-7`, sem commit) ficou completo
e funcional, mas dois gates não passaram, com evidência medida:

1. **Um teste E2E de orçamento de statements falha por uma regressão real do
   Prisma 7.** `tests/E2E/driver-positions-statement-budget.test.ts` aceita
   no máximo 9 statements por flush de posições; o 7.10.1 faz 11. O teste não
   foi afrouxado.
2. **O desempenho piora além do ruído** em p95, número de queries, carga no
   banco, memória e imagem. Melhora em p99 e em CPU por requisição.

A migração para o 7 continua necessária por causa do fim do suporte do 6. O
6.19.3 não serve de ponte: tem a mesma data de fim, +145 MB e 3 avisos altos.

## Gates do ensaio

| Gate                            | Resultado                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`              | 0 erros                                                                                                                                                                                                         |
| Suíte unitária                  | 502 arquivos: 5.315 testes ok, 1 falha, 26 pulados. A falha (`quality/coverage-config`, regex do `ci.yml` contra CRLF no Windows) falha igual no 6.1                                                            |
| E2E (290 arquivos, lotes de 8)  | os arquivos afetados pelas correções passam isolados (68/68 sobre o SQL alterado); **`driver-positions-statement-budget` falha (11 > 9)**. Falta uma passada completa única numa máquina sem carga de terceiros |
| `prisma migrate deploy` do zero | 135/135 nas duas versões; `pg_dump --schema-only` idêntico                                                                                                                                                      |
| `audit-ci`                      | passa nas duas (0 críticas; altas, moderadas e baixas iguais)                                                                                                                                                   |
| Imagem: `migrate` e `serve`     | passam nas duas; readiness 200 em 5,0 s (6.1) e 6,9 s (7.10.1)                                                                                                                                                  |
| Benchmark                       | **pior além do ruído** (abaixo)                                                                                                                                                                                 |

## Medições

**Método.** Build `tsup` das duas versões lado a lado, mesmo ambiente do
`tests/load/compose.load.yaml`, uma cópia nova do banco de carga (120 mil
entregas, 40 empresas) por execução, k6 com `tests/load/load.js` a 60
operações/s por 2 min depois de 20 s de aquecimento, 3 execuções por versão
em ordem alternada (ABBAAB), `pg_stat_statements` zerado antes de cada uma.
Medição local numa máquina compartilhada, não de produção.

| Média de 3 (± desvio)          | 6.1               | 7.10.1            | Δ             |
| ------------------------------ | ----------------- | ----------------- | ------------- |
| Vazão                          | 58,8 req/s        | 58,9 req/s        | = (taxa fixa) |
| Falhas                         | 0                 | 0                 | =             |
| p50                            | 20,1 ± 0,5 ms     | 19,4 ± 0,7 ms     | −3% (ruído)   |
| **p95**                        | **41,4 ± 1,4 ms** | **61,9 ± 1,4 ms** | **+50%**      |
| p99                            | 91,6 ± 0,9 ms     | 67,4 ± 3,2 ms     | −26%          |
| CPU do processo por requisição | 10,01 ± 0,25 ms   | 8,40 ± 0,12 ms    | −16%          |
| RSS médio                      | 214 MB            | 308 MB            | **+44%**      |
| **Statements por requisição**  | **10,68**         | **15,60**         | **+46%**      |
| Tempo de execução no Postgres  | 37,6 s            | 48,4 s            | **+29%**      |
| Imagem comprimida              | 115,4 MB          | 139,8 MB          | **+21%**      |
| Imagem descompactada           | 417,6 MB          | 586,7 MB          | +40%          |

Por superfície (mediana / p95): `dashboard.overview` melhora (90 → 63 /
98 → 73 ms); `delivery.summary` (20 → 43 / 25 → 49 ms) e `route.tower`
(35 → 63 / 42 → 71 ms) pioram; o resto empata.

**Causas medidas.**

1. **Statements extras.** O 7.10.1 executa a carga de uma relação mesmo com
   FK nula ou conjunto pai vazio (`profile_access WHERE id = NULL`,
   `permission … IN (NULL)`, `branch … IN (NULL)`). A busca da sessão, que
   roda em toda requisição autenticada, custa 7 statements no 7 contra 3–4
   no 6.
2. **Plano genérico perdido.** O engine do 6 usava prepared statements
   nomeados, e o Postgres passa a plano genérico depois de 5 execuções; o
   `pg` manda statements sem nome, com plano custom a cada vez. A CTE de
   `countDayDeliveries` (torre e resumo) leva 2,27 ms por execução no 6.1 e
   21,1 ms no 7.10.1. Forçar o `plan_cache_mode` inverte o resultado nas
   duas versões (mediana de `/delivery/operation-summary`: 6.1 padrão
   22,7 ms; 7.10.1 padrão 51,7 ms; 6.1 com plano custom forçado 51,1 ms;
   7.10.1 com plano genérico forçado 27,7 ms).
3. **Memória e tamanho.** Compilador de query em WebAssembly sob carga; o CLI
   do 7 traz Studio, `@prisma/dev` com pglite, `effect` e os compiladores de
   todos os bancos. A instalação de produção vai de 215 MB (483 pacotes) a
   447 MB (793 pacotes). O engine do 6 (15,8 MB) sai, mas o CLI entra maior.
   Tirar Studio e `@prisma/dev` da imagem **quebra o `migrate deploy`**.

## O que o ensaio já resolveu (fica para a próxima tentativa)

- Pool: os parâmetros da `DATABASE_URL` mapeados à mão para o `pg`
  (`connection_limit` → `max`, `pool_timeout`, `connect_timeout`,
  `socket_timeout` → `query_timeout`, `max_idle_connection_lifetime`).
- Falhas do próprio `pg` (pool cheio, conexão encerrada, timeout de leitura)
  tipadas como banco indisponível, para manter o 503 com `Retry-After`.
- Métricas do pool lidas dos contadores do `pg`, com o mesmo contrato de
  `/health/metrics`.
- P2002 que nomeia o índice: os leitores conferidos contra os índices únicos
  reais.
- SQL cru: `VALUES` com parâmetro sem tipo vira `text`, e `Date` vai sem
  offset; os 10 pontos achados foram corrigidos (`::boolean`, instantes em
  ISO).
- Testes: fábrica única de `PrismaClient`, `vi.spyOn` + `mockRestore` trocados
  por atribuição (o cliente do 7 é um Proxy).

## Menor caminho para virar go

1. **Statements da sessão:** reescrever `UserRepository.loadUserById` sem
   `include` em relação anulável (uma query com `LEFT JOIN` e `json_agg`, ou
   cargas condicionadas às FKs); reexecutar os orçamentos de statements e o
   benchmark; abrir issue em <https://github.com/prisma/prisma> com o
   reprodutor. Avaliar `relationJoins` (ainda preview) só como mudança
   separada.
2. **Plano da torre e do resumo:** corrigir o plano custom de
   `countDayDeliveries` com `EXPLAIN ANALYZE` sobre valores reais (ajuda as
   duas versões), ou avaliar o `statementNameGenerator` do adapter
   (statements nomeados, com limite de cache).
3. **Imagem:** separar um alvo de migração no Dockerfile, com o CLI só na
   imagem do release step e o runtime só com `@prisma/client`, adapter e
   `pg` (ajusta `infra/scripts/run-release-migrations.sh` e o `deploy.yml`),
   ou um prune calculado pelo grafo com smoke do `migrate deploy`.
4. Reexecutar todos os gates (E2E completo de uma vez, numa máquina sem
   carga de terceiros) e o benchmark ABBAAB.
5. Prazo: antes de **19/11/2026**.

Nota para quem integrar a branch: `prisma/vitest-environment-prisma` é uma
dependência `file:` que o Yarn 1 copia para `node_modules` e não recopia num
`yarn install` comum. Depois de trazer a branch, rode `yarn install --force`,
senão o E2E roda o ambiente antigo e falha no Prisma 7 (o passo também está
em [`testes.md`](../testes.md#comandos) e no README).

## Resultado da segunda tentativa

**Data:** 28/10/2026, à tarde. **Versão:** 7.10.1 (`prisma`,
`@prisma/client` e `@prisma/adapter-pg`), mesmo ensaio da primeira
tentativa, com os itens 1 e 2 do [menor caminho](#menor-caminho-para-virar-go)
feitos. **Decisão: go.**

O que mudou:

1. **Sessão.** `UserRepository.loadUserById` só lê o perfil e o motorista
   quando a chave existe. Statements por sessão em 100 usuários reais da base
   de carga: admin 3 (6.1) → 3, com perfil 5 → 5, motorista 4–5 → 4–5; o
   master paga +2 (3 contra 1). O valor devolvido é idêntico nos 100.
2. **Outras leituras quentes.** Um helper só (`related-rows`: uma query para
   as chaves presentes, nenhuma sem chave) no detalhe e nas listas de
   entregas, no feed da torre, nas rotas, na API pública, no chat e no
   motorista. Em 44 casos de snapshot, 191 statements contra 194 no 6.1 e 298
   na primeira tentativa, com valor e ordem das chaves idênticos.
3. **`countDayDeliveries`.** A causa do plano custom lento era a estimativa
   (correlação empresa × status), não o Prisma: cada braço da CTE passou a
   levar o motorista e o status, e a junção final saiu. Plano custom 37,3 →
   1,6 ms; genérico 3,7 → 1,8 ms; 258 casos equivalentes, 0 diferenças.
   **Portada para o 6.1 nesta publicação** (só o SQL; o envio de instantes em
   ISO é do 7).

| Gate                         | Resultado                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`           | 0 erros                                                                              |
| Suíte unitária               | 5.323 ok; a única falha é a mesma `coverage-config` do CRLF no Windows, igual no 6.1 |
| E2E completo (290 arquivos)  | 290/290 no código final; `driver-positions-statement-budget` passa (≤ 9; eram 11)    |
| `migrate deploy` do zero     | 135/135 nas duas versões; `pg_dump --schema-only` idêntico                           |
| Imagem (`migrate` e `serve`) | passam; readiness 200 em 7,8 s (6.1: 5,3 s)                                          |

Benchmark com o mesmo método, em duas séries ABBAAB (6 execuções por versão):

| Média de 6 (± desvio)          | 6.1             | 7.10.1         | Δ                     |
| ------------------------------ | --------------- | -------------- | --------------------- |
| p50                            | 20,9 ± 0,8 ms   | 21,4 ± 0,5 ms  | +2% (ruído)           |
| p95                            | 44,1 ± 3,7 ms   | 46,3 ± 3,8 ms  | +5% (dentro do ruído) |
| p99                            | 92,6 ± 2,7 ms   | 63,4 ± 16,0 ms | −32%                  |
| CPU do processo por requisição | 10,53 ± 0,38 ms | 8,14 ± 0,25 ms | −23%                  |
| RSS médio                      | 208 MB          | 291 MB         | +40%                  |
| Statements por requisição      | 10,71           | 10,68          | −0,3%                 |
| Tempo de execução no Postgres  | 37,0 s          | 30,1 s         | −19%                  |
| Imagem comprimida              | —               | —              | +21%                  |

O p95 foi maior no 7.10.1 em 5 dos 6 pares, por pouco: é uma tendência a
acompanhar na staging, não um gate reprovado. RSS e imagem ficam piores pelos
motivos da [primeira tentativa](#medições) (compilador em WebAssembly e o CLI
maior), com folga no contêiner.

**Por que não saiu junto com as outras correções:** o patch toca 359
arquivos, 17 deles também alterados nesta rodada. Ele entrou por cima do
commit publicado (`a6d0bcc`), com os gates de novo, para que uma falha no
Prisma não segurasse as outras correções.

## Integração sobre a staging

**Data:** 28/10/2026, à noite. **Base:** `a6d0bcc` (staging, Prisma 6.1).
O patch da segunda tentativa entrou com `git apply --3way`: três conflitos,
todos resolvidos mantendo as duas mudanças — o comentário de
`countDayDeliveries` (o SQL reescrito já estava na staging), o `Dockerfile`
(a base Alpine com o binário do Node e o prune desta rodada, mais o Prisma 7:
sem query engine nem `PRISMA_QUERY_ENGINE_LIBRARY`, com `prisma.config.ts`,
sem `pglite` e sem os compiladores de outros bancos) e o `README.md`. Os três
testes E2E novos da rodada passaram a abrir o cliente por
`createPrismaClient`. Em 29/10/2026 a branch foi rebaseada sobre `d413cb1`
(a staging com a conferência semanal das faixas da Cloudflare e o IPv4
preferido pelo sistema), sem conflitos.

A revisão da integração achou o que o Prisma 7 mudou por baixo do código:
o COMMIT recusado por serialização chega como erro cru do adapter (o retry de
abastecimento e checklist só olhava `P2034`), pool cheio e conexão que não
abre chegam como `DatabaseUnavailableError` (o retry da trilha de auditoria
só olhava `P2024`/`P1001`) e alguns errnos de rede não eram mapeados. Uma
segunda rodada achou mais dois pontos. O COMMIT de uma `$transaction`
interativa com o banco indo embora (backend encerrado, conexão resetada)
também chega como erro cru do adapter e virava 500 em vez de 503 com
Retry-After. E as filas e as métricas comparam colunas `timestamp(3)` em UTC
com `now()`, o que só acertava porque o servidor está em UTC; agora o pool
abre toda sessão com `TimeZone=UTC` (a dependência já existia no Prisma 6).
As correções entraram na árvore final, com testes unitários e quatro E2E
novos (`serializable-commit-retry`, `audit-trail-unavailable-database`,
`commit-database-unavailable-http` e `database-session-timezone`), e todos
os gates foram refeitos nela depois do rebase, em 29/10/2026 de madrugada,
com a env do job `test` do `deploy.yml`:

| Gate                                     | Resultado                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-ci`, `prettier --check`, `tsc`    | passam (`tsc` com 0 erros)                                                                                                                            |
| Suíte unitária com cobertura (env do CI) | 512 arquivos: 511 ok e 1 pulado; 5.663 testes ok, 0 falhas, 29 pulados; cobertura 77,56 / 84,57 / 67,53 / 77,56 % (pisos 70,8 / 82,57 / 57,62 / 70,8) |
| E2E completo (297 arquivos, lotes de 8)  | 294 ok de primeira, 0 falhas, 3 pulados; 3.251 testes ok e 15 pulados, em 25 min                                                                      |
| `migrate deploy` do zero                 | 135/135, `migrate status` em dia; o `migrate diff` (banco migrado → `schema.prisma`) só mostra os 3 índices de SQL cru já conhecidos                  |
| Imagem + smoke do CI (`deploy.yml`)      | passa em 32 s: migrations do zero e seeds no modo `migrate`, boot saudável, commit conferido no `/health/liveness`, readiness 200                     |

O arquivo unitário pulado (`compose-ci-siblings`) e os 29 testes pulados
dependem dos repositórios irmãos (`trajetto-ui`, `trajetto-mobile`), que não
existem ao lado do worktree nem no checkout do CI. Os 3 E2E pulados são os mesmos do CI:
`resilience-database-loss` e `resilience-redis-loss` (injeção de falha com
Docker, que só arma com os contêineres próprios na porta 54322; neste
Windows a porta cai numa faixa reservada pelo sistema e o pacote não sobe) e
`upload-storage-roundtrip`, que passou 9/9 à parte contra o MinIO
descartável. Nenhum E2E precisou de reexecução.

Depois desses gates, uma terceira conferência achou mais dois pontos,
corrigidos com testes. A conexão cujo COMMIT o Postgres respondeu com FATAL
(backend encerrado, 57P01) voltava ao pool como saudável e derrubava com 503
a query seguinte que a pegasse antes de o `pg` ler o fim do socket (8 de 8 a
0 ms, pools de 1 e 10); o Client da API agora fecha a conexão nessa resposta
(`commit-terminated-connection`, E2E novo). E a trilha de auditoria não
repetia a escrita recusada com "the database system is starting up" (57P03,
que no 7 chega como P2039 ou P2010, sem código próprio), recusa que só
acontece antes de qualquer instrução; agora repete uma vez, lendo a causa do
adapter. Para essas duas correções rodaram os arquivos tocados e os E2E de
banco relacionados, não a suíte completa.

Benchmark curto (mesmo método, ABBA, 2 execuções por versão, `a6d0bcc`
contra a integração no `cd36d53`, o primeiro commit do Prisma 7, antes das
correções da revisão e do rebase):

| Média de 2                     | 6.1 (`a6d0bcc`) | 7.10.1  | Δ    |
| ------------------------------ | --------------- | ------- | ---- |
| p50                            | 20,4 ms         | 19,8 ms | −3%  |
| p95                            | 41,4 ms         | 41,5 ms | =    |
| p99                            | 91,7 ms         | 52,2 ms | −43% |
| CPU do processo por requisição | 10,53 ms        | 7,55 ms | −28% |
| RSS médio                      | 212 MB          | 293 MB  | +38% |
| Statements por requisição      | 10,75           | 10,72   | =    |
| Tempo de execução no Postgres  | 36,5 s          | 28,9 s  | −21% |

Imagem da árvore final (`docker image inspect` / soma do histórico /
`docker images`; medida de novo depois do rebase, com os mesmos números),
contra a imagem do 6.1 com as mesmas regras de `Dockerfile`: comprimida
87,6 → 114,8 MB (+27,2 MB, +31%), descompactada 285 → 431 MB (+51%),
listada 373 → 546 MB (+46%), 14 → 15 camadas (a nova é o
`prisma.config.ts`). O `node_modules` vai de 27,4 para 59,0 MB comprimidos;
o `.prisma` cai de 7,7 para 3,2 MB. O aumento é o CLI do 7, que a etapa de
release usa no `migrate deploy` (Studio, `@prisma/dev`, `effect`); separar
um alvo só de migração no `Dockerfile` (item 3 do menor caminho) é o próximo
passo para devolver esse tamanho.

## Fontes

- Status e suporte: <https://www.prisma.io/docs/orm/release-status>.
- Guia 6 → 7: <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>.
- Pool no 7: <https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool>.
- Adapter PostgreSQL: <https://www.prisma.io/docs/orm/overview/databases/postgresql>.
- A alegação de desempenho do 8: <https://www.prisma.io/blog/prisma-next-performance-benchmark>.
- Registro npm: `npm view prisma dist-tags` e `npm view @prisma/client dist-tags` (28/10/2026).
- Estado atual da conexão no 6.1: [`arquitetura.md` → Conexão com o Postgres](../arquitetura.md#conexão-com-o-postgres).

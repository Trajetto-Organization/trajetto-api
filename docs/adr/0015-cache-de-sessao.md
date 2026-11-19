# ADR 0015 — Cache de sessão na memória do processo, desligado por padrão

- **Status:** aceito em 19/11/2026 (plano de escala, onda 19, F5-23), com o
  código pronto e **desligado** (`SESSION_CACHE_TTL_MS=0`). Ligar na produção
  depende do ABBA do portão (LOAD-11) mostrar ganho e do aceite por escrito
  do dono do limite de 1 s nas outras réplicas (decisão D2 do plano).
- **Escopo:** `trajetto-api`: `src/shared/auth/session-cache.ts`,
  `src/modules/middlewares/ensure-authenticated.ts` e as rotas
  `POST /route/positions` e `GET /route/control-tower`.
- **Depende de:** o log de revogação por gatilho (F5-21) e o feed de
  revogação (F5-22); [ADR 0002](./0002-redis-descartavel.md) (nada de sessão
  no Redis).

## Contexto

Toda requisição autenticada lê a sessão no banco: o usuário com a empresa,
os módulos, o perfil e o motorista, e a família do refresh token. Desde a
F4-05 é uma consulta só, mas é a consulta mais frequente do produto, porque
o telefone de cada motorista na rua envia as posições a cada minuto e a torre
de controle atualiza a cada poucos segundos. No degrau de 5 M entregas por
mês, as duas rotas juntas passam de centenas de requisições por segundo, e
cada uma paga a leitura da sessão antes de fazer o próprio trabalho.

Guardar a sessão conferida por alguns segundos tira essa leitura. O risco é
o de todo cache de autorização: uma sessão encerrada (logout, senha trocada,
acesso revogado, empresa desativada, módulo desligado, motorista inativado)
continuar valendo enquanto a cópia vive. Antes do log de revogação, só um
aviso pelo Redis, que pode se perder e não existe numa mudança feita direto
no banco, diria às outras réplicas que a cópia morreu.

## Decisão

Um cache da sessão conferida, **na memória de cada processo**, nunca no
Redis, que só vale nas rotas que pedem (`config.sessionCache`) e só com
`SESSION_CACHE_TTL_MS` maior que 0. As regras:

1. **Só duas rotas:** `POST /route/positions` e `GET /route/control-tower`.
   As outras leem a sessão em toda requisição, como antes.
2. **Nunca um MASTER:** a sessão dele alcança todas as empresas.
3. **Desligado por padrão, com teto:** `SESSION_CACHE_TTL_MS=0`; no máximo
   15 s, e nunca além da validade do próprio access token.
4. **O token é conferido sempre:** assinatura e validade antes de olhar o
   cache. A chave é o usuário, a família e a `session_version` do token: o
   cache só diz que essa sessão passou pela conferência há pouco.
5. **O guard de tenant roda em toda requisição**, também na que sai do
   cache: ele depende do que a requisição pede. O orçamento do painel
   (F2-28) também.
6. **Falha fechada:** a cópia só é servida enquanto o feed de revogação leu
   o log há pouco (`fresh()`). Feed desligado
   (`REVOCATION_FEED_POLL_MS=0`), banco sem responder ao feed ou processo
   recém-iniciado: toda requisição lê o banco, como se o cache não existisse.
7. **Invalidação síncrona na réplica que revoga:** os helpers de segurança
   do `src/websocket.ts`, que toda revogação já chama depois do commit,
   tiram a sessão do cache antes de a requisição que revogou responder. O
   que não chama helper (filial desativada, motorista trocado de filial)
   chama `announceSessionRevocation`.
8. **Nas outras réplicas, em até 1 s:** cada linha do log tira as sessões
   que nomeia (usuário, família, empresa, motorista, filial ou perfil). Pela
   dica do pub/sub chega em milissegundos; sem ela, pelo poll de 1 s. Um
   `gap` do feed esvazia o cache.
9. **Uma leitura que cruzou uma revogação não é guardada:** cada revogação
   avança uma época, e a sessão lida antes dela nunca é guardada depois.
10. **Com teto de tamanho:** 10.000 sessões por processo; sai a mais antiga.

O que a cópia guarda é o mesmo usuário que a consulta única já deixa na
memória da requisição, com o fuso da empresa. Numa requisição servida pelo
cache, a cópia é da própria requisição (`structuredClone`), e o caso de uso
lê o usuário dali, sem voltar ao banco.

## Consequências

- **Desligado, nada muda:** a revogação continua imediata em toda réplica.
  O log por gatilho e o feed já fortalecem os sockets (F5-24) sem o cache.
- **Ligado, o limite é 1 s nas outras réplicas** (na réplica que revoga,
  nenhum). É esse limite que o dono aceita por escrito antes de ligar.
- **Campos que não revogam ficam até o TTL:** o nome, o e-mail e o fuso da
  empresa de uma sessão guardada podem ter até 15 s de idade. O fuso decide
  o "hoje" da torre; uma troca de fuso aparece na torre até 15 s depois.
- **O teto do TTL cobre o que o feed não vê:** uma revogação cuja linha o
  feed não alcança (a transação que tomou um id antes da primeira leitura
  do processo e fez commit depois) vale pelo TTL, no máximo 15 s.
- **A conta da memória:** uma sessão de gestor tem alguns KB (o perfil com
  as permissões); 10.000 sessões ficam em dezenas de MB, dentro do heap.
- **Números:** a seção `session_cache` do `ops_sample` (acertos, faltas,
  pedidos com o feed parado, guardadas, descartadas por corrida, derrubadas
  por revogação, gaps e o tamanho), para o ABBA do portão.
- **Toda coluna nova lida pela conferência da sessão precisa de gatilho**
  (`src/shared/auth/session-revocation.ts`): o unitário
  `session-revocation-coverage` cobra.

## Como desligar

`SESSION_CACHE_TTL_MS=0` (ou vazio) no _Environment_ da Application e um
redeploy. Nenhum dado fica para trás: o cache morre com o processo.

## Fontes

- Plano de escala, item F5-23 e decisão D2.
- Provas: `tests/unitaires/auth/session-cache.test.ts` (as regras),
  `tests/unitaires/security/ensure-authenticated-session-cache.test.ts` (o
  middleware) e `tests/E2E/session-cache-revocation.test.ts` (logout na
  mesma réplica recusado na requisição seguinte; em outra réplica, em até
  1 s com o pub/sub e em até 2 s sem ele).
- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real),
  "Cache de sessão".

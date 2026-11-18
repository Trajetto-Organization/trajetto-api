# socket-cap-high — Sockets de uma réplica perto do teto

**Dispara quando:** os sockets de uma réplica chegam a 80% do teto dela (`socket_cap`).

## O que significa

Cada réplica segura no máximo `socket_cap` sockets: o menor entre `SOCKET_MAX_CONNECTIONS` (5.000) e o limite de descritores de arquivo do processo menos `SOCKET_FD_RESERVE` (1.024), para os sockets nunca tirarem os descritores do Postgres, do Redis e do HTTP (plano de escala F5-31). Acima de 80%, o próximo deploy não cabe: os sockets da réplica que sai reconectam nas que ficam, e os handshakes passam a ser recusados com `SOCKET_UNAVAILABLE` e a espera de 5 a 10 s. Ninguém perde dado (as posições seguem pelo HTTP), mas o mapa e o chat ficam atrasados.

## Primeira ação

1. Veja `realtime` em `/health/metrics` de cada réplica: `local_connections`, `socket_cap`, `fd_limit` e as recusas em `handshakes.refused`.
2. Some os sockets de todas as réplicas e compare com o teto de uma a menos (o que sobra num deploy).
3. Se o teto veio dos descritores (`fd_limit` baixo), suba o limite `nofile` do serviço no Dokploy antes de mexer em réplicas.
4. Se a carga é legítima, mais uma réplica da `trajetto-api` resolve; não suba `SOCKET_MAX_CONNECTIONS` acima do que os descritores e a memória aguentam.

```sql
SELECT DISTINCT ON (replica) replica, ts,
  metrics -> 'realtime' ->> 'local_connections' AS sockets,
  metrics -> 'realtime' ->> 'socket_cap' AS teto
FROM ops_sample
WHERE ts > now() - interval '5 minutes' AND role <> 'cluster'
ORDER BY replica, ts DESC;
```

## Como confirmar

Os sockets de cada réplica voltam abaixo de 80% do `socket_cap`, e `handshakes.refused.connections` para de crescer.

## Quando escalar

Se o total de sockets passa do teto de N − 1 réplicas, o papel `trajetto-realtime` do plano de escala ou mais um nó entram na conversa: chame o dono.

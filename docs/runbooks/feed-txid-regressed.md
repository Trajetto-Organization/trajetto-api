# feed-txid-regressed — Txid do feed à frente do cluster

**Dispara quando:** o maior `delivery_event.txid` gravado não está abaixo do próximo xid que o cluster vai dar (`pg_snapshot_xmax(pg_current_snapshot())`).

## O que significa

`delivery_event.txid` é o id da transação que gravou cada evento (plano de escala, F2-03): é a ordem de commit pela qual o feed da integração (`/integration/v1/events`, a partir da onda 10) entrega os eventos. Todo evento gravado por este cluster tem um txid **menor** que o próximo xid; um txid igual ou maior só pode ter vindo de outro cluster.

O caso é um **restore lógico num cluster novo**: um `pg_dump` restaurado num Database criado de novo, ou levado para outro servidor. As linhas voltam com os txids do cluster antigo (milhões), e o cluster novo conta do zero: todo evento gravado depois do restore ganha um txid menor que o histórico, fica **atrás do cursor** de cada integrador e nunca é entregue. Nada falha; o feed só fica quieto.

Um restore pelo PITR (pgBackRest) ou um failover não disparam este alerta: o contador do cluster vem junto. Esse caso é o da época do cluster (U-14).

## Primeira ação

1. Pare a API (réplicas `0`), como em [deploy.md, Restaurar a partir do R2](../deploy.md#restaurar-a-partir-do-r2): cada evento gravado agora sai com um txid errado.
2. No banco, leia o maior txid e a época que o `pg_resetwal -e` precisa:

   ```sql
   SELECT m.newest, m.next, m.newest / 4294967296 + 1 AS epoch
   FROM (
     SELECT coalesce(max(txid), 0) AS newest,
            pg_snapshot_xmax(pg_current_snapshot())::text::bigint AS next
     FROM delivery_event
   ) m;
   ```

3. Pare o Database (_Stop_ no Dokploy: o Postgres desliga limpo) e rode o `pg_resetwal` com a imagem do próprio Database, no volume de dados dele, trocando `<volume do Database>`, `<imagem do Database>` e `<epoch>`:

   ```sh
   docker run --rm -u postgres \
     -v <volume do Database>:/var/lib/postgresql/data \
     --entrypoint pg_resetwal \
     <imagem do Database> -e <epoch> /var/lib/postgresql/data
   ```

   O `pg_resetwal -e` só muda a época do contador de transações (o xid de 64 bits é época × 2³² + xid): os próximos txids passam a ficar acima do histórico. A documentação do Postgres diz que a época não é guardada em nenhum outro lugar do banco.

4. Suba o Database e rode a consulta do passo 2 de novo: `newest` tem de estar abaixo de `next`.
5. Rode a etapa de release (**Deploy** na `trajetto-api-migrate`) e volte as réplicas da API.
6. Com o PITR ligado, tire um backup completo novo (`pgbackrest --type=full backup`, [deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest)): o `pg_resetwal` recomeça o WAL.

O ensaio de restauração (`infra/scripts/restore-postgres.sh`) faz os passos 2 a 4 sozinho no contêiner descartável, para o passo ser ensaiado e não estreado num incidente.

## Como confirmar

A consulta do passo 2 devolve `newest` menor que `next`, e o motivo some do `ops-heartbeat` no minuto seguinte. Um evento gravado depois (uma chegada no app, uma ocorrência) tem txid maior que todos os anteriores:

```sql
SELECT id, txid FROM delivery_event ORDER BY created_at DESC LIMIT 5;
```

## Quando escalar

Sempre com o dono, na hora: o `pg_resetwal` mexe no Database parado, e os integradores podem ter perdido os eventos gravados entre o restore e a correção (eles voltam a aparecer só se o integrador reler a janela com `updated_since`).

# job-overdue — Job durável sem ninguém para rodar

**Dispara quando:** um job durável (`background_job`) está PENDING e devido há mais de 10 min.

## O que significa

Um trabalho longo (uma importação de planilha, um estorno grande, a exclusão de uma empresa, a anonimização de uma pessoa) foi enfileirado e nenhum processo o pegou. Quem roda os jobs é o processo que consome a fila `jobs` do `WORKER_QUEUES`: todo processo no papel `all` (a produção de hoje) e a `trajetto-worker` numa frota separada. A importação fica "Em andamento" na tela até um processo pegar o job.

## Primeira ação

1. `/health/metrics` → `workers`: o ciclo `background-jobs` aparece e anda? Se não aparece, nenhum processo vivo consome a fila `jobs` (o alerta `queue-no-consumer` costuma vir junto): confira o `PROCESS_ROLE` e o `WORKER_QUEUES` das Applications no Dokploy e dê **Deploy** na que deveria consumir.
2. Se aparece e o job continua parado, veja o tipo dele no banco (por `psql`, só leitura): `SELECT "kind", "status", "attempts", "availableAt", "lastError" FROM "background_job" WHERE "status" = 'PENDING' AND "availableAt" <= now() ORDER BY "availableAt" LIMIT 5;`. Um tipo que nenhuma imagem no ar sabe rodar espera o release que traz o handler dele: confira o commit das Applications (`mixed-versions`).
3. Uma empresa com vários jobs do mesmo tipo roda um de cada vez (o teto da importação é `IMPORT_RUNNING_PER_TENANT`): os outros esperam o que está rodando, e isso não é falha.

## Como confirmar

O motivo some no próximo minuto do `ops-heartbeat`, e o job passa a PROCESSING e depois a SUCCEEDED.

## Quando escalar

Job parado por mais de uma hora com o worker vivo, ou o mesmo job voltando a FAILED com o mesmo `lastError`: chame o dono. A exclusão de empresa e a anonimização que falham têm o alerta próprio, [job-failing](./job-failing.md).

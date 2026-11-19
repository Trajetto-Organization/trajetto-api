# job-failing — Job que precisa terminar está falhando

**Dispara quando:** um job que precisa terminar (a exclusão de uma empresa, `TENANT_OFFBOARD`, ou a anonimização de uma pessoa, `USER_ANONYMIZE`) gastou as tentativas normais e segue falhando, ou falhou de vez nas últimas 24 h.

## O que significa

Esses dois jobs não podem parar no meio. A empresa em exclusão fica `PURGING`, inativa e sem volta (reativar é recusado com `BUSINESS_PURGE_RUNNING`), com parte das fotos e das linhas já apagadas; a pessoa anonimizada já tem `anonymized_at` e pedir de novo é recusado. Por isso, depois das 5 tentativas normais (30 s, 2 min, 10 min e 30 min de intervalo), o runner não desiste: tenta de novo a cada hora, do ponto em que parou, até terminar. O alerta fica ligado enquanto ele falha.

Ele só falha de vez em dois casos: um erro que repetir não resolve (`PermanentJobError`, como um job sem empresa), ou o processo morrendo durante a última tentativa (um job que derruba o processo, por memória, por exemplo, não fica derrubando a API a cada hora).

## Primeira ação

1. Veja o job no banco (por `psql`, só leitura): `SELECT "id", "kind", "businessId", "status", "attempts", "maxAttempts", "availableAt", "lastError" FROM "background_job" WHERE "kind" IN ('TENANT_OFFBOARD', 'USER_ANONYMIZE') AND "lastError" IS NOT NULL AND "status" <> 'SUCCEEDED' ORDER BY "updated_at" DESC LIMIT 5;`.
2. Leia o `lastError`. Um bucket do R2 fora do ar, um lock que não vem (`lock_timeout`) ou um banco sobrecarregado passam sozinhos: corrija a causa (o status do R2, o alerta de conexões ou de transação longa) e espere a próxima hora; não é preciso reenviar nada.
3. Status `FAILED`: o job não volta sozinho. Se a causa foi um processo que morreu (o `lastError` diz que a última tentativa morreu com o processo), confira o log e a memória da Application (`memory-budget`) antes de qualquer coisa.

## Como confirmar

O job passa a `SUCCEEDED`: a empresa fica `PURGED` (ou some da lista, na exclusão pelo código de 6 dígitos) e a pessoa aparece como removida. O motivo some no minuto seguinte do `ops-heartbeat`; uma falha de vez sai da conta 24 h depois.

## Quando escalar

O mesmo `lastError` por mais de um dia, ou qualquer job `FAILED`: chame o dono. Depois que a correção estiver no ar, o dono devolve o job à fila, do ponto em que parou, com uma tentativa a mais, pelo `psql`: `UPDATE "background_job" SET "status" = 'PENDING', "maxAttempts" = "attempts" + 1, "availableAt" = now(), "finished_at" = NULL, "updated_at" = now() WHERE "id" = '<id>' AND "status" = 'FAILED';`.

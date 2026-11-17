# prisma/post-deploy

DDL que espera uma **pré-condição**, rodado pela etapa de release depois do
`prisma migrate deploy` e do `infra/sql`, e antes dos seeds (plano de escala,
F5-08 e decisão D20). O exemplo do plano é a troca das filas para tabelas
particionadas: ela só pode acontecer quando todas as imagens vivas anunciam
a capability, e até lá o passo fica pendente.

O contrato é o mesmo do `infra/sql` (o `README.md` de lá): arquivo
idempotente, em ordem de nome, que termina com `RAISE NOTICE` `'applied: …'`,
`'skipped: …'` ou `'pending: …'`; o estado fica em `release_step_state`, e um
passo pendente faz o deploy seguinte rodar a etapa de novo (ou um
_Run workflow_ com `force_release`).

Emergência: `POST_DEPLOY_STEPS=off` no _Environment_ da
`trajetto-api-migrate` pula esta pasta (o `infra/sql` continua rodando). O
estado de cada passo fica como estava; tire a variável depois.

Índice de tabela quente não vem aqui: vai em `prisma/concurrent`, antes das
migrations.

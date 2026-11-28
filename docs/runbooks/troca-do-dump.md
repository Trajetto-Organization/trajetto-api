# troca-do-dump — O dump diário do Dokploy dá lugar ao pgBackRest

**Quando:** só num gatilho medido (abaixo), com o seu aval para o texto. Até lá o dump do Dokploy continua todo dia, em paralelo ao pgBackRest (plano de escala, decisão D9 e item U-09).

## O que significa

Hoje há duas cópias diárias do banco, independentes uma da outra:

- o **dump do Dokploy** (Database → _Backups_, [deploy.md, seção 18](../deploy.md#18-backup-e-restauração)): um `pg_dump` às 03:00 UTC, 30 cópias no R2, uma por dia. É uma cópia lógica, que restaura em qualquer Postgres;
- o **pgBackRest** da imagem `trajetto-postgres` ([deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest)): um diferencial às 05:00 UTC de domingo a sexta, um completo no sábado, mais o WAL contínuo do PITR, cifrado no R2.

O dump pesa quando o banco cresce: enquanto roda, ele segura o horizonte de limpeza do Postgres (o `xmin`), e as filas, que apagam e regravam o dia inteiro, acumulam linhas mortas que o autovacuum não pode tirar. A troca desliga o dump e deixa o pgBackRest como a cópia diária. A política de privacidade e os termos dizem "cópias de segurança diárias do banco, guardadas por 30 dias": continua verdade, muda só a técnica. O teste `legal-facts` da web lê de onde vem a cópia diária na seção 18 (a linha **Fonte das cópias diárias**) e confere o prazo na fonte que ela nomeia: o _Keep Latest_ do dump, ou o `repo1-retention-full` de `infra/postgres/pgbackrest.conf` somado ao intervalo entre dois completos.

O pgBackRest guarda um completo **mais velho** que a retenção enquanto ele for a base do PITR do começo da janela: com `repo1-retention-full=30` e um completo por semana, uma cópia vive até 37 dias. Para o texto continuar "30 dias", a troca baixa a retenção para:

`repo1-retention-full=23`

(23 + 7 = 30; o PITR passa a cobrir no mínimo 23 dias). Se preferir manter os 30 dias de PITR, o texto muda para "em até 37 dias", e isso é decisão sua, com o texto novo aprovado antes.

Os gatilhos, qualquer um deles:

1. o dump do Dokploy leva mais de 30 min (o tempo do backup na aba _Backups_ do Database, ou o log da execução);
2. o `n_dead_tup` das filas sobe durante o dump e só cai depois dele (a consulta em [Como confirmar](#como-confirmar), às 02:55 e às 03:25 UTC);
3. o portão de 1 milhão de entregas por mês do plano de escala (seção 6 do plano).

## Primeira ação

1. Confirme o gatilho e anote o número (o tempo do dump, ou as duas leituras do `n_dead_tup`).
2. Confirme que o pgBackRest está inteiro: o diferencial e o completo da última semana avisaram sucesso no healthchecks.io, `pgbackrest info` lista os completos dos últimos 30 dias, e o último ensaio de restauração ([restore-drill](./restore-drill.md)) passou. Sem isso, não troque: resolva antes ([wal-archive-stalled](./wal-archive-stalled.md), [pitr-archive-off](./pitr-archive-off.md)).
3. Peça o seu aval para o texto (a política e os termos não mudam com a retenção de 23; mudam se você escolher os 37 dias).

### A troca

1. Num commit na `staging`, a seção 18 de `docs/deploy.md` passa a dizer **Fonte das cópias diárias**: `pgbackrest` e `infra/postgres/pgbackrest.conf` passa a `repo1-retention-full=23`. O `legal-facts` da web (rodado contra a API desse commit) tem de passar; ele reprova a troca sem a retenção nova.
2. A imagem `trajetto-postgres` nova entra como qualquer troca de imagem do Database ([deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest)), primeiro na staging e depois na produção, e o primeiro `trajetto-backup diff` depois dela avisa sucesso.
3. Dokploy → projeto `trajetto-api` → Database `trajetto-postgres` → aba **Backups** → a linha do backup → **Enabled** desligado → **Save**. Não apague a linha: ela é a volta.
4. As cópias do dump que já estão no R2 deixam de ser apagadas pelo Dokploy, que só limpa quando roda. Para elas também saírem em até 30 dias, crie no bucket de backup uma regra de ciclo de vida (R2 → o bucket → _Settings_ → _Object lifecycle rules_) que apaga os objetos do prefixo do ambiente (`trajetto-production/` ou `trajetto-staging/`) 30 dias depois de criados. Ela não toca nos prefixos do pgBackRest (`archive/` e `backup/`).

Depois da troca, restaurar o banco é o caminho do PITR ([pitr-restore](./pitr-restore.md)); o restore pela aba _Backups_ da seção 18 só serve para as cópias do dump que ainda estão no R2.

Faça a staging primeiro, espere uma semana inteira (um completo de sábado no meio) e só então a produção.

## Como confirmar

- No dia seguinte, nenhuma cópia nova sob o prefixo do dump no R2, e o diferencial das 05:00 avisou sucesso.
- O `n_dead_tup` das filas não sobe mais às 03:00 UTC:

  ```sql
  SELECT relname, n_dead_tup, n_live_tup, last_autovacuum
  FROM pg_stat_user_tables
  WHERE relname LIKE ANY (ARRAY['domain_outbox_event%', 'notification_delivery%', 'webhook_delivery%', 'background_job%'])
  ORDER BY n_dead_tup DESC
  LIMIT 20;
  ```

- `pgbackrest info` mostra os completos e os diferenciais dos últimos dias, e, passados 30 dias, o prefixo do dump está vazio no R2.
- O ensaio de restauração do dia 1 seguinte passa.

## Quando escalar

- Um diferencial ou um completo falhou duas vezes seguidas depois da troca: religue o backup do Database no Dokploy (**Enabled**) na hora, volte a seção 18 para `dokploy` num commit e chame o dono. Com o dump ligado de novo, a regra de ciclo de vida do passo 4 pode ficar: ela apaga o mesmo que o Dokploy apagaria.
- O texto da política precisa mudar (os 37 dias, ou outra técnica): pare antes do passo 3 e chame o dono; nada é desligado sem o texto aprovado.

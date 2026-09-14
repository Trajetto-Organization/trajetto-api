# Runbook — backup e restauração do Postgres

> Vive dentro de `trajetto-api` de propósito: descreve os scripts em
> `infra/scripts/` e o schema do Prisma deste repositório, e precisa ser
> versionado junto com eles. A pasta `docs/` da raiz do workspace, onde ficam
> os planos de arquitetura, não está sob controle de versão em repositório
> nenhum.

Este documento existe porque, até 14/09/2026, o Trajetto **não tinha backup
nenhum**. Nenhum script, nenhum job, nenhuma linha no histórico do repositório.
O Postgres de produção é um contêiner único com volume `local` no host, sem WAL
archiving e sem réplica — e dois crons de expurgo apagam linhas todo dia às
03:30 e 03:45 (`cleanup-notification-pipeline-job.ts`,
`cleanup-ai-pipeline-job.ts`). Perder o host significava perder tudo, e um
predicado errado num desses crons era irreversível.

## O que este procedimento garante, e o que não garante

| | |
|---|---|
| **RPO** | A idade do último dump. Com execução diária, até 24 h de perda. |
| **RTO** | Medido, não estimado: ver a seção "Resultado do ensaio". |
| **PITR** | **Não existe.** Recuperação para um instante exato exige WAL archiving, que é mudança no serviço de produção. Registrado como follow-up. |
| **Arquivos (R2)** | **Fora deste procedimento.** Ver "O que o dump não cobre". |

Aceitar um RPO de 24 h explicitamente é melhor do que adiar o backup inteiro
esperando a solução completa.

## Fazer o backup

```bash
POSTGRES_USERNAME=... POSTGRES_DATABASE=... \
  ./infra/scripts/backup-postgres.sh ./backups
```

O `pg_dump` roda **dentro** do contêiner, para que a versão do cliente sempre
bata com a do servidor — é a forma mais comum de um dump falhar silenciosamente
na hora de restaurar. O formato é `-Fc` (custom, comprimido), que permite
restaurar tabelas isoladas.

O script recusa um dump menor que 1 KB. Um arquivo vazio é pior que arquivo
nenhum: parece sucesso no painel e falha no único momento em que alguém precisa
dele.

**O arquivo só vira backup quando sai desta máquina.** Copiar para o R2 — em um
bucket separado do `trajetto-prod-storage`, com credencial só de escrita e
lifecycle de retenção — é o passo que falta automatizar.

## Ensaiar a restauração

```bash
./infra/scripts/restore-postgres.sh ./backups/<arquivo>.dump
```

O script sobe um `postgres:16-alpine` descartável na porta 55432 — a **mesma
imagem da produção**, não o `bitnami/postgresql` do compose de desenvolvimento.
Um ensaio contra imagem e layout diferentes não prova nada sobre o banco que
está sendo restaurado.

Três coisas nele merecem atenção:

1. `--exit-on-error` no `pg_restore`. Sem isso ele relata sucesso tendo pulado
   tudo que não conseguiu aplicar, e o operador vai embora acreditando que o
   dump está bom.
2. `prisma migrate deploy` contra o banco restaurado. **Esta é a verificação que
   importa.** `pg_restore` sair com 0 só diz que o arquivo era legível;
   `No pending migrations to apply` diz que o banco restaurado é
   estruturalmente aquele que a aplicação espera. Não custa nada, porque o
   Prisma já é dependência.
3. O contêiner é removido ao final. `KEEP_CONTAINER=true` preserva para
   inspeção.

## Resultado do ensaio — 14/09/2026

Executado de ponta a ponta nesta data, não teórico.

```
Origem     postgres:16-alpine limpo, 72 migrations aplicadas do zero
Dado       1 business, 25 activities (3 com deliveryId), dump de 159.410 bytes
Restore    pg_restore --exit-on-error → 0
Paridade   prisma migrate deploy → "No pending migrations to apply"
Tempo      2 s para 49 tabelas
```

Verificado no banco restaurado:

- 49 tabelas, 72 linhas em `_prisma_migrations`
- os cinco índices que só existem em SQL cru sobreviveram:
  `notification_created_at_idx`, `notification_delivery_claim_idx`,
  `domain_outbox_event_claim_idx`, `chat_message_body_trgm_idx`,
  `activity_deliveryId_key`
- a extensão `pg_trgm` veio junto no dump
- as constraints continuam ativas: inserir `deliveryId` duplicado no banco
  restaurado é rejeitado

**Achado secundário, e importante por si só:** este ensaio foi a primeira
aplicação das 72 migrations contra um banco limpo. Até então a cadeia só tinha
sido conferida estaticamente. Ela sobe.

### O que 2 segundos significam e o que não significam

O tempo foi medido sobre 26 linhas. Ele confirma que o **procedimento** é
rápido, não que a produção restaura em 2 segundos — o tempo de `pg_restore`
cresce com o volume, e a parte lenta de um restore grande é a recriação dos
índices, não a cópia dos dados. O ensaio deve ser repetido contra um dump real
de produção para que o RTO signifique alguma coisa.

## O que o dump não cobre

Restaurar só o Postgres devolve um sistema com todas as referências de arquivo
quebradas. O banco guarda **apenas as chaves**, nunca os bytes.

- **Bucket R2** — fotos de checklist, comprovação de entrega, assinaturas,
  anexos de chat, avatares. As fotos de entrega e as assinaturas são **prova
  documental**; perdê-las não é degradação visual, é perda de evidência. Não há
  versioning nem lifecycle configurado no bucket. O mínimo honesto é ligar
  object versioning pelo console da Cloudflare e anotar aqui.
- **Segredos** — `.env.production` não está versionado (correto), então as
  únicas cópias vivas são o arquivo na workstation e o env da stack no
  Portainer. Perder as duas significa não conseguir reconectar ao próprio banco
  restaurado. Perder `JWT_SECRET_REFRESH_TOKEN` desloga todo mundo —
  recuperável, mas é um evento de suporte.
- **Redis** — não precisa ser restaurado. Não há nenhuma escrita de aplicação
  nele: é rate limit (`skipOnError: true`), adapter pub/sub do Socket.IO e ping
  de health. A fila durável de notificações fica no Postgres, então vem no
  dump. O volume `redis_data` pode ser descartado.

## Follow-ups registrados

| Item | Por que ficou de fora |
|---|---|
| Agendar o backup diário e enviar ao R2 | Precisa de bucket, credencial de escrita e lifecycle — decisão de infraestrutura. |
| WAL archiving / PITR | Exige montar config no serviço de produção e um destino de arquivamento. |
| Ensaio contra dump real de produção | O ensaio acima usa dado sintético; o RTO só vira número confiável com volume real. |
| Versioning no bucket R2 | Console da Cloudflare. |
| Réplica de leitura / HA | Projeto separado. |

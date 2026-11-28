# Bucket Lock dos backups e dos comprovantes

> Plano de escala, F1-26 (decisão D33). Regras aplicadas pelo dono no painel
> do Cloudflare R2: _R2 → bucket → Settings → Bucket Lock → Add rule_. Nada
> aqui é aplicado pelo código nem pelo pipeline. O teste
> `tests/unitaires/lifecycle/bucket-locks.test.ts` confere a tabela abaixo
> contra o `infra/postgres/pgbackrest.conf`, o backup do Dokploy
> (`docs/deploy.md`, seção 18) e o código do comprovante.

Os tokens do R2 não têm o escopo "só escrita": quem tem a chave que grava
também apaga. A chave de escrita do PITR mora no _Environment_ do Database
(o pgBackRest arquiva de dentro do contêiner do banco), e a do dump mora no
Dokploy, no mesmo host. Sem trava, quem tomasse o host apagaria todas as
cópias de uma vez. O Bucket Lock recusa apagar ou sobrescrever um objeto
enquanto ele for mais novo que o prazo da regra, qualquer que seja a chave.

A trava vale por prefixo, a partir do upload de cada objeto. Ela é uma regra
do bucket, e não uma marca no objeto: apagar a regra solta os objetos.

## As regras

| Bucket                  | Prefixo                | Lock (dias) | Quem apaga, e quando                                                   | Situação                                  |
| ----------------------- | ---------------------- | ----------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `trajetto-pitr-staging` | `archive/trajetto/1`   | 14          | o `expire` do pgBackRest, o WAL de mais de 30 dias                     | aplicada no F1a; provada em 27/11/2026    |
| `trajetto-pitr-staging` | `backup/trajetto/2`    | 14          | o `expire` do pgBackRest, os backups de mais de 30 dias                | prova de 27/11/2026: falhou; removida     |
| `trajetto-pitr-prod`    | `archive/trajetto/1`   | 14          | o `expire` do pgBackRest, o WAL de mais de 30 dias                     | aplicar no F1b (onda 6), antes do arquivo |
| `trajetto-pitr-prod`    | `backup/trajetto/2`    | 14          | o `expire` do pgBackRest, os backups de mais de 30 dias                | não aplicar: a prova da staging falhou    |
| `trajetto-backups-prod` | `trajetto-production/` | 14          | o backup do Dokploy, a 31ª cópia diária (Keep Latest 30)               | F0-03                                     |
| `trajetto-offsite`      | (o bucket inteiro)     | 30          | a Expiration de 90 dias do próprio bucket (`infra/r2/offsite-copy.md`) | F1-23, na conta secundária                |
| bucket de uploads       | `deliveryProofs/`      | 90          | ninguém: o código nunca apaga nem sobrescreve um PDF de comprovante    | F1-O8; sobe para 1825 depois do parecer   |

Por que cada prazo é menor que a retenção de quem apaga: a limpeza (o
`expire`, o Keep Latest do Dokploy, a Expiration) só alcança o que já saiu da
trava. Uma trava mais longa que a retenção faria cada limpeza falhar.

### Os prefixos do pgBackRest

O repositório fica na raiz do bucket (`repo1-path=/`) e a stanza se chama
`trajetto`, então o pgBackRest escreve:

| Objeto                                                        | Escrito                                      | Travado?             |
| ------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| `archive/trajetto/16-1/0000000100000000/<segmento>-<sha>.zst` | uma vez, pelo `archive-push`                 | sim (`archive/…/1`)  |
| `archive/trajetto/16-1/00000002.history`                      | uma vez, num promote                         | sim (`archive/…/1`)  |
| `archive/trajetto/archive.info` e `.copy`                     | no `stanza-create` e no `stanza-upgrade`     | não                  |
| `backup/trajetto/<rótulo>/…` (rótulo `20261116-050000F`)      | o manifesto é **reescrito** durante o backup | só na prova (abaixo) |
| `backup/trajetto/backup.info` e `.copy`                       | a cada backup e a cada `expire`              | não                  |
| `backup/trajetto/backup.history/…`                            | a cada backup                                | não                  |

O plano escrevia `archive/trajetto/` como prefixo, mas o `archive.info` mora
nele: o prefixo é `archive/trajetto/1`, que pega os arquivos `16-1`, `17-2`…
(as versões 10 a 19 do Postgres) e deixa o `archive.info` de fora, como o
plano pede. Na versão 20 do Postgres, acrescente `archive/trajetto/2`.

Os rótulos dos backups começam pela data (`20261116-050000F` e, num diff,
`20261116-050000F_20261117-050000D`), por isso `backup/trajetto/2` pega todos
eles e deixa `backup.info` e `backup.history` de fora.

### O manifesto reescrito: por que a regra de `backup/` é só uma prova

Um mesmo backup grava o `backup.manifest.copy` do rótulo mais de uma vez: no
começo (para um backup interrompido poder ser retomado), de tempos em tempos
e no fim. Medido em 16/11/2026, com o pgBackRest 2.60.1 da imagem, num banco
pequeno: três gravações por backup com o limiar padrão, vinte com o limiar de
1 MB. No R2, cada gravação é um PUT na mesma chave, e o Bucket Lock recusa
sobrescrever um objeto travado. Com a regra em `backup/trajetto/2`, o backup
deve falhar na segunda gravação do manifesto, e o backup que falhou deixa
objetos travados que o seguinte quer retomar ou apagar.

Por isso a regra de `backup/` só entra como prova na staging, e sai se a
prova falhar (o plano já previa: "se falhar, o lock fica só em `archive/`").
Ela falhou em 27/11/2026, ao regravar o manifesto, e saiu.
Sem ela, os backups ficam protegidos pelo cofre do `backup.info` (abaixo) e
pelo dump diário com trava própria (`trajetto-backups-prod`). A proteção
completa dos backups vem do repo2 com Object Lock em outra empresa (V-01),
condição do primeiro cliente de escala.

## Primeiro na staging (F1a)

A conta: `<ACCOUNT_ID>` e as chaves nunca entram neste repositório.

1. **Antes do `stanza-create`**: R2 → `trajetto-pitr-staging` → Settings →
   Bucket Lock → Add rule: prefixo `archive/trajetto/1`, 14 dias.
2. Siga o F1a (`docs/deploy.md`, seção 27) até o primeiro full.
3. **O WAL de hoje não sai**: no painel do R2, abra um objeto de hoje em
   `archive/trajetto/16-1/…` e tente **Delete**. O R2 recusa.
4. **Backup interrompido e `expire`**: comece um diff e interrompa no meio,
   e depois rode o `expire` e outro diff (troque o App Name pelo do Database):

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging)
   docker exec -u postgres "$c" trajetto-backup diff &
   sleep 20; docker exec "$c" pkill -INT -f 'pgbackrest.*backup'
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto expire
   docker exec -u postgres "$c" trajetto-backup diff
   ```

   O diff interrompido pinga `/fail` no check do backup: esperado. O
   `expire` e o diff seguinte terminam bem: com a trava só em `archive/`, o
   backup retomado e o `expire` mexem só em `backup/`.

5. **A prova da regra de `backup/`**, numa manhã sem backup agendado: Add
   rule `backup/trajetto/2`, 14 dias, e logo em seguida
   `docker exec -u postgres "$c" trajetto-backup diff`.
   - Falhou (o esperado, pelo manifesto reescrito): **apague a regra** no
     painel (a trava é da regra: os objetos do backup que falhou se soltam),
     rode `trajetto-backup diff` de novo, que retoma ou apaga o rótulo pela
     metade, e anote em `docs/infraestrutura.md` (R2) que a regra de
     `backup/` não serve com o pgBackRest.
   - Passou: repita o passo 4 com as duas regras e espere um `expire` real
     (30 dias) antes de levar a regra à produção.

### O que as provas deram na staging (27/11/2026)

Sem SSH, os comandos rodaram no terminal do Database, como `postgres`.

- **Passo 3, o WAL que não sai:** o **Delete** de um segmento em
  `archive/trajetto/16-1/…` mostrou no painel o aviso verde de sucesso, mas o
  objeto ficou: o pgBackRest o leu do repositório em seguida, sem erro.
  O aviso do painel não prova nada; a prova é ler o segmento de volta.
- **Passo 4, o backup interrompido e o `expire`:** o diff interrompido falhou
  com o código 3 e pingou `/fail`; o `expire` terminou bem, sem nada a
  apagar ainda, e o diff seguinte terminou bem. A trava em `archive/` não
  atrapalha nem a retomada nem a limpeza.
- **Passo 5, a regra de `backup/`:** com a regra `backup/trajetto/2` (14
  dias), o diff falhou ao regravar o `backup.manifest.copy` do rótulo novo:
  o R2 respondeu `ObjectLockedByBucketPolicy`, como o manifesto reescrito
  fazia esperar. A regra foi apagada, e o diff seguinte terminou bem e
  apagou o rótulo que tinha ficado pela metade (o `repo-ls` de
  `backup/trajetto` não o lista mais). Ela
  não vai para a produção: os backups ficam com o cofre do `backup.info`, o
  dump diário travado e, no primeiro cliente de escala, o repo2 (V-01).

## Na produção (F1b, onda 6)

Antes do `stanza-create` da produção: a regra `archive/trajetto/1` de 14
dias no `trajetto-pitr-prod`. A de `backup/trajetto/2` não: a prova da
staging falhou em 27/11/2026 (acima). O dump (`trajetto-backups-prod`, F0-03) e o
`deliveryProofs/` do bucket de uploads (F1-O8) não dependem do PITR.

## Guardar no cofre o `backup.info` cru, logo depois do `stanza-create`

O `backup.info` guarda a sub-senha que cifra os manifestos, e o
`archive.info` a que cifra o WAL. Os dois ficam fora da trava, porque o
pgBackRest reescreve o primeiro a cada backup. Se alguém com a chave de
escrita sobrescrever o `backup.info` e a cópia dele, sem uma cópia guardada
os manifestos não abrem mais e nenhum backup restaura.

Uma vez por bucket, logo depois do `stanza-create` (a sub-senha não muda
depois dele), baixe os dois arquivos crus, ainda cifrados pela
`PGBACKREST_REPO1_CIPHER_PASS`, e guarde-os no cofre junto dela:

```sh
c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging)
docker exec -u postgres "$c" pgbackrest --stanza=trajetto repo-get --raw backup/trajetto/backup.info > backup.info.stanza
docker exec -u postgres "$c" pgbackrest --stanza=trajetto repo-get --raw archive/trajetto/archive.info > archive.info.stanza
head -c 8 backup.info.stanza   # Salted__ : cifrado, como no bucket
```

Refaça a cópia depois de um `stanza-upgrade` (troca de versão maior do
Postgres) ou de um `stanza-create` num repositório novo.

## Reconstruir um `backup.info` sobrescrito

Sintoma: `pgbackrest info` responde que não acha ou não abre o
`backup.info` ("has a stanza-create been performed?"), ou mostra
`no valid backups` com os rótulos ainda no bucket.

1. Pare o backup agendado (os Schedule Jobs do servidor) até o fim.
2. Devolva a cópia do cofre como `backup.info` **e** `backup.info.copy`. O
   pgBackRest não tem comando para gravar no repositório: use o `rclone`
   oficial, pela mesma imagem fixada da cópia fora da conta
   (`infra/r2/offsite-copy.md`), com a chave de escrita do bucket digitada
   no terminal (`read -rs`), nunca num arquivo do repositório:

   ```sh
   read -rs RCLONE_CONFIG_PITR_ACCESS_KEY_ID; read -rs RCLONE_CONFIG_PITR_SECRET_ACCESS_KEY
   export RCLONE_CONFIG_PITR_ACCESS_KEY_ID RCLONE_CONFIG_PITR_SECRET_ACCESS_KEY
   for name in backup.info backup.info.copy; do
     docker run --rm -v "$PWD/backup.info.stanza:/cofre/backup.info:ro" \
       -e RCLONE_CONFIG_PITR_TYPE=s3 -e RCLONE_CONFIG_PITR_PROVIDER=Cloudflare \
       -e RCLONE_CONFIG_PITR_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
       -e RCLONE_CONFIG_PITR_ACCESS_KEY_ID -e RCLONE_CONFIG_PITR_SECRET_ACCESS_KEY \
       <imagem rclone por digest> copyto --s3-no-check-bucket \
       /cofre/backup.info "pitr:trajetto-pitr-staging/backup/trajetto/${name}"
   done
   unset RCLONE_CONFIG_PITR_ACCESS_KEY_ID RCLONE_CONFIG_PITR_SECRET_ACCESS_KEY
   ```

3. Rode o `expire`: ele lê os manifestos que estão no bucket e devolve cada
   backup ao `backup.info` ("backup '…' found in repository added to
   backup.info"):

   ```sh
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto expire
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto info
   ```

4. O `info` lista o full e os diffs de novo. Rode o ensaio
   (`docs/runbooks/restore-drill.md`) antes de religar os Schedule Jobs.

Ensaiado em 16/11/2026 com a imagem `trajetto-postgres` (pgBackRest 2.60.1)
num repositório cifrado: full e diff, `backup.info` e a cópia sobrescritos,
a cópia do cofre devolvida, o `expire` devolveu os dois backups, e o
restore do diff subiu com as duas levas de linhas.

Um `archive.info` sobrescrito volta do mesmo jeito (a cópia do cofre, como
`archive.info` e `archive.info.copy`), sem o passo 3: ele não lista o WAL.

## A saída de uma empresa e a trava

O expurgo de uma empresa (o job `TENANT_OFFBOARD`, plano de escala F3-26b,
`src/shared/jobs/tenant-offboard/r2-purge.ts`) lista e apaga, página por
página, os objetos dela no bucket de uploads: os prefixos
`<tipo>/<businessId>/` (fotos, anexos do chat, planilhas guardadas), os
avatares `avatars/<userId>/` de cada usuário dela e os comprovantes
`deliveryProofs/<deliveryId>/` de cada entrega com comprovante. Um objeto
que a trava segura não falha o job: ele conta como retido (o log
`purged company's objects held by a bucket lock were retained` traz o
número, e o cursor do job também, em `progress.storage.retained`) e fica
no bucket. Qualquer outra falha faz o job tentar de novo, do ponto onde
parou.

Os retidos saem quando a trava acaba, por uma regra de _Expiration_ no
prefixo, que vale para os comprovantes de todas as empresas. Hoje o
`deliveryProofs/` não tem regra de _Expiration_: depois do parecer sobre o
prazo legal (a trava vai a 1825 dias), entra no `infra/r2/lifecycle.json`
uma regra no `deliveryProofs/` com o mesmo prazo da trava, ou um pouco mais,
aplicada pelo `infra/r2/apply-lifecycle.sh` (F5-28, `infra/r2/lifecycle.md`),
que hoje leva esse prefixo para a _Infrequent Access_ aos 60 dias e não apaga
nada. Sem ela, os comprovantes de
uma empresa excluída ficam no bucket até alguém apagá-los à mão, já fora
da trava.

## O que a trava não cobre

- O `backup.info` e o `archive.info`: o cofre acima.
- Os backups, porque a regra de `backup/` falhou na prova de 27/11/2026:
  ficam o dump diário travado e, para o primeiro cliente de escala, o repo2 (V-01).
- Uma chave de leitura vazada: a trava impede apagar, não ler. As cópias são
  cifradas (o PITR pela `PGBACKREST_REPO1_CIPHER_PASS`; o dump e os
  comprovantes pelo R2, em repouso).
- O bucket de uploads fora de `deliveryProofs/`: as fotos e assinaturas das
  entregas, com os PDFs, ganham a cópia semanal fora da conta (F1-23,
  `infra/r2/offsite-copy.md`); fotos de checklist e de abastecimento, anexos
  do chat e avatares dependem só do bucket.

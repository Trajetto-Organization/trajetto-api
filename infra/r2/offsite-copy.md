# Cópia dos comprovantes fora da conta

> Plano de escala, F1-23 (decisão D33). A cópia semanal dos comprovantes de
> entrega da produção para um bucket noutra conta Cloudflare, feita pelo
> `infra/r2/offsite-copy.sh` numa Application `trajetto-offsite` do Dokploy.
> Montada pelo dono; nada no pipeline a implanta. O teste
> `tests/unitaires/lifecycle/offsite-copy.test.ts` roda o script com stubs
> e confere este documento contra ele e contra `infra/r2/bucket-locks.md`.

O bucket de uploads da produção, os tokens que apagam nele e o Dokploy que
guarda esses tokens estão todos na mesma conta: quem tomar a conta, ou um
token que apaga, leva todos os comprovantes junto. A cópia vai para um bucket
de **outra** conta, com um token que a API nunca tem, e fica sob um Bucket
Lock de 30 dias.

## O que é copiado, para onde e como

- **O quê**: os prefixos `deliveryProofs/` (os PDFs dos comprovantes) e
  `deliveryPhotos/` (canhotos, assinaturas e fotos de ocorrência) do bucket
  de uploads da produção (`R2_BUCKET_NAME` da `trajetto-api`). Avatares,
  fotos de checklist e de abastecimento e anexos do chat ficam de fora.
- **Para onde**: o bucket `trajetto-offsite`, numa conta Cloudflare
  secundária (pode ser a conta cofre do F0-04, com 2FA por chave física).
- **Como**: `rclone copy`, **nunca** `sync`. Um objeto apagado na origem
  (saída de uma empresa, anonimização, pedido do titular pela LGPD) não é
  apagado pela cópia: ele sai pela Expiration do bucket, em até 90 dias. Um
  `sync` também transformaria uma origem apagada numa cópia apagada. O que
  já está na cópia nunca é reescrito (`--immutable`, `--size-only`,
  `--no-update-modtime`): os comprovantes não mudam, e a trava recusaria a
  sobrescrita de qualquer jeito.
- **Quando**: toda quarta-feira às 01:40 UTC (22:40 de terça em Brasília),
  longe do dump do Dokploy (03:00), dos expurgos (03:17–04:50), do pgBackRest
  (05:00), das janelas de carga (06:00–08:00), do domingo e do dia 1.

### Regras do bucket `trajetto-offsite`

| Regra                  | Valor   |
| ---------------------- | ------- |
| Expiration (lifecycle) | 90 dias |
| Bucket Lock            | 30 dias |
| Frequência da cópia    | semanal |

A trava (30 dias) é menor que a Expiration (90), então a limpeza do próprio
bucket nunca bate na trava. Um objeto que ainda existe na origem e expira na
cópia volta na quarta seguinte: a cópia guarda o que a origem guarda, mais o
que foi apagado nela nos últimos 90 dias. A política de privacidade da web
cita a cópia e os 90 dias, e o teste `legal-facts` da web lê a linha da
Expiration acima.

## Montar (uma vez, pelo dono)

1. **Conta secundária**: R2 → Create bucket `trajetto-offsite`.
   - _Settings → Object lifecycle rules → Add rule_: prefixo vazio (o bucket
     inteiro), _Expire objects_ depois de 90 dias. Confira a regra na lista.
   - _Settings → Bucket Lock → Add rule_: prefixo vazio, 30 dias.
   - _Manage API tokens_: um token _Object Read & Write_ só desse bucket. É o
     único token que grava na cópia; ele fica só no _Environment_ abaixo.
2. **Conta principal**: um token _Object Read only_ só do bucket de uploads
   da produção. A API não o recebe.
3. **Dokploy** → projeto `trajetto-api` → environment `production` →
   _Create Service → Application_ `trajetto-offsite` (App Name
   `trajetto-offsite-production`):
   - _General → Provider → Docker_, imagem oficial do rclone por digest
     (Docker Hub, pública, sem credencial):

     ```
     rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5
     ```

   - _Environment_: as variáveis da tabela abaixo.
   - _Advanced → Mounts → File Mount_: caminho
     `/opt/trajetto/offsite-copy.sh`, conteúdo = o
     `infra/r2/offsite-copy.sh` deste repositório, inteiro.
   - _Advanced → Command_ (o contêiner só espera; quem copia é o Schedule
     Job). O Dokploy roda o _Command_ por `/bin/sh -c`, no lugar do
     entrypoint `rclone` da imagem; se a Application parar logo depois do
     **Deploy**, confira o comando em `docker service inspect`:

     ```
     trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done
     ```

   - _Advanced → Resources_: _Memory Limit_ `67108864` (64 MiB) e _CPU
     Limit_ `250000000`; _Replicas_ 1; nenhuma _Domain_. **Deploy**.
4. **Schedules** da Application `trajetto-offsite`: cron `40 1 * * 3`,
   comando `sh /opt/trajetto/offsite-copy.sh`. No healthchecks.io, um check
   com período de 7 dias e tolerância de 6 h; a URL vai em
   `OFFSITE_PING_URL`.
5. **Rode agora** (o botão do Schedule) e confira:
   - a primeira linha da saída, `offsite-copy: <sha256>`, é igual a
     `sha256sum infra/r2/offsite-copy.sh` (o File Mount é o arquivo certo);
   - a última é `{"result":"ok",…}` com `transfers` e `checks`;
   - na conta secundária, `deliveryProofs/` e `deliveryPhotos/` têm objetos,
     e a regra de lifecycle mostra a Expiration de 90 dias;
   - um **Delete** de um objeto copiado hoje, pelo painel, é recusado.

Mudou o `offsite-copy.sh` no repositório? Cole o arquivo de novo no File
Mount e **Deploy**: a linha do sha256 diz qual versão rodou.

## Variáveis (_Environment_ da `trajetto-offsite`)

| Variável                    | Segredo | Valor                                                               |
| --------------------------- | ------- | ------------------------------------------------------------------- |
| `OFFSITE_SOURCE_ENDPOINT`   |         | `https://<ACCOUNT_ID da conta principal>.r2.cloudflarestorage.com`  |
| `OFFSITE_SOURCE_BUCKET`     |         | o bucket de uploads da produção                                     |
| `OFFSITE_SOURCE_KEY`        | 🔒      | o token só de leitura da conta principal                            |
| `OFFSITE_SOURCE_KEY_SECRET` | 🔒      | idem                                                                |
| `OFFSITE_DEST_ENDPOINT`     |         | `https://<ACCOUNT_ID da conta secundária>.r2.cloudflarestorage.com` |
| `OFFSITE_DEST_BUCKET`       |         | `trajetto-offsite`                                                  |
| `OFFSITE_DEST_KEY`          | 🔒      | o token de escrita só do `trajetto-offsite`                         |
| `OFFSITE_DEST_KEY_SECRET`   | 🔒      | idem                                                                |
| `OFFSITE_PREFIXES`          |         | — (padrão `deliveryProofs/ deliveryPhotos/`)                        |
| `OFFSITE_PING_URL`          | 🔒      | o check do healthchecks.io                                          |

O script recusa (sai com 1 e pinga `/fail` com `config`): variável faltando,
endpoint sem `https://` ou com caminho, os dois endpoints iguais (a cópia
estaria na mesma conta) e prefixo fora do formato `nome/`. As chaves chegam
ao rclone pelo ambiente dele, nunca pela linha de comando, e nada da saída
nem dos pings leva chave ou a URL do check.

Um comprovante com o mesmo nome e outro tamanho na origem faz a cópia falhar
(sai com 3 e pinga `/fail` com `copy-failed`, "immutable file modified" no
log), de propósito: um comprovante não muda depois de gravado, então isso é
adulteração ou defeito, e a cópia guarda o original em vez de sobrescrevê-lo.
Investigue a chave que o log nomeia antes de qualquer outra coisa.

## Prova local

Em 16/11/2026, com a imagem acima, o script inteiro, um teto de 64 MiB e
duas MinIO com TLS fazendo as duas contas (a chave da origem só lê; a do
destino grava e não apaga): a primeira cópia levou os 1801 objetos dos dois
prefixos (um deles de 40 MB) e nenhum avatar, sem estourar o teto; a
segunda não transferiu nada; um objeto apagado na origem ficou na cópia; e
um PDF trocado na origem fez a cópia sair com 3, com o original intacto no
destino. Nenhuma chave apareceu na saída.

## Memória

O teto é de 64 MiB. O script põe `GOMEMLIMIT=40MiB` e `GOGC=50` no rclone,
duas transferências e quatro conferências por vez, sem buffer de leitura
antecipada (`--buffer-size 0`) e upload em partes de 5 MiB, uma por vez. O
rclone guarda na memória a listagem de cada pasta, e a pasta de uma
empresa em `deliveryPhotos/` cresce com o volume: se a Application cair por
falta de memória (o check do healthchecks não recebe nada, e
`docker inspect` mostra `OOMKilled`), suba o teto para 128 MiB e anote aqui.

## Trazer de volta

Da cópia para um bucket novo (ou para o de uploads, depois de um incidente),
com um token de leitura da conta secundária e um de escrita no destino, de
um contêiner descartável da mesma imagem (as chaves digitadas no terminal,
`read -rs`, nunca num arquivo):

```sh
docker run --rm \
  -e RCLONE_CONFIG_OFF_TYPE=s3 -e RCLONE_CONFIG_OFF_PROVIDER=Cloudflare \
  -e RCLONE_CONFIG_OFF_ENDPOINT=https://<ACCOUNT_ID da conta secundária>.r2.cloudflarestorage.com \
  -e RCLONE_CONFIG_OFF_ACCESS_KEY_ID -e RCLONE_CONFIG_OFF_SECRET_ACCESS_KEY \
  -e RCLONE_CONFIG_UP_TYPE=s3 -e RCLONE_CONFIG_UP_PROVIDER=Cloudflare \
  -e RCLONE_CONFIG_UP_ENDPOINT=https://<ACCOUNT_ID da conta principal>.r2.cloudflarestorage.com \
  -e RCLONE_CONFIG_UP_ACCESS_KEY_ID -e RCLONE_CONFIG_UP_SECRET_ACCESS_KEY \
  rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5 \
  copy --s3-no-check-bucket --immutable off:trajetto-offsite/deliveryProofs up:<bucket>/deliveryProofs
```

O mesmo para `deliveryPhotos`. As chaves dos objetos são as mesmas da
origem, então as linhas do banco voltam a achar cada arquivo.

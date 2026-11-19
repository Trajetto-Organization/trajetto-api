# Lifecycle dos buckets do R2

> Plano de escala, F5-28. Regras aplicadas pelo dono, da máquina dele, com
> `infra/r2/apply-lifecycle.sh`. Nada aqui é aplicado pelo código nem pelo
> pipeline. O teste `tests/unitaires/lifecycle/r2-lifecycle.test.ts` confere
> os dois JSON contra as pastas de upload do código e contra os prazos do
> env-schema, e roda o script com o `aws` falso.

O R2 é o único custo que cresce sozinho todo mês: os comprovantes, as fotos e
os anexos nunca saem do bucket de uploads. A classe _Infrequent Access_ custa
US$ 0,01 por GB-mês, contra US$ 0,015 da _Standard_, e cobra US$ 0,01 por GB
lido, com um mínimo de 30 dias guardado. Um comprovante de mais de dois meses
quase nunca é aberto, então ele vai para a classe mais barata e fica lá.

## As regras

**Bucket de uploads** (`trajetto-staging-storage` e `trajetto-prod-storage`),
`infra/r2/lifecycle.json`:

| Regra (ID)                    | Prefixo            | O que faz                         |
| ----------------------------- | ------------------ | --------------------------------- |
| `trajetto-ia-deliveryProofs`  | `deliveryProofs/`  | _Infrequent Access_ aos 60 dias   |
| `trajetto-ia-deliveryPhotos`  | `deliveryPhotos/`  | _Infrequent Access_ aos 60 dias   |
| `trajetto-ia-checklistPhotos` | `checklistPhotos/` | _Infrequent Access_ aos 60 dias   |
| `trajetto-ia-odometerPhotos`  | `odometerPhotos/`  | _Infrequent Access_ aos 60 dias   |
| `trajetto-ia-chatAttachments` | `chatAttachments/` | _Infrequent Access_ aos 60 dias   |
| `trajetto-abort-multipart`    | (o bucket inteiro) | aborta o upload em partes aos 7 d |

Nenhuma regra de _Expiration_: nada do bucket de uploads é apagado por
idade. Os comprovantes ficam pelo prazo legal (5 anos, decisão D3), e o
`deliveryProofs/` está sob o Bucket Lock (`infra/r2/bucket-locks.md`). A
transição muda só a classe do objeto: não apaga nem reescreve, e o objeto
continua sendo lido pela mesma chave e pela mesma URL assinada. Ficam na
_Standard_ os `avatars/` (lidos em toda tela) e os `spreadsheetImports/`
(o job os apaga quando termina; na _Infrequent Access_ pagariam o mínimo de
30 dias).

**Bucket de arquivo** (`trajetto-archive-staging` e `trajetto-archive-prod`),
`infra/r2/archive-lifecycle.json`:

| Regra (ID)                 | Prefixo            | O que faz                                                       |
| -------------------------- | ------------------ | --------------------------------------------------------------- |
| `trajetto-expire-trail`    | `trail/`           | apaga aos 180 dias (`TRAIL_ARCHIVE_RETENTION_DAYS`)             |
| `trajetto-expire-history`  | `archive/`         | apaga aos 1830 dias (5 anos), **só depois do parecer jurídico** |
| `trajetto-abort-multipart` | (o bucket inteiro) | aborta o upload em partes aos 7 dias                            |

Os objetos do arquivo já nascem na _Infrequent Access_
(`ARCHIVE_STORAGE_CLASS=STANDARD_IA`, o padrão), então não há transição. A
regra do `archive/` (o histórico das entregas, F5-16) só vai para o bucket
com `--with-history-expiration`: até o parecer, o script a deixa de fora e
nada do histórico arquivado é apagado. Os 1830 dias passam um pouco dos 5
anos da decisão D3, contados do dia em que o mês foi arquivado, depois de
fechado: nenhum objeto sai antes do prazo.

## Rodar

Precisa do AWS CLI v2 (`aws`, no Windows `winget install Amazon.AWSCLI`) e
do Node. Rode do repositório, no Git Bash ou num Linux.

1. Cloudflare → _R2_ → _Manage R2 API Tokens_ → _Create API token_:
   permissão **Admin Read & Write**, _Specify bucket(s)_ = só o bucket que vai
   receber as regras, TTL curto (um dia). Guarde a _Access Key ID_ e a
   _Secret Access Key_ fora do repositório.
2. Exporte as variáveis (o `<ACCOUNT_ID>` está no painel do R2):

   ```sh
   export R2_LIFECYCLE_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
   export AWS_ACCESS_KEY_ID="<a Access Key ID do token>"
   export AWS_SECRET_ACCESS_KEY="<a Secret Access Key do token>"
   ```

3. Veja antes, sem enviar nada:

   ```sh
   sh infra/r2/apply-lifecycle.sh uploads trajetto-staging-storage --dry-run
   ```

   A saída mostra as regras que o bucket tem hoje e as que vão entrar. Um PUT
   troca a configuração inteira do bucket: se ele tem uma regra que o script
   não conhece (criada à mão no painel, ou a regra padrão de upload em partes
   do R2), o script para com o código 2 e lista as regras. Confira no painel
   se elas podem sair; para trocar, repita com `--replace`.

4. Aplique, primeiro na staging:

   ```sh
   sh infra/r2/apply-lifecycle.sh uploads trajetto-staging-storage
   sh infra/r2/apply-lifecycle.sh archive trajetto-archive-staging
   ```

   O script lê as regras de volta depois do PUT e termina com uma linha
   `{"result":"ok",…}`. Confira em _R2 → bucket → Settings → Object lifecycle
   rules_.

5. Depois, na produção, com um token do bucket de produção:

   ```sh
   sh infra/r2/apply-lifecycle.sh uploads trajetto-prod-storage
   sh infra/r2/apply-lifecycle.sh archive trajetto-archive-prod
   ```

6. Apague os tokens (_Manage R2 API Tokens_ → _Delete_).

Depois do parecer jurídico, a regra do histórico entra no bucket de arquivo
com o mesmo comando e `--with-history-expiration`. Se o prazo decidido não
for de 5 anos, mude antes os `Days` da regra `trajetto-expire-history`; o
teste confere que ela nunca fica abaixo de 5 anos.

A regra de _Expiration_ do `deliveryProofs/` que o `infra/r2/bucket-locks.md`
prevê para depois do parecer (o mesmo prazo da trava) entra neste JSON, numa
mudança revisada, e não à mão no painel: criada à mão, o script a mostra como
desconhecida e para, e um `--replace` a apagaria.

## O que o script recusa

- O modo `uploads` num bucket cujo nome tem `archive`, `backup`, `pitr` ou
  `offsite`, e o modo `archive` num bucket cujo nome não tem `archive`: as
  _Expirations_ do arquivo nunca chegam ao bucket dos comprovantes.
- Trocar regras que ele não conhece, sem `--replace` (código 2).
- Terminar como se tivesse dado certo quando as regras lidas de volta não
  são as enviadas (código 4).

Códigos de saída: 0 certo (ou `--dry-run`); 1 uso ou configuração; 2 regras
desconhecidas no bucket; 3 a leitura ou o PUT falhou; 4 as regras lidas de
volta não conferem. As chaves chegam ao `aws` pelo ambiente dele, nunca
pela linha de comando, e são apagadas de qualquer erro que o script mostre.

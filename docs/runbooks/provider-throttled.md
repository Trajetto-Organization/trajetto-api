# provider-throttled — Provedor recusando por taxa

**Dispara quando:** nas últimas 24 h, algum processo ouviu de um provedor uma recusa por taxa: a Meta com o código 130429 (ou um HTTP 429), a Resend com a recusa de limite ("too many requests", "rate limit") ou o Expo com um HTTP 429. A soma vem das linhas `ops_sample` de cada processo (seção `provider_rate`), então some sozinho 24 h depois da última recusa.

## O que significa

A plataforma inteira manda por **uma** conta em cada provedor: o WhatsApp de todas as empresas sai pelo mesmo número na Meta, os e-mails pela mesma conta da Resend e os pushes pelo mesmo projeto do Expo. O provedor limita a taxa dessa conta (80 mensagens por segundo na Meta, 10 requisições por segundo na Resend, 600 notificações por segundo no Expo), e os tetos de concorrência (`WHATSAPP_GLOBAL_CONCURRENCY` e os outros, F3-15a) limitam quantos envios estão em voo, nunca quantos saem num segundo. Uma recusa por taxa é o sinal de que o ritmo passou do contrato, para todas as empresas ao mesmo tempo. Na Meta, insistir pesa na qualidade da conta, que é de todas.

Com o balde de taxa do provedor **desligado** (o padrão, `0`), a mensagem recusada gasta uma tentativa e volta pelo backoff, respeitando o Retry-After. Com ele **ligado**, a recusa segura o provedor para todos os processos pela pausa pedida (1 s sem Retry-After, até 1 min com ele) e a mensagem espera o mesmo tempo **sem gastar tentativa**.

## Primeira ação

1. Veja qual provedor e quando, pelas linhas dos processos (uma por processo por minuto):

   ```sql
   SELECT date_trunc('hour', "ts") AS hora, "replica",
          sum(("metrics" -> 'provider_rate' -> 'throttled' ->> 'whatsapp')::int) AS whatsapp,
          sum(("metrics" -> 'provider_rate' -> 'throttled' ->> 'email')::int) AS email,
          sum(("metrics" -> 'provider_rate' -> 'throttled' ->> 'push')::int) AS push
   FROM "ops_sample"
   WHERE "ts" > now() - interval '24 hours'
     AND "metrics" -> 'provider_rate' -> 'throttled' IS NOT NULL
   GROUP BY 1, 2
   ORDER BY 1 DESC;
   ```

2. Se o balde do provedor está desligado, ligue-o abaixo do limite do contrato, no _Environment_ de **todas** as Applications que consomem a raia do provedor (hoje a `trajetto-api`; com os papéis, a `trajetto-worker` e a `trajetto-worker-external`), com o mesmo valor em todas → **Save** → **Deploy**. Os valores propostos:
   - WhatsApp (raia `external`): `WHATSAPP_SENDS_PER_SECOND=60` (a Meta dá 80 por segundo no nível padrão);
   - e-mail (raia `external`): `EMAIL_REQUESTS_PER_SECOND=8` (a Resend dá 10 por segundo, ou o que o plano contratado disser);
   - push (raia `internal`): `PUSH_NOTIFICATIONS_PER_SECOND=500` (o Expo aceita 600 por segundo por projeto).
3. Se o balde já está ligado, o valor está acima do que o provedor aguenta hoje: baixe-o (o plano da Resend mudou, a Meta baixou o nível do número) e confira o limite no painel do provedor.

## Como confirmar

Depois do deploy, o `GET /health/metrics` da Application mostra os envios por canal, e as linhas `ops_sample` dos minutos seguintes não trazem mais `throttled` para o provedor; `deferred` conta os envios que o balde adiou (esperando a vez, sem gastar tentativa) e `local` as vezes em que o Redis não respondeu e cada processo usou a sua parte da taxa. No log, `provider refused for rate` diz cada recusa ouvida com o balde ligado. O alerta some 24 h depois da última recusa.

## Quando escalar

Ao dono quando as recusas continuam com o balde ligado num valor bem abaixo do contrato (a conta foi limitada pelo provedor: na Meta, veja a qualidade e o nível do número no WhatsApp Manager), ou quando o volume do dia pede mais do que o contrato dá: é o pedido comercial à Meta (nível de mensagens do portfólio) ou à Resend (plano e limite), com meses de antecedência.

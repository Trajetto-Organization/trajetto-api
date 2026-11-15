# channel-credential — Credencial de um canal recusada

**Dispara quando:** a primeira entrega que falhou por credencial nos últimos 10 min.

## O que significa

O provedor de um canal recusou a nossa credencial (WhatsApp 401/403/190, SMTP EAUTH/535/530, push 401/403). Toda entrega seguinte do canal falha igual até alguém trocar o segredo; por isso o alerta vem na primeira.

## Primeira ação

- `Canal WHATSAPP`: token da Meta vencido ou revogado; gere um token de sistema novo no Business Manager e troque `META_WHATSAPP_ACCESS_TOKEN` no _Environment_ da `trajetto-api` (**Save** → **Deploy**).
- `Canal EMAIL`: chave do Resend revogada ou domínio desverificado; confira no painel do Resend e troque a chave.
- `Canal PUSH`: a credencial FCM V1 do projeto no EAS (`eas credentials`), ou o _Enhanced Security for Push Notifications_ ligado no projeto Expo.

## Como confirmar

`/health/providers` mostra o canal `ok`, e as entregas novas do canal saem. As que falharam estão em `/health/dead-letter?channel=<CANAL>` e podem ser reenviadas pelo replay.

## Quando escalar

Sem acesso ao painel do provedor (Meta, Resend, Expo), chame o dono: só ele tem as contas.

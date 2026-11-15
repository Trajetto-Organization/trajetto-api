# proof-signing — Certificado do comprovante vencendo, vencido ou inválido

**Dispara quando:** certificado A1 vence em 30 dias (aviso) ou 7 (crítico), venceu ou não abre.

## O que significa

O certificado ICP-Brasil A1 que assina os comprovantes de entrega está perto do fim, venceu ou não abre. Vencido ou inválido, os comprovantes saem sem assinatura digital (e dizem isso). Sem certificado configurado, nada alerta: é escolha.

## Primeira ação

1. `proof_signing` em `/health/metrics` mostra o estado, `not_after` e `days_left`.
2. Vencendo: compre e instale o A1 novo e troque `PROOF_SIGNING_PFX_*` no _Environment_ da `trajetto-api` (**Save** → **Deploy**).
3. Inválido: `PFX_UNREADABLE` é senha errada ou arquivo corrompido; `PFX_FILE_UNREADABLE` é o arquivo que não montou.

## Como confirmar

`proof_signing.state` volta a `READY` com a data nova, e o motivo some.

## Quando escalar

A compra do certificado é do dono: avise com 30 dias.

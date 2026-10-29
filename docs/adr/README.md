# Decisões de arquitetura (ADRs)

Cada arquivo desta pasta registra uma decisão: o contexto, o que se decidiu,
por quê e o que muda por causa dela. O código e os documentos citam as
decisões pelo número ("ADR 0002"), e cada número citado tem o seu arquivo
aqui (`tests/unitaires/docs/architecture-docs.test.ts` confere isso nos três
repositórios).

**De onde vêm os ADRs 0002 a 0010.** O texto integral deles ficava na pasta
`docs/` da raiz do workspace, que não é versionada e hoje está vazia. Em
28/10/2026 cada um foi reconstruído a partir do que os documentos versionados
já registravam, com o link para a seção de origem. Nenhuma decisão nova entrou
nesses arquivos.

## Índice

| ADR                                                | Decisão                                                                  | Status                         |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| [0001](./0001-filas-e-mensageria.md)               | O Postgres é a fila; nenhum broker, só por gatilho medido                | aceito (revisto em 28/10/2026) |
| [0002](./0002-redis-descartavel.md)                | Redis descartável: só chaves que podem sumir, com falha aberta           | aceito                         |
| [0003](./0003-outbox-transacional.md)              | Outbox transacional: o evento nasce na transação do dado                 | aceito                         |
| [0004](./0004-workers-no-mesmo-processo.md)        | Workers no mesmo processo da API, separáveis por flag com a mesma imagem | aceito                         |
| [0005](./0005-retentativa-backoff-dead-letter.md)  | Retentativa com backoff, dead letter e reenvio por id                    | aceito                         |
| [0006](./0006-idempotencia-de-efeitos-externos.md) | Idempotência de efeitos externos; na dúvida, guardar o objeto            | aceito                         |
| [0007](./0007-tempo-real-at-most-once.md)          | Tempo real distribuído no máximo uma vez; a verdade está no banco        | aceito                         |
| [0008](./0008-escala-horizontal.md)                | Escala horizontal com réplicas idênticas, sem cookie sticky              | aceito                         |
| [0009](./0009-comprovante-publico-por-token.md)    | Comprovante público por token com prazo                                  | aceito                         |
| [0010](./0010-ia-local.md)                         | IA local (OCR em CPU, `trajetto-ai`); o provedor externo saiu            | aceito                         |
| [0011](./0011-orm-prisma-6-7-8.md)                 | ORM: Prisma 7.10.1 com adapter-pg (go na 2ª tentativa); o 8 não saiu     | aceito                         |

## Outras decisões registradas

Decisões que não viraram ADR e vivem na seção do documento que as aplica:

| Decisão                                   | Onde está                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 — unicidade por empresa               | [`arquitetura.md` → Unicidade por empresa](../arquitetura.md#unicidade-por-empresa)                                                                                                                                 |
| 12.2 — uma imagem por serviço, por digest | [`deploy.md`](../deploy.md) e, na web, [Configuração pública em tempo de execução](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/arquitetura.md#configuração-pública-em-tempo-de-execução) |
| 13.1 / 13.5 — cobertura e mutação         | [`testes.md` → Cobertura](../testes.md#cobertura) e [Mutação](../testes.md#mutação)                                                                                                                                 |
| 14.1 — leitura de fotos sem provedor      | [ADR 0010](./0010-ia-local.md)                                                                                                                                                                                      |
| 14.8 — comprovante assinado com o A1      | [`arquitetura.md` → Comprovante de entrega](../arquitetura.md#comprovante-de-entrega)                                                                                                                               |
| Next.js 14 na web (28/10/2026)            | [`trajetto-ui/docs/arquitetura.md` → Next.js 14: versão e avisos de segurança](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/arquitetura.md#nextjs-14-versão-e-avisos-de-segurança)        |

## Como registrar uma decisão nova

1. Copie a estrutura de um ADR existente para `NNNN-titulo-curto.md`, com o
   próximo número livre.
2. Preencha **Status**, **Contexto**, **Decisão**, **Consequências** e
   **Fontes**. Medições com método e data; o que não foi medido é dito assim.
3. Acrescente a linha no índice acima e, se a decisão muda a arquitetura, no
   [tour](../arquitetura-tour.md) e no mapa de
   [`arquitetura.md`](../arquitetura.md#visão-de-componentes).
4. Uma decisão revista ganha um ADR novo que diz qual substitui; o antigo
   muda só o **Status**.

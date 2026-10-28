# ADR 0010 — IA local: OCR em CPU, sem provedor externo

- **Status:** aceito. ADR da fase final, com as decisões 14.1 (leitura sem
  provedor externo) e 14.2 (pré-checagem no aparelho).
- **Escopo:** `trajetto-api` (a API e o serviço `trajetto-ai`) e a
  pré-checagem do `trajetto-mobile`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova. A seção 4 mantém
  o número que o app cita ("ADR 0010 §4").

## Decisão

A leitura automática das fotos (número da NF e data no canhoto; quilometragem
no odômetro) roda num serviço próprio, `trajetto-ai` (`infra/ai-ocr`):
RapidOCR sobre ONNX Runtime, só CPU, sem chamar terceiros. O provedor
Anthropic da `main` antiga saiu: `AI_PROVIDER` aceita só `local` ou `none`, e
um `anthropic` que sobrou **impede o boot** (`src/schemas/env-schema/index.ts`).

### 1. O serviço só transcreve; a API decide

`POST /v1/read` com a foto e o perfil, bearer `AI_TOKEN`
(`src/shared/ai/local/local-ocr-reader.ts` → `infra/ai-ocr/server.py`). O que
a foto diz é decidido na API (`src/shared/ai/local/ocr-readings.ts` e
`src/shared/ai/ai-rules.ts`). O serviço não tem domínio público.

### 2. Fila, concorrência e cota

- A fila é `ai_analysis_request` no Postgres, com lease de 300 s, drenada pelo
  `AIAnalysisPipelineService` (`src/shared/ai/ai-analysis-pipeline-service.ts`)
  com até `AI_LOCAL_MAX_CONCURRENCY` leituras em voo por réplica.
- O serviço lê uma foto por vez, com fila curta (`AI_MAX_QUEUE`). Cheio,
  responde 503 `busy`, e o pedido volta à fila em 5–15 s sem gastar tentativa.
- Uma foto lida é uma unidade da cota mensal da empresa
  (`Business.ai_analysis_limit`; 0 desliga), contada uma vez. O que vai para
  conferência humana (assinatura, foto de tela, combustível, pneus) não
  consome cota.
- Pedidos perdidos entre o commit e o pedido são refeitos pelos crons
  `reconcile-proof-analysis` e `reconcile-record-analysis`.

### 3. Imagem e cadeia de suprimentos

Modelos embutidos na imagem e conferidos por SHA-256 (`models.sha256`); as
dependências Python com `--require-hashes`. O boot não precisa de rede.
Benchmark em `scripts/ai-benchmark/`.

### 4. Pré-checagem no aparelho (decisão 14.2)

O app lê a foto no próprio celular, sem rede (ML Kit, módulo
`modules/text-reader` do `trajetto-mobile`), e compara com o que já sabe.
O resultado é **só sugestão**: viaja com o envio, é confirmado pela leitura do
servidor, **nunca bloqueia** o motorista e nunca consome cota. O orçamento de
tamanho era de 5 MB a mais no download arm64; a medição dos artefatos e a
pendência de medir no aparelho estão no documento do app.

## Fontes

- [`arquitetura.md` → IA local](../arquitetura.md#ia-local).
- [`deploy.md` → 9. O serviço de IA](../deploy.md#9-o-serviço-de-ia-trajetto-ai).
- App: [`trajetto-mobile/docs/arquitetura.md` → Pré-checagem das fotos no aparelho](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/arquitetura.md#pré-checagem-das-fotos-no-aparelho).

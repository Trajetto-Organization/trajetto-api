# Benchmark de IA de visão — Gemma (self-host) × Claude Haiku

Mede, com os **prompts e as regras reais do produto**, o que cada provedor entrega nas três análises de imagem do Trajetto: odômetro do abastecimento, fotos do checklist e canhoto da NF-e. Existe para cumprir a decisão 12.4 (`docs/decisoes-fase-final-2026-09.md`): a escolha entre Gemma e Haiku sai do número medido, não do texto.

Nada aqui é código de produto. Os scripts não carregam Prisma, tsyringe nem o `@/env` da API.

## O que cada arquivo faz

| Arquivo                          | Papel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `product-source.mjs`             | Carrega de `src/shared/ai` os prompts (`ai-prompts.ts`), os padrões do provedor (`ai-provider-defaults.ts`), o esquema das respostas (`ai-answers.ts`), as regras (`ai-rules.ts`) e a avaliação do canhoto (`proof-criteria.ts`) direto do código-fonte: transpila cada arquivo com o `typescript` da API (os imports só de tipo, como o do `@prisma/client`, somem) e executa com um `require` restrito (arquivos vizinhos, `node:*` e `zod`). Qualquer outro import em tempo de execução derruba o carregamento com uma mensagem clara.                                                                                                                                                                                                                                                                                                                                |
| `prompts.mjs`                    | Monta o prompt de cada item com as **funções do próprio produto** (`ai-prompts.ts`); não existe cópia do prompt para divergir. Desde o ADR 0010 os prompts do produto já são cegos (odômetro e checklist sem o valor informado) e de extração (canhoto transcrito, decisão 6.9); as variantes `blind` e `extract` continuam como nomes, para comparar com as execuções de 28/09, e enviam o mesmo prompt do produto. O JSON schema do `format` do Ollama também é o do produto (`ANSWER_JSON_SCHEMAS`). `schemaDrift()` compara o schema com as chaves e opções que o prompt pede, nos dois sentidos.                                                                                                                                                                                                                                                                    |
| `evaluate.mjs`                   | Valida a resposta com o esquema do produto (`parseModelAnswer`) e a transforma no veredito que o produto gravaria, com as funções do próprio produto (`evaluateOdometerReading`, `evaluateChecklistField`, `readProofExtraction` e `assessProof`). A comparação com o valor informado ou esperado acontece no código, como no produto. Resposta que o produto recusaria conta como `invalid`, nunca como veredito.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scenes.mjs`                     | Cenas HTML/SVG das fotos sintéticas: canhoto (sozinho ou preso à DANFE), painel digital, âmbar, azul e de tambor, marcador de combustível, banda de rodagem do pneu, para-brisa trincado, extintor, foto de tela e "não é canhoto" (caixa, cupom NFC-e). Nomes e CNPJs são fictícios.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `generate-dataset.mjs`           | Renderiza as cenas com Playwright, aplica os defeitos de câmera (perspectiva, sombra, luz irregular, desfoque, granulação) e recodifica tudo como o app (`JPEG`, lado maior ≤ 1600 px, qualidade 0,72). Inclui os uploads reais de `tmp/` que servem de negativo. Grava `images/` e `labels.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `run-benchmark.mjs`              | Roda o conjunto contra `ollama` ou `anthropic`, uma requisição por vez, e grava `results.jsonl` (latência, tokens, resposta crua, JSON e o SHA-256 do prompt enviado), `samples.jsonl` (RAM do container pelo `docker stats` e pelo `memory.stat` do cgroup, separando memória anônima de cache de arquivo; CPU dos outros containers; load average da VM do Docker; CPU do host) e `run.json` (configuração e os **argumentos exatos de cada segmento**). Retoma de onde parou e refaz as chamadas que falharam no transporte (timeout, 429, 529). Com Ollama, recusa começar se um schema não bater com o prompt (`--allow-drift` força). Roda variante por variante (todas as `prod`, depois as outras): duas perguntas seguidas sobre a mesma foto deixariam o Ollama reaproveitar o cache da imagem e a segunda pareceria 3× mais rápida do que qualquer foto nova. |
| `summarize.mjs`                  | Junta as execuções nas tabelas do relatório: p50/p95, vazão sequencial, RAM (docker stats e anônima), carga a frio, chamadas suspeitas de cache (prefill mais de 3× mais rápido que o p25 da execução), acerto por tarefa, "não" falso no canhoto, custo do Haiku, contenção (CPU do host sem o nosso container e quais containers estavam de fato ocupados) e o comando de cada segmento. "JSON válido" conta só as chamadas respondidas; erro de transporte fica na coluna própria.                                                                                                                                                                                                                                                                                                                                                                                    |
| `tests/benchmark-tools.test.mjs` | Testes das garantias acima, pelos próprios CLIs, com um Ollama falso e uma cópia descartável de `src/shared/ai` alterada no teste.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Pré-requisitos

- Node 22 e as dependências da API (`typescript`, `tsx`).
- Playwright com Chromium (só para gerar o conjunto e para `--max-side`). O script procura o pacote na própria API e, se não achar, em `../trajetto-ui/node_modules` (onde já está instalado).
- Docker. **Nunca** passe `--gpus`: a ideia é emular uma VPS só com CPU.
- Para medir o produto (`--provider local`): o serviço `trajetto-ai` de `infra/ai-ocr` rodando e `AI_LOCAL_TOKEN` no ambiente ou em `trajetto-api/.env` (o script lê sem imprimir).

## Medir o que o produto roda (ADR 0010, 05/10/2026)

O provedor `local` chama o **serviço de produção** (`infra/ai-ocr`, contrato v1: foto em bytes e token Bearer) e aplica as regras de `src/shared/ai/local/ocr-readings.ts`, lidas do código-fonte. Itens que o produto não lê (combustível, pneus, itens de funcionamento) saem como "não cobre", sem chamada.

```bash
docker build -t trajetto-ai:bench infra/ai-ocr
docker run -d --name trajetto-ai-bench --cpus 2 --memory 1g --read-only --tmpfs /tmp \
  -e AI_TOKEN="$AI_LOCAL_TOKEN" -e OCR_THREADS=2 -p 127.0.0.1:18080:8080 trajetto-ai:bench
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider local --container trajetto-ai-bench \
  --dataset $DIR/dataset --out $DIR/results/local-2cpu-1g
```

O `--provider anthropic` e o Haiku saíram com o provedor externo (decisão 14.1); os passos 7 e 8 abaixo ficam como registro da rodada de 28/09.

## Testes dos scripts

```bash
npx vitest run scripts/ai-benchmark/tests
```

## Como repetir (máquina quieta)

Os comandos abaixo são os que produziram os números de 28/09/2026, **na ordem em que rodaram**, com os mesmos nomes de pasta (o `run.json` de cada pasta guarda os argumentos exatos). Todos rodam a partir de `trajetto-api/`. `DIR` é onde ficam o conjunto e os resultados; o padrão `tmp/ai-benchmark` já é ignorado pelo git. Pare o container entre execuções longas se a máquina for compartilhada (`docker stop trajetto-ai-bench-ollama`): enquanto o modelo está carregado ele segura a RAM inteira do limite.

```bash
DIR=tmp/ai-benchmark
SUBSET=P06,P08,P10,O02,O07,O10,K04,RO1   # subconjunto das execuções de escala

# 1. Conjunto rotulado (44 imagens; ~5 s)
node scripts/ai-benchmark/generate-dataset.mjs --dir $DIR/dataset

# 2. Ollama com limites de VPS (4 vCPU / 6 GB). Versão fixada. Sem --memory-swap,
#    como em 28/09: o Docker deixa o container usar swap até o mesmo tamanho do
#    limite se a VM tiver swap. Para proibir swap (VPS sem swap), acrescente
#    --memory-swap 6g, sabendo que o número deixa de ser comparável.
docker run -d --name trajetto-ai-bench-ollama --cpus 4 --memory 6g \
  -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -p 127.0.0.1:11435:11434 -v trajetto-ai-bench-models:/root/.ollama \
  ollama/ollama:0.34.4
docker exec trajetto-ai-bench-ollama ollama pull gemma4:e2b-it-qat

# 3. Gemma E2B, 4 vCPU / 6 GB: prompts do produto + extração (padrão --variants prod,extract)
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
  --model gemma4:e2b-it-qat --dataset $DIR/dataset \
  --out $DIR/results/gemma4-e2b-qat-4cpu-6g

# 4. Ancoragem, 4 vCPU / 6 GB: odômetro sem a km informada
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
  --model gemma4:e2b-it-qat --dataset $DIR/dataset \
  --out $DIR/results/gemma4-e2b-qat-4cpu-6g-blind --variants blind

# 5. Tamanho da imagem, ainda 4 vCPU / 6 GB: lado maior 896 px no subconjunto
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
  --model gemma4:e2b-it-qat --dataset $DIR/dataset \
  --out $DIR/results/gemma4-e2b-qat-4cpu-6g-896px \
  --variants prod --only $SUBSET --max-side 896

# 6. Escala: só agora 8 vCPU (memória segue 6 GB), mesmo subconjunto, 1600 px
docker update --cpus 8 trajetto-ai-bench-ollama
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
  --model gemma4:e2b-it-qat --dataset $DIR/dataset \
  --out $DIR/results/gemma4-e2b-qat-8cpu-6g \
  --variants prod --only $SUBSET

# 7. Claude Haiku 4.5 (modelo lido de ai-provider-defaults.ts; 44 chamadas ≈ US$ 0,11).
#    NÃO rodou em 28/09: a chave do .env respondeu 401. É a validação dos
#    prompts cegos e de extração que o produto passou a usar (ADR 0010).
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider anthropic \
  --dataset $DIR/dataset --out $DIR/results/haiku-4-5 --variants prod

# 8. Tabelas (o nome da pasta de cada execução vira o rótulo da linha)
npx tsx scripts/ai-benchmark/summarize.mjs --dataset $DIR/dataset \
  --runs $DIR/results/gemma4-e2b-qat-4cpu-6g $DIR/results/gemma4-e2b-qat-4cpu-6g-blind \
         $DIR/results/gemma4-e2b-qat-4cpu-6g-896px $DIR/results/gemma4-e2b-qat-8cpu-6g \
         $DIR/results/haiku-4-5 \
  --json $DIR/summary.json --markdown $DIR/summary.md

# 9. Limpeza (o volume guarda os pesos: 4,3 GB do E2B, mais 6,1 GB se baixar o E4B)
docker rm -f trajetto-ai-bench-ollama && docker volume rm trajetto-ai-bench-models
```

### Gemma E4B (não rodou nesta máquina)

O E2B (4,34 GB de pesos) ocupou 5,76 GiB segundo o `docker stats`, sob o teto de 6 GiB (uso do cgroup, cache de arquivo incluído; não é o mínimo necessário). O E4B tem 6,15 GB (5,73 GiB) de pesos; somando a mesma folga que o E2B mostrou acima dos pesos (~1,7 GiB), a estimativa é de ~7,4 GiB, ou um teto de ~8 GB para o container. Não cabe na VM do Docker desta máquina (7,9 GB no total, dividida com os containers de outros agentes). Numa máquina ou VPS com ≥ 12 GB livres, depois dos passos 3–6, volte a 4 vCPU e suba só a memória:

```bash
docker exec trajetto-ai-bench-ollama ollama pull gemma4:e4b-it-qat
# --memory-swap 16g mantém a mesma política do E2B (swap até o tamanho do limite)
docker update --cpus 4 --memory 8g --memory-swap 16g trajetto-ai-bench-ollama
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama \
  --model gemma4:e4b-it-qat --dataset $DIR/dataset \
  --out $DIR/results/gemma4-e4b-qat-4cpu-8g
```

## Como ler o resultado

- **Latência** é o tempo de parede de uma requisição, com o modelo já carregado. Cada execução mede antes a **carga a frio** (descarrega e carrega de novo), que é o custo de reiniciar o container.
- **Vazão sequencial** = 3600 ÷ média de segundos por imagem: uma caixa com `OLLAMA_NUM_PARALLEL=1`.
- **RAM:** o `docker stats` mostra uso do cgroup, que inclui o cache de arquivo ativo (os pesos mapeados por `mmap` entram aí) e, sob um teto, fica perto do teto qualquer que seja a necessidade real. A coluna "RAM anônima" (do `memory.stat`) é o que não pode ser devolvido; ela só existe nas execuções feitas depois de 28/09.
- **Suspeitas de cache:** o Ollama informa o prompt inteiro em `prompt_eval_count` mesmo quando quase tudo veio do cache KV. O sinal confiável é a taxa de prefill: ~169 tok/s num acerto de cache medido contra 15–40 tok/s com uma foto nova em CPU.
- **"Não" falso** no canhoto: critério respondido "não" quando o gabarito é "sim". É o erro caro — manda o motorista de volta ao endereço.
- **"Verificado" indevido** no odômetro: fraude, foto errada ou número divergente passando como verificado.
- **Temperatura:** Ollama roda com `temperature: 0` e `seed: 42` (resposta reproduzível). O Haiku roda como o produto chama: sem `temperature` (padrão 1,0), com o timeout e as retentativas lidos de `ai-provider-defaults.ts`.
- **`format`:** no Ollama a resposta é restrita ao JSON schema do prompt (é o que o adaptador proposto no reconhecimento faria), por isso "JSON válido" tende a 100%. O Haiku segue o caminho do produto: o primeiro bloco JSON da resposta, validado pelo esquema de `ai-answers.ts` (resposta fora do esquema conta como inválida).

## Limitações conhecidas

- As fotos sintéticas são renderizações, não fotos de câmera. Servem para comparar provedores no mesmo conjunto, não para prever o acerto absoluto em produção. O pneu, em especial, é esquemático.
- Os uploads reais em `tmp/` não são do domínio (prints, memes): entram só como negativos ("foto errada"). Imagens com pessoas ou documentos pessoais daquela pasta ficam de fora de propósito.
- O conjunto-ouro com fotos reais do app (≥ 60 odômetros, ≥ 100 canhotos, anonimizados) continua sendo pré-requisito para a decisão final; basta gerar outro `labels.json` no mesmo formato e apontar `--dataset` para ele.
- Um desktop Ryzen com `--cpus 4` é otimista em relação a 4 vCPU compartilhados de VPS (clock, SMT, vizinhos). Repita os passos 3 e 6 numa VPS real antes de dimensionar.

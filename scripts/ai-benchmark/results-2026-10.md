# Benchmark de IA local: OCR clássico × VLMs pequenos × híbrido (05/10/2026)

Resposta à decisão 14.1 (IA local, sem provedor externo) de `docs/decisoes-fase-final-2026-09.md`. Medido nesta máquina com os **prompts e as regras do produto** (`src/shared/ai/ai-prompts.ts`, `ai-answers.ts`, `ai-rules.ts`, `proof-criteria.ts`, carregados do código-fonte pelo harness, com a checagem de divergência entre schema e prompt ligada). O OCR clássico passa pelas mesmas regras: o texto lido vira a resposta no formato do produto (`ocr-rules.mjs`) e é avaliado por `evaluate.mjs` como qualquer modelo.

**Conclusão curta**

- **O OCR clássico (RapidOCR/ONNX) cabe ao lado do Postgres:** 0,6 GiB de RAM, ~0,7 s por foto e ~4.200 fotos/h a 4 vCPU. Nesta mistura ("combo"), o canhoto é lido pelo PP-OCRv5 mobile latin e os dígitos pelo PP-OCRv6 small sem classificador de direção. Resultado:
  - número da NF: 17/17;
  - data de recebimento: 17/20, com 0 "sim" falso;
  - km às cegas: 14/15;
  - 0 "parece certo" indevido no canhoto.
- **O OCR não responde assinatura nem itens visuais.** Para esses casos, o único VLM pequeno medido que respondeu bem foi o **Qwen3.5 2B**:
  - assinatura: 0 "sim" falso em 6, mas 3 "não" falsos em 14;
  - km: 15/15;
  - sugestão do canhoto certa: 20/22.
- **O 2B custa demais para ficar ao lado do Postgres.** Leva ~31 s por foto (115/h) e ocupa os 4 núcleos a 100%. A memória anônima cresce ~55 MB por imagem: foi de 2,1 para 5,1 GiB em 54 imagens, sem estabilizar.
- **O 0.8B não resolve.** Ele se abstém na assinatura (10/20 "não sei") e lê o trip no lugar do odômetro 6 vezes.
- **Nenhum modelo medido serve para nível de combustível nem para estado do pneu.** No combustível, a reserva foi lida como 3/4. O pneu careca com corte saiu como "good" no 2B.
- **Não medidos nesta máquina** (motivo na seção 6): MiniCPM-V 4.6, GLM-OCR e Qwen3.5 4B.

## 1. Ambiente e método

| item                     | valor                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                     | Windows 11, AMD Ryzen 7 7735HS (16 threads), 16 GB; Docker Desktop (engine 29.1.3), VM com 7,9 GB                                                                                                                               |
| Limite de cada container | `--cpus 4 --memory 6g` (perfil de VPS), um container e um modelo por vez                                                                                                                                                        |
| Ollama                   | `ollama/ollama:0.35.1` (estável mais recente em 05/10; 0.40.0 ainda em rc), `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`; `format` = JSON schema do produto, `think:false`, `temperature 0`, `seed 42`, `num_ctx 4096` |
| OCR                      | RapidOCR 3.9.2 + onnxruntime 1.30.0 (CPU), sem PaddlePaddle, container próprio (`ocr-server/`), `intra_op_num_threads=4`                                                                                                        |
| Imagem                   | VLMs a **896 px** (lado maior, `--max-side 896`, como recomendado); OCR a 1600 px (como o app grava) e também a 896 px                                                                                                          |
| Conjunto                 | 54 imagens: as 44 de 28/09 (mesmos ids e pixels) + **10 variações novas** (`--variations`)                                                                                                                                      |
| Repetição                | 1 passada por modelo (temperatura 0); latência = tempo de parede de uma requisição com o modelo carregado                                                                                                                       |

As 10 variações novas:

- **P16:** letra Segoe Script, inclinação forte, tremido e pouca luz.
- **P17:** data com hífen, só rubrica, reflexo de flash.
- **P18:** data de outro dia (20/09). O gabarito diz "sem data válida", porque a data existe, mas não é a do dia.
- **P19:** só assinatura, sem data, pouca luz.
- **P20:** número trocado (045.811), em perspectiva forte e desfocado.
- **O12:** tambor tremido e escuro.
- **O13:** LCD fotografado de lado.
- **O14:** painel âmbar muito escuro.
- **K12:** combustível em 1/4 com pouca luz.
- **K13:** pneu bom, escuro e desfocado.

Limitações (as mesmas de 28/09, e continuam valendo):

- As fotos são sintéticas (Chromium) e as assinaturas, curvas SVG.
- Não há conjunto-ouro real; o pré-requisito de ≥ 100 canhotos, ≥ 60 odômetros, ≥ 40 marcadores e ≥ 40 pneus segue pendente.
- O pneu é esquemático.
- Os números servem para **comparar** candidatos, não para prever o acerto em produção.
- O Haiku não foi medido, então os gates "odômetro ≥ Haiku − 5 p.p." e "'não' falso ≤ Haiku" não têm referência.

## 2. Latência, memória e carga

| execução                                                                    | p50        | p95        | fotos/h (seq.) | RAM pico (docker stats) | RAM anônima pico         | carga a frio       | CPU do container | CPU do resto do host (média / máx.)           |
| --------------------------------------------------------------------------- | ---------- | ---------- | -------------- | ----------------------- | ------------------------ | ------------------ | ---------------- | --------------------------------------------- |
| OCR v5 mobile (com cls), 1600 px                                            | 0,68 s     | 1,84 s     | 4.227          | 0,50 GiB                | 0,47 GiB                 | 0,25 s             | 379%             | 6,3% / 9,8%                                   |
| OCR v5 mobile sem cls, 1600 px                                              | 0,67 s     | 1,97 s     | 4.016          | 0,54 GiB                | 0,56 GiB                 | 0,25 s             | —                | 18,2% / 44,7%                                 |
| OCR v6 small (com cls), 1600 px ⚠                                          | 3,08 s     | 9,22 s     | —              | 0,55 GiB                | 0,59 GiB                 | 1,6 s              | —                | **69% / 75%** (contenção)                     |
| OCR v6 small sem cls, 1600 px                                               | 0,73 s     | 1,80 s     | 4.438          | 0,59 GiB                | 0,59 GiB                 | 0,50 s             | —                | 11,5% / 21,9%                                 |
| OCR v5 server sem cls, 1600 px                                              | 5,12 s     | 8,52 s     | 711            | 1,53 GiB                | 1,53 GiB                 | 1,2 s              | —                | 7,0% / 15,7%                                  |
| **OCR combo** (v5 mobile no canhoto, v6 small sem cls nos dígitos), 1600 px | **0,71 s** | **1,72 s** | **4.213**      | **0,60 GiB**            | 0,63 GiB                 | 0,68 s (2 motores) | 352%             | 7,1% / 16%                                    |
| OCR combo, 896 px                                                           | 0,39 s     | 1,24 s     | 7.938          | 0,56 GiB                | 0,45 GiB                 | 0,36 s             | 307%             | 10% / 22%                                     |
| Qwen3.5 0.8B q8_0, 896 px                                                   | 15,7 s     | 21,8 s     | 208            | 4,84 GiB                | **4,24 GiB** (crescendo) | 8,1 s              | 395%             | média 28,2% do host\*; outros containers 0,5% |
| **Qwen3.5 2B q4_K_M**, 896 px                                               | **31,0 s** | **35,0 s** | **115**        | 5,57 GiB                | **5,13 GiB** (crescendo) | 4,9 s              | 399%             | média 28,4% do host\*; outros containers 0,5% |
| Gemma 4 E2B QAT, 896 px (28/09, subconjunto de 8, linha de base)            | 26,4 s     | 32,9 s     | 134            | 5,74 GiB                | não medida               | 44,3 s             | 395%             | máquina contendida                            |

\* Nas execuções do Ollama, a CPU do host inclui o próprio container (4 dos 16 threads ≈ 25%). Os outros containers ativos (`trajetto-itest-pg`, `trajetto-test-redis`) ficaram em média em 0,5% de CPU.

⚠ A execução "v6 small com cls" coincidiu com uma rodada de `vitest` dos testes do harness: a latência dela não vale. As demais rodaram sem contenção relevante (resto do host ≤ 18% em média).

**Por tarefa (p50 / p95):**

| execução           | canhoto       | odômetro      | checklist     |
| ------------------ | ------------- | ------------- | ------------- |
| OCR combo, 1600 px | 1,12 / 1,96 s | 0,69 / 1,62 s | 0,54 / 1,58 s |
| Qwen3.5 0.8B       | 20,8 / 22,1 s | 15,3 / 18,3 s | 14,3 / 17,6 s |
| Qwen3.5 2B         | 33,9 / 35,0 s | 30,4 / 35,7 s | 28,0 / 31,8 s |

**Tokens (VLMs):**

- Entrada média: 841 tokens a 896 px.
- Saída: 106 (0.8B) e 125 (2B).
- Prefill: 10,2 s a 82 tok/s (0.8B) e 20,2 s a 42 tok/s (2B).
- Geração: 6,7 s a 16 tok/s (0.8B) e 10,9 s a 11,5 tok/s (2B).
- Um prompt sim/não com saída curta cortaria parte da geração, mas isso **não foi medido**.

**Memória dos VLMs.** A memória anônima subiu de forma quase linear durante toda a execução:

- 0.8B: 1,6 → 2,0 → 2,8 → 3,5 → 4,2 GiB (aos 10/25/50/75/100% das amostras);
- 2B: 2,5 → 3,1 → 3,8 → 4,5 → 5,1 GiB;
- OCR, para comparar: estável entre 0,24 e 0,63 GiB.

Não foi diagnosticado se é cache de imagem do Ollama 0.35.1 ou vazamento. Também não se sabe se estabiliza ou se o container é morto por OOM depois de mais imagens. **Antes de qualquer uso, rode um teste de longa duração (≥ 500 fotos).**

**Tamanhos:**

- Imagem do OCR com os três perfis: 362 MB comprimida e 1,08 GB em disco. Modelos ONNX: 208 MB com o v5 server incluído. O combo precisa só de ~44 MB:
  - `PP-OCRv6_det_small` 9,9 MB;
  - `PP-OCRv6_rec_small` 21,2 MB;
  - `ch_PP-OCRv5_det_mobile` 4,8 MB;
  - `latin_PP-OCRv5_rec_mobile` 7,9 MB;
  - cls 0,6 MB.
- Imagem `ollama/ollama:0.35.1`: 3,78 GB comprimida.

## 3. Acerto por tarefa (54 imagens, regras do produto)

**Como ler a tabela:**

- "Sim falso" é o critério respondido "sim" quando o gabarito é "não". "Não falso" é o inverso.
- "Abst." é "não sei". Uma abstenção manda o canhoto para revisão humana e não aprova nada.
- A assinatura tem 20 células avaliáveis (6 "não", 14 "sim").
- A data tem 20 células (8 "não", 12 "sim").

| execução                                                                    | sugestão do canhoto | nº NF exato | é canhoto | data: certo / sim falso / não falso / abst. | assinatura: certo / **sim falso** / não falso / abst. | legível | "parece certo" indevido | km exato (cego) | status do odômetro | "verificado" indevido | checklist visual (match) | combustível | pneu          |
| --------------------------------------------------------------------------- | ------------------- | ----------- | --------- | ------------------------------------------- | ----------------------------------------------------- | ------- | ----------------------- | --------------- | ------------------ | --------------------- | ------------------------ | ----------- | ------------- |
| OCR v5 mobile                                                               | 13/22               | 17/17       | 19/22     | 17/20 · 0/8 · 0/12 · 3                      | 0/20 · 0/6 · 0/14 · **20**                            | 17/18   | 0                       | 6/15            | 12/20              | 1                     | não cobre                | não cobre   | não cobre     |
| OCR v5 mobile sem cls                                                       | 13/22               | 17/17       | 20/22     | 17/20 · 0/8 · 1/12 · 2                      | — · — · — · 20                                        | 18/18   | 0                       | 8/15            | 16/20              | 1                     | não cobre                | —           | —             |
| OCR v6 small sem cls                                                        | 15/22               | 17/17       | 20/22     | **10/20** · 0/8 · **8/12** · 2              | — · — · — · 20                                        | 18/18   | 0                       | **14/15**       | 18/20              | 1                     | não cobre                | —           | —             |
| OCR v5 server sem cls                                                       | 13/22               | 17/17       | 19/22     | 13/20 · 0/8 · 4/12 · 3                      | — · — · — · 20                                        | 17/18   | 0                       | 7/15            | 16/20              | 1                     | não cobre                | —           | —             |
| **OCR combo**                                                               | 13/22               | **17/17**   | 19/22     | **17/20 · 0/8 · 0/12 · 3**                  | — · — · — · 20                                        | 17/18   | **0**                   | **14/15**       | 18/20              | 1                     | não cobre                | —           | —             |
| OCR combo, 896 px                                                           | 15/22               | 17/17       | 18/22     | 8/20 · 0/8 · 8/12 · 4                       | — · — · — · 20                                        | 15/18   | 0                       | 12/15           | 16/20              | 1                     | não cobre                | —           | —             |
| Qwen3.5 0.8B                                                                | 16/22               | 15/17       | 18/22     | 19/20 · 0/8 · 1/12 · 0                      | 10/20 · **0/6** · 0/14 · **10**                       | 17/18   | 0                       | 9/15            | 11/20              | 1                     | 7/12                     | 1/6         | 0/4           |
| **Qwen3.5 2B**                                                              | **20/22**           | 17/17       | 18/22     | 18/20 · 0/8 · 0/12 · 2                      | **17/20 · 0/6 · 3/14 · 0**                            | 17/18   | **0**                   | **15/15**       | 19/20              | 1                     | 7/12                     | 1/6         | 2/4           |
| Híbrido: OCR combo + 2B                                                     | 20/22               | 17/17       | 18/22     | 17/20 · 0/8 · 1/12 · 2                      | 17/20 · 0/6 · 3/14 · 0                                | 18/18   | 0                       | 14/15           | 18/20              | 1                     | 7/12                     | 1/6         | 2/4           |
| Híbrido: OCR combo + 2B, data com fallback no VLM                           | 20/22               | 17/17       | 18/22     | 18/20 · 0/8 · 0/12 · 2                      | 17/20 · 0/6 · 3/14 · 0                                | 18/18   | 0                       | 14/15           | 18/20              | 1                     | 7/12                     | 1/6         | 2/4           |
| Híbrido: OCR combo + 0.8B                                                   | 17/22               | 17/17       | 18/22     | 19/20 · 0/8 · 1/12 · 0                      | 10/20 · 0/6 · 0/14 · 10                               | 17/18   | 0                       | 14/15           | 18/20              | 1                     | 7/12                     | 1/6         | 0/4           |
| Híbrido: OCR combo + 0.8B, data com fallback no VLM                         | 17/22               | 17/17       | 18/22     | **20/20** · 0/8 · 0/12 · 0                  | 10/20 · 0/6 · 0/14 · 10                               | 17/18   | 0                       | 14/15           | 18/20              | 1                     | 7/12                     | 1/6         | 0/4           |
| Gemma 4 E2B (28/09, prompt de extração, 1600 px, 44 imagens; linha de base) | 12/17               | 12/12       | 14/17     | "inventa data" (P08–P12 como looks_good)    | "inventa assinatura"                                  | —       | —                       | 4/10 (cego)     | —                  | 5 (prompt antigo)     | 7/13                     | 1/5         | careca = good |

**Observações:**

- **"Verificado" indevido = 1 em todas as execuções:** é o O09, foto de uma tela mostrando o painel (fraude). Nenhum candidato, OCR ou VLM, sinalizou a fraude.
- **Latência dos híbridos = soma das duas chamadas.** Fica dominada pelo VLM: 31,7 s com o 2B e 16,3 s com o 0.8B.
- **OCR clássico:**
  - O OCR sozinho deixa a assinatura em "não sei". Por isso a sugestão do canhoto vira `needs_review` nos corretos (13/22), e nunca aprova nada errado.
  - O classificador de direção (cls) do PP-OCR **inverte os dígitos de LCD de sete segmentos** ("345.6" voltou como "SShE"). Sem ele, o PP-OCRv6 small leu 14/15 odômetros, inclusive LCD com reflexo, painel de lado e âmbar escuro. O único erro foi o tambor O03, lido como 5671 em vez de 56719.
  - O PP-OCRv6 small quase não detecta a data manuscrita (8 "não" falsos em 12). O PP-OCRv5 mobile latin a lê bem (17/20, 0 "sim" falso), por isso o combo usa cada um onde é melhor.
  - Os 3 erros de data do v5 mobile: P11, onde a "/" foi lida como "1" ("27109/2026"), e P20, onde a etiqueta "DATA DE RECEBIMENTO" saiu ilegível.
- **896 px é bom para dígitos, ruim para manuscrito no OCR.** A data caiu de 17/20 para 8/20. O OCR deve ler a foto como o app grava (1600 px). Isso não pesa, porque mesmo a 1600 px ele roda em < 2 s.
- **Qwen3.5 2B:**
  - Os 3 "não" falsos de assinatura: P02 (sombra + desfoque), P04 (pouca luz, papel amassado) e P19 (variação, pouca luz). Em P02 e P04, isso derrubou um canhoto correto para `looks_wrong`, justamente o erro caro: mandar o motorista de volta.
  - No checklist: reserva lida como 3/4 (K04, K06), pneu careca com corte lido como "good" (K08, K09) e extintor válido como "não" (K11).
- **Qwen3.5 0.8B:**
  - Em 6 painéis leu o trip (3456) em vez do ODO (O02, O04, O05, O09, O11). Também leu números em fotos que não são odômetro (RO1 = 42, RO2 = 5833) e aceitou o print com placar 5339 como km (RK1).
  - Na assinatura não deu "sim" falso, mas se absteve em 10/20.
- **Variações novas (10 itens, também incluídas nos totais acima):**
  - 2B: sugestão 5/5, data 5/5, km 3/3, assinatura 4/5 (1 "não" falso).
  - OCR combo: número 5/5, data 4/5, km 3/3.
  - 0.8B: sugestão 3/5, assinatura 2/5 (3 abstenções).

## 4. Gates do ADR 0010

| gate                                                  | OCR combo                                                                    | Qwen3.5 2B                                                        | Qwen3.5 0.8B                         | híbrido OCR + 2B      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ | --------------------- |
| JSON válido ≥ 99%                                     | 54/54                                                                        | 54/54                                                             | 54/54                                | 54/54                 |
| p95 ≤ 120 s                                           | 1,7 s                                                                        | 35 s                                                              | 22 s                                 | 36 s                  |
| odômetro ≥ Haiku − 5 p.p.                             | sem referência (Haiku não medido); 14/15 exato                               | sem referência; 15/15                                             | sem referência; 9/15                 | sem referência; 14/15 |
| vazão ≥ pico (200–400 fotos/h de uma empresa no teto) | **passa** (~4.200/h)                                                         | **reprova** (115/h a 4 vCPU)                                      | reprova (208/h)                      | reprova (~113/h)      |
| "não" falso ≤ Haiku                                   | sem referência; o OCR não responde assinatura (0 "não" falso, 20 abstenções) | sem referência; 3/14 "não" falsos de assinatura                   | sem referência; 0/14 (10 abstenções) | sem referência; 3/14  |
| "sim" falso de assinatura (pedido desta rodada)       | n/a                                                                          | 0/6                                                               | 0/6                                  | 0/6                   |
| cabe ao lado do Postgres (VPS de 8 GB)                | **sim** (0,6 GiB, < 2 s de CPU por foto)                                     | **não** (5,1 GiB anônimos e crescendo; 4 núcleos a 100% por 31 s) | não (4,2 GiB e crescendo)            | não                   |

## 5. O que o número sustenta (para o ADR 0010 revisado)

1. **O serviço de IA local pode começar com OCR clássico, ao lado do Postgres.** A configuração é o combo deste relatório: RapidOCR/ONNX, ~44 MB de modelos, 0,6 GiB e < 2 s por foto. Ele responde:
   - o número da NF (17/17);
   - a data de recebimento (17/20, sem "sim" falso);
   - a km às cegas (14/15).
     A comparação continua no código (`readProofExtraction`, `evaluateOdometerReading`). Assinatura, fraude e itens visuais ficam em "não sei", o que leva o canhoto para revisão humana. Não aprova nada errado: 0 "parece certo" indevido.
2. **O VLM pequeno para sim/não não cabe ao lado do Postgres.**
   - O 2B é o único que respondeu a assinatura sem abstenção e sem "sim" falso. Mesmo assim, deu 3 "não" falsos em 14, e cada um manda o motorista de volta.
   - Com 115 fotos/h a 4 vCPU e memória crescendo até 5,1 GiB, ele só cabe numa **caixa dedicada** (≥ 8 GB, com o teste de longa duração da seção 2 aprovado), e assíncrono.
   - O 0.8B não resolve: abstém-se em metade das assinaturas e lê o trip.
3. **O híbrido não melhora o acerto em relação ao 2B sozinho.** O 2B lê dígitos tão bem quanto o OCR neste conjunto (15/15 contra 14/15).
   - O ganho do híbrido seria **operacional**: o OCR responde quase tudo em 1 s e o VLM entra só para a assinatura do canhoto.
   - Medir isso exige um prompt curto só de sim/não (e, talvez, a foto recortada no campo de assinatura). **Não foi medido.**
4. **Combustível e pneu ficam fora da IA local.** Nenhum candidato acertou o nível (1/6) e o 2B chamou pneu careca com corte de "good". Esses itens seguem com validação humana.
5. **Fraude por foto de tela (O09) não é detectada por nenhum candidato.**
6. **Pré-checagem no aparelho (14.2).** O mesmo pipeline de OCR (det + rec em ONNX, ~44 MB) é o candidato natural para o celular. A velocidade em aparelho de entrada **não foi medida**.

## 6. Não medido, e por quê

- **MiniCPM-V 4.6 (q4_K_M, 1,6 GB), GLM-OCR (q8_0, 1,6 GB) e Qwen3.5 4B (q4_K_M, 3,3 GB) não rodaram por falta de disco, não de memória.**
  - O C: começou a sessão com 22 GB livres. A imagem do Ollama (3,78 GB comprimida), a imagem do OCR e os pesos baixados fizeram o `docker_data.vhdx` crescer.
  - O VHDX **não é esparso**, então o espaço apagado dentro da VM não volta para o Windows.
  - Depois do 2B, o C: estava com 8.257 MiB livres. A regra desta rodada (manter ≥ 8 GB livres) impediu qualquer novo download. O script parava o pull se o livre caísse abaixo de 8 GB + 200 MB.
  - O D: (5,5 GB livres) é a partição de drivers da Avell e não foi usado.
  - Ao final, depois da limpeza, o C: estava com 8.035 MiB livres. A queda de ~220 MiB depois do último download não veio deste benchmark.
  - Para recuperar o espaço, é preciso compactar o VHDX do Docker Desktop (com o Docker parado, decisão do dono, porque outros containers dependem dele).
- **PP-OCRv5 server rec latin:** não existe no RapidOCR 3.9.2, que só tem o server em `ch`. Foi medido o `ch_PP-OCRv5_rec_server`: mais lento (5 s) e pior em dígitos (7/15).
- **Haiku:** não medido (decisão 14.1 tira o provedor externo); por isso os gates relativos ao Haiku não têm referência.
- **VPS real e longa duração:** 4 vCPU de VPS compartilhada são mais lentos que `--cpus 4` num Ryzen de desktop.
- **Prompt curto de sim/não** para o VLM: não medido.

Para medir os três que faltaram numa máquina com disco, a partir de `trajetto-api/` e com o container do passo 2 da seção 7 de pé:

```bash
for M in minicpm-v4.6:q4_K_M glm-ocr:q8_0 qwen3.5:4b-q4_K_M; do
  docker exec trajetto-ai-bench-ollama ollama pull $M
  npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama --model $M \
    --dataset tmp/ai-benchmark/dataset --out tmp/ai-benchmark/results/$(echo $M | tr ':.' '--')-4cpu-6g-896px --max-side 896
  docker exec trajetto-ai-bench-ollama ollama rm $M
done
```

## 7. Comandos exatos (a partir de `trajetto-api/`)

```bash
DIR=tmp/ai-benchmark

# 1. Conjunto: 44 imagens de 28/09 + 10 variações (54)
node scripts/ai-benchmark/generate-dataset.mjs --dir $DIR/dataset --variations

# 2. OCR (imagem só do benchmark; modelos baixados no build)
docker build -t trajetto-ai-bench-ocr:3.9.2 scripts/ai-benchmark/ocr-server
# Um container novo por perfil, para medir a RAM de cada um isoladamente:
for P in v5-mobile v5-mobile+nocls v6-small v6-small+nocls v5-server+nocls combo; do
  docker rm -f trajetto-ai-bench-ocr
  docker run -d --name trajetto-ai-bench-ocr --cpus 4 --memory 6g -e OCR_THREADS=4 \
    -p 127.0.0.1:18080:8080 trajetto-ai-bench-ocr:3.9.2
  npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ocr --model "$P" \
    --dataset $DIR/dataset --out $DIR/results/ocr-$(echo $P | tr '+' '-') \
    --container trajetto-ai-bench-ocr
done
npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ocr --model combo \
  --dataset $DIR/dataset --out $DIR/results/ocr-combo-896px --max-side 896 \
  --container trajetto-ai-bench-ocr
docker rm -f trajetto-ai-bench-ocr

# 3. VLMs: Ollama 0.35.1, 4 vCPU / 6 GB, um modelo por vez, 896 px
docker run -d --name trajetto-ai-bench-ollama --cpus 4 --memory 6g \
  -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -p 127.0.0.1:11435:11434 -v trajetto-ai-bench-models:/root/.ollama ollama/ollama:0.35.1
for M in qwen3.5:0.8b-q8_0 qwen3.5:2b-q4_K_M; do
  docker exec trajetto-ai-bench-ollama ollama pull $M
  npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider ollama --model $M \
    --dataset $DIR/dataset --out $DIR/results/$(echo $M | tr ':.' '--')-4cpu-6g-896px --max-side 896
  docker exec trajetto-ai-bench-ollama ollama rm $M
done

# 4. Híbridos (sem inferência nova: junta as respostas campo a campo; latência = soma)
for V in qwen3-5-2b-q4_K_M qwen3-5-0-8b-q8_0; do
  npx tsx scripts/ai-benchmark/hybrid.mjs --ocr $DIR/results/ocr-combo \
    --vlm $DIR/results/$V-4cpu-6g-896px --out $DIR/results/hybrid-ocr-combo+$V
  npx tsx scripts/ai-benchmark/hybrid.mjs --ocr $DIR/results/ocr-combo \
    --vlm $DIR/results/$V-4cpu-6g-896px --out $DIR/results/hybrid-ocr-combo+$V-datefallback --date-fallback vlm
done

# 5. Tabelas desta página (--subset base|variations separa as 44 originais das 10 novas)
npx tsx scripts/ai-benchmark/report.mjs --dataset $DIR/dataset --runs $DIR/results/* --json $DIR/report.json

# 6. Limpeza
docker rm -f trajetto-ai-bench-ollama trajetto-ai-bench-ocr
docker volume rm trajetto-ai-bench-models
docker rmi trajetto-ai-bench-ocr:3.9.2 ollama/ollama:0.35.1
```

O que mudou no harness (só código de benchmark):

- `ocr-server/`: Dockerfile e `server.py`.
- `ocr-rules.mjs`: texto do OCR → resposta no formato do produto.
- `run-benchmark.mjs`: provedor `ocr` e perfil `combo`.
- `hybrid.mjs` e `report.mjs`: novos.
- `prompts.mjs`: `buildRequest` passa a devolver `kind`.
- `generate-dataset.mjs`: `--variations`.
- `scenes.mjs`: o canhoto aceita `handFont`, `dateSize` e `dateTilt`.
- `tests/ocr-rules.test.mjs`: novo.

`npx vitest run scripts/ai-benchmark/tests` passa: 15 testes. Os resultados brutos ficaram em `tmp/ai-benchmark/results/` (ignorado pelo git): `results.jsonl` com as linhas do OCR e as respostas cruas, `samples.jsonl` e `run.json`.

Limpeza feita ao final:

- containers `trajetto-ai-bench-ocr` e `trajetto-ai-bench-ollama` removidos;
- volume `trajetto-ai-bench-models` removido;
- imagens `trajetto-ai-bench-ocr:3.9.2` e `ollama/ollama:0.35.1` removidas.

O cache de build do Docker não foi podado, porque `docker builder prune` apagaria também o cache de outros projetos.

## 8. Fontes

- PP-OCRv5 (pipeline, tamanhos, velocidade em CPU): https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html · https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html
- PP-OCRv6 (tiny/small/medium, 50 idiomas, 0,79 s/imagem do small em Xeon 8350C com PaddlePaddle): https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html · https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec (Apache 2.0, 5,2 M parâmetros; o português não aparece nominalmente na lista de idiomas, por isso foi medido aqui) · https://huggingface.co/blog/PaddlePaddle/pp-ocrv6
- RapidOCR 3.9.2 (perfis e modelos ONNX em `default_models.yaml`; Apache 2.0): https://github.com/RapidAI/RapidOCR · https://pypi.org/project/rapidocr/
- Qwen3.5 (tags e tamanhos no Ollama): https://ollama.com/library/qwen3.5/tags · https://huggingface.co/Qwen/Qwen3.5-2B · https://huggingface.co/Qwen/Qwen3.5-0.8B
- Ollama 0.35.1 (imagem): https://hub.docker.com/r/ollama/ollama/tags
- Não medidos: https://ollama.com/library/minicpm-v4.6/tags · https://ollama.com/library/glm-ocr/tags · https://huggingface.co/Qwen/Qwen3.5-4B
- Linha de base Gemma 4 E2B: `docs/ia-benchmark-gemma-2026-09.md`

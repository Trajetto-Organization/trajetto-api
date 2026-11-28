# Benchmark do OCR: 896 px só no perfil de dígitos (18/11/2026)

Item F3-30 do plano de escala. Em 05/10 (`results-2026-10.md`), reduzir a foto a 896 px no lado maior deixou o OCR ~45% mais rápido, mas a data manuscrita do canhoto caiu de 17/20 para 8/20. A pergunta desta rodada: e se só o perfil de dígitos (odômetro) ler a foto reduzida, com o canhoto em 1600 px?

O serviço ganhou a variável `OCR_DIGITS_MAX_SIDE` (`infra/ai-ocr/server.py`): `0`, o padrão, lê toda foto como o app grava (≤ 1600 px); um valor de 320 a 4096 reduz **só** a foto do perfil `digits` até esse lado maior, e as caixas voltam nos pixels da foto enviada. O `/health` informa o valor (`digitsMaxSide`), e o `run.json` de cada execução o guarda em `describe.health`.

**Conclusão curta**

- **Fica desligado (`OCR_DIGITS_MAX_SIDE=0`).** A 896 px, a km exata às cegas caiu de 14/15 para 11/15 e o status do odômetro de 18/20 para 15/20.
- **O canhoto não mudou:** número da NF 17/17, data 17/20 com 0 "sim" falso e 0 "parece certo" indevido, igual a 1600 px. A redução não vaza para o outro perfil.
- **O ganho existe, mas é só de CPU:** a leitura de dígitos levou, em média, 0,63 s contra 1,11 s (−44%), e o p95 passou de 2,71 s para 2,02 s.
- **O erro a mais não aprova nada errado:** o "verificado" indevido segue 1 (o O09, foto de tela, igual a 1600 px). As três leituras perdidas vão para a conferência humana, o que custa mais trabalho ao gestor do que a CPU economizada.
- **Ligar só com o conjunto-ouro real** (≥ 60 odômetros, pendente desde 05/10), e só se a fila da IA pedir CPU. Os critérios: a km exata e o status iguais aos de 1600 px, e nenhum "verificado" indevido a mais.

## 1. Ambiente e método

| item      | valor                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host      | o mesmo de 05/10: Windows 11, AMD Ryzen 7 7735HS (16 threads), 16 GB; Docker Desktop (engine 29.1.3). Máquina quieta: o resto do host ficou em ~7% de CPU (máx. 11%)                       |
| Serviço   | a imagem de `infra/ai-ocr` deste commit (build local, `version` "dev"), RapidOCR 3.9.2, modelos `36919a0c16d1`                                                                             |
| Contêiner | o perfil da produção: `--cpus 2 --memory 1g --read-only --tmpfs /tmp`, `OCR_THREADS=2`, um contêiner por execução                                                                          |
| Harness   | `run-benchmark.mjs --provider local`: o serviço do produto e as regras de `src/shared/ai/local/ocr-readings.ts` (versão 1), lidas do código-fonte                                          |
| Conjunto  | as 54 imagens de 05/10, os mesmos arquivos (`tmp/ai-benchmark/dataset`): 22 canhotos, 17 odômetros, 3 odômetros do checklist e os negativos                                                |
| Execuções | `local-2cpu-1g-1600` (`OCR_DIGITS_MAX_SIDE=0`) e `local-2cpu-1g-digits-896` (`OCR_DIGITS_MAX_SIDE=896`), uma passada cada; o OCR é determinístico, então o acerto não depende da repetição |

As execuções de 05/10 entram nas tabelas só como referência de acerto. Elas rodaram a 4 CPU, com o servidor de benchmark (`ocr-server/`), e a de 896 px reduzia a foto no cliente, nos dois perfis.

## 2. Latência por perfil (2 CPU / 1 GiB)

| execução                   | canhoto: média / p50 / p95 | dígitos: média / p50 / p95 | fotos/h (seq., todas) | RAM pico (docker stats) | RAM anônima pico |
| -------------------------- | -------------------------- | -------------------------- | --------------------- | ----------------------- | ---------------- |
| `local-2cpu-1g-1600`       | 1,68 / 1,55 / 3,03 s       | 1,11 / 1,12 / 2,71 s       | 3.169                 | 0,53 GiB                | 0,47 GiB         |
| `local-2cpu-1g-digits-896` | 1,60 / 1,53 / 2,84 s       | **0,63 / 0,58 / 2,02 s**   | 3.926                 | 0,54 GiB                | 0,46 GiB         |

"Dígitos" são as 20 leituras do perfil `digits` (17 odômetros e 3 do checklist). Tempo de inferência informado pelo serviço (`inferMs`); o tempo de parede ficou a menos de 20 ms dele. A memória não muda: o que pesa são os dois motores carregados, não a foto.

## 3. Acerto (regras do produto)

| execução                                 | nº NF exato | data: certo / sim falso / não falso / abst. | "parece certo" indevido | km exato (cego) | status do odômetro | "verificado" indevido | erros de km                    |
| ---------------------------------------- | ----------- | ------------------------------------------- | ----------------------- | --------------- | ------------------ | --------------------- | ------------------------------ |
| 05/10 OCR combo, 1600 px (4 CPU)         | 17/17       | 17/20 · 0/8 · 0/12 · 3                      | 0                       | 14/15           | 18/20              | 1                     | O03                            |
| 05/10 OCR combo, 896 px nos dois perfis  | 17/17       | 8/20 · 0/8 · 8/12 · 4                       | 0                       | 12/15           | 16/20              | 1                     | O03, O07, O12                  |
| **18/11 serviço, 1600 px**               | 17/17       | 17/20 · 0/8 · 0/12 · 3                      | 0                       | 14/15           | 18/20              | 1                     | O03                            |
| **18/11 serviço, 896 px só nos dígitos** | 17/17       | 17/20 · 0/8 · 0/12 · 3                      | 0                       | **11/15**       | **15/20**          | 1                     | O03, **O04**, **O07**, **O12** |

Leituras perdidas a 896 px:

- **O03** (tambor): já errava a 1600 px (5671 em vez de 56719); a 896 px saiu 345.
- **O04** (ODO pequeno ao lado do trip em destaque): saiu 2031, um pedaço de 203118.
- **O07** (tambor 145.002) e **O12** (tambor tremido e com pouca luz): nenhum número.

O serviço a 1600 px repetiu exatamente o acerto do combo de 05/10. O caminho do produto (serviço, contrato v1 e regras da API) lê o mesmo que o servidor de benchmark.

## 4. Decisão

- `OCR_DIGITS_MAX_SIDE` fica em `0` na staging e na produção. Nenhuma Application precisa da variável.
- O botão existe para quando a CPU da IA virar gargalo, o que nenhuma medida mostrou até aqui. A 2 CPU, uma leitura de dígitos custa 1,1 s (dimensionamento da `trajetto-ai` em `docs/deploy.md`).
- Antes de ligar:
  1. medir com o conjunto-ouro real, em vez das fotos sintéticas;
  2. repetir as duas execuções abaixo, de preferência numa VPS;
  3. ligar só se a km exata e o status do odômetro ficarem iguais aos de 1600 px, sem "verificado" indevido a mais.

## 5. Comandos exatos (a partir de `trajetto-api/`)

O token é descartável e vai pelo nome (`-e AI_TOKEN`), nunca na linha de comando; o harness o lê de `BENCH_AI_TOKEN`, sem abrir o `.env`.

```bash
DIR=tmp/ai-benchmark            # o conjunto de 05/10 (generate-dataset.mjs --variations)
OUT=$DIR/results-2026-11
export AI_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export BENCH_AI_TOKEN=$AI_TOKEN
docker build -t trajetto-ai:bench infra/ai-ocr

for SIDE in 0 896; do
  NAME=$([ "$SIDE" = 0 ] && echo 1600 || echo digits-$SIDE)
  docker run -d --name trajetto-ai-bench --cpus 2 --memory 1g --read-only --tmpfs /tmp \
    -e AI_TOKEN -e OCR_THREADS=2 -e OCR_DIGITS_MAX_SIDE=$SIDE \
    -p 127.0.0.1:18080:8080 trajetto-ai:bench
  until curl -fs http://127.0.0.1:18080/health; do sleep 2; done
  npx tsx scripts/ai-benchmark/run-benchmark.mjs --provider local \
    --container trajetto-ai-bench --token-env BENCH_AI_TOKEN \
    --dataset $DIR/dataset --out $OUT/local-2cpu-1g-$NAME
  docker rm -f trajetto-ai-bench
done

npx tsx scripts/ai-benchmark/report.mjs --dataset $DIR/dataset \
  --runs $DIR/results/ocr-combo $DIR/results/ocr-combo-896px \
         $OUT/local-2cpu-1g-1600 $OUT/local-2cpu-1g-digits-896 \
  --json $OUT/report.json

docker rmi trajetto-ai:bench
```

A latência por perfil da seção 2 é a do `inferMs` de cada linha do `results.jsonl`, agrupada por `task` (`proof` é o canhoto; `odometer` e `checklist` são os dígitos).

Limpeza feita ao final: contêineres e imagem do benchmark removidos, e o builder descartável do build apagado. O cache de build do Docker não foi podado, porque apagaria também o de outros projetos.

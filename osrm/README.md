# OSRM (Open Source Routing Machine) - Trajetto

Motor de roteamento implementado usando dados do OpenStreetMap para o sistema de gestão de frotas Trajetto.

---

## 📋 Índice

- [Início Rápido](#-início-rápido)
- [Visão Geral da Arquitetura](#-visão-geral-da-arquitetura)
- [Explicação dos Dockerfiles](#-explicação-dos-dockerfiles)
- [Requisitos de Recursos](#-requisitos-de-recursos)
- [Configuração de Desenvolvimento](#-configuração-de-desenvolvimento)
- [Deploy em Produção](#-deploy-em-produção)
- [Build via GitHub Actions](#-build-via-github-actions)
- [Solução de Problemas](#-solução-de-problemas)
- [Testando Rotas](#-testando-rotas)

---

## 🚀 Início Rápido

### Para Desenvolvedores (Recomendado)

Baixe a imagem pré-construída do GitHub Container Registry:

```bash
# Inicia o container OSRM para testes
docker compose -f compose.osrm-local.yaml up -d

# Verifica saúde
curl "http://localhost:5000/route/v1/driving/-47.9292,-15.7801;-49.2646,-16.6869"
```

**Tempo de build:** ~2 minutos (apenas download)
**RAM necessária:** ~500MB
**Cobertura:** Região Centro-Oeste (Brasília, Goiânia, Cuiabá, Campo Grande)

---

## 🏗️ Visão Geral da Arquitetura

O OSRM processa dados do OpenStreetMap em três fases para criar um motor de roteamento:

```
┌─────────────────────────────────────────────────────────────┐
│                Pipeline de Processamento OSRM                │
└─────────────────────────────────────────────────────────────┘

1. EXTRACT (osrm-extract)
   Entrada:  brazil.osm.pbf (2GB de dados de mapa comprimidos)
   Saída:    brazil.osrm (grafo roteável)
   Faz:      Converte nós/caminhos OSM → grafo direcionado
   Tempo:    ~10-15min
   RAM:      ~2-4GB

2. PARTITION (osrm-partition) ⚠️ MAIS INTENSIVO EM RAM
   Entrada:  brazil.osrm
   Saída:    brazil.osrm.partition + .cells
   Faz:      Divide o grafo em células para algoritmo MLD
   Tempo:    ~15-20min
   RAM:      ~6-8GB (GARGALO!)

3. CUSTOMIZE (osrm-customize)
   Entrada:  brazil.osrm + .partition
   Saída:    brazil.osrm.mldgr + .cell_metrics
   Faz:      Pré-computa caminhos mais curtos dentro das células
   Tempo:    ~10-15min
   RAM:      ~2-3GB

RUNTIME (osrm-routed)
   Serve:    API HTTP na porta 5000
   RAM:      ~200-500MB (escala com tamanho dos dados)
```

### Estratégia de Build Multi-Stage Docker

```dockerfile
# ESTÁGIO 1: BUILDER (Processamento pesado)
FROM osrm-backend:latest AS builder
RUN download map data
RUN osrm-extract  # Intensivo em CPU + RAM
RUN osrm-partition # MAIS intensivo em RAM ⚠️
RUN osrm-customize # Intensivo em CPU
RUN cleanup source files

# ESTÁGIO 2: RUNTIME (Leve)
FROM osrm-backend:latest
COPY --from=builder /data/*.osrm* /data/
CMD osrm-routed  # Apenas serve rotas
```

**Benefícios:**
- Estágio builder é descartado após o build
- Imagem final contém apenas dados processados
- Container runtime usa RAM mínima

---

## 📦 Explicação dos Dockerfiles

### `Dockerfile.local` - Versão de Testes

**Propósito:** Ultra-leve para desenvolvimento local e testes de lógica de roteamento

**Região:** Centro-Oeste (DF, GO, MT, MS)

**Cobertura:**
- ✅ Brasília (DF)
- ✅ Goiânia (GO)
- ✅ Cuiabá (MT)
- ✅ Campo Grande (MS)

**Dados:**
- Fonte: http://download.geofabrik.de/south-america/brazil/centro-oeste-latest.osm.pbf
- Tamanho do download: **134MB**
- Tamanho processado: **~1GB**

**Processo de Build:**
```bash
# Build localmente (se necessário)
docker build -f Dockerfile.local -t trajetto-osrm:local .
```

**O que faz:**
1. Baixa dados OSM do Centro-Oeste (134MB)
2. Extrai grafo roteável (~2min)
3. Particiona em células (~1min)
4. Customiza para consultas (~30seg)
5. Remove arquivo fonte, mantém dados processados
6. Imagem final: ~1-1.2GB

**Healthcheck:** Brasília (-47.9292,-15.7801) → Goiânia (-49.2646,-16.6869)

---

### `Dockerfile.production` - Versão de Produção

**Propósito:** Cobertura completa do Brasil para deploy em produção

**Região:** Brasil (Todos os estados)

**Cobertura:**
- ✅ Todos os 26 estados + Distrito Federal
- ✅ ~8.5M km² de cobertura
- ✅ Roteamento interestadual (ex: São Paulo → Manaus)

**Dados:**
- Fonte: http://download.geofabrik.de/south-america/brazil-latest.osm.pbf
- Tamanho do download: **~1.8GB**
- Tamanho processado: **~15-20GB**

**Processo de Build:**
```bash
# ⚠️ NÃO RECOMENDADO LOCALMENTE - Use GitHub Actions
docker build -f Dockerfile.production -t trajetto-osrm:production .
```

**O que faz:**
1. Baixa dados OSM completos do Brasil (~1.8GB, ~10min)
2. Extrai grafo roteável (~15min, 3-4GB RAM)
3. Particiona em células (~20min, **8-10GB RAM** ⚠️)
4. Customiza para consultas (~15min, 2-3GB RAM)
5. Remove arquivo fonte, mantém dados processados
6. Imagem final: ~18-20GB

**Healthcheck:** São Paulo (-46.6333,-23.5505) → Manaus (-60.0217,-3.1190)

---

## 📊 Requisitos de Recursos

### Dockerfile.local (Centro-Oeste)

| Fase | CPU Cores | RAM | Tempo | Disco |
|------|-----------|-----|-------|-------|
| **Download** | 1 | 100MB | ~30seg | 134MB |
| **Extract** | 4-8 | 1-1.5GB | ~2min | +800MB |
| **Partition** | 4-8 | 1-1.5GB | ~1min | +200MB |
| **Customize** | 4-8 | 500MB | ~30seg | +100MB |
| **BUILD TOTAL** | **4-8** | **~1.5GB** | **~3-5min** | **~1.2GB** |
| **Runtime** | 2 | **~200MB** | - | 1.2GB |

✅ **Funciona em QUALQUER máquina de dev** (até laptops com 8GB RAM)

---

### Dockerfile.production (Brasil)

| Fase | CPU Cores | RAM | Tempo | Disco |
|------|-----------|-----|-------|-------|
| **Download** | 1 | 200MB | ~5-10min | 1.8GB |
| **Extract** | 8-16 | 3-4GB | ~10-15min | +12GB |
| **Partition** | 8-16 | **8-10GB** ⚠️ | ~15-20min | +3GB |
| **Customize** | 8-16 | 2-3GB | ~10-15min | +2GB |
| **BUILD TOTAL** | **8-16** | **~10GB pico** | **~35-50min** | **~18-20GB** |
| **Runtime** | 4 | **~500MB** | - | 18-20GB |

⚠️ **NÃO recomendado para builds locais** - Use GitHub Actions ou VPS de produção

---

## 💻 Configuração de Desenvolvimento

### Pré-requisitos

- Docker Desktop com WSL2 (Windows) ou Docker Engine (Linux/macOS)
- 8GB+ RAM disponível
- 5GB+ espaço livre em disco

### Configuração WSL2 Windows

Se for fazer build localmente, configure alocação de memória do WSL2:

**Arquivo:** `C:\Users\<seu-usuário>\.wslconfig`

```ini
[wsl2]
memory=10GB      # Permite builds do OSRM
swap=8GB         # Overflow emergencial
processors=12    # Deixa 4 para o Windows
localhostForwarding=true
```

**Aplicar mudanças:**
```powershell
# Execute como Administrador
wsl --shutdown
# Reinicie o Docker Desktop
```

**Verificar:**
```bash
wsl -e free -h
# Deve mostrar ~9.7GB disponível
```

---

### Rodando OSRM Localmente

#### Opção 1: Pull do GHCR (Recomendado) ⚡

```bash
# Inicia container
docker compose -f compose.osrm-local.yaml up -d

# Verifica logs
docker logs trajetto-osrm

# Testa rota
curl "http://localhost:5000/route/v1/driving/-47.9292,-15.7801;-49.2646,-16.6869" | jq
```

**Vantagens:**
- Rápido (~2min download)
- Não requer build local
- Baixo uso de RAM (~500MB)
- Sempre imagem atualizada

---

#### Opção 2: Build Local

```bash
# Edite compose.osrm-local.yaml
# Descomente seção build, comente seção image

# Build e inicia
docker compose -f compose.osrm-local.yaml up --build -d

# Acompanha progresso do build
docker compose -f compose.osrm-local.yaml logs -f
```

**Tempo:** ~3-5 minutos
**RAM:** ~1.5GB pico

---

## 🚀 Deploy em Produção

### Requisitos VPS Hetzner

#### Specs Mínimas (Cobertura Brasil)

- **CPU:** 4 cores (8+ recomendado)
- **RAM:** 4GB (8GB+ recomendado para operação suave)
- **Disco:** 25GB SSD
- **Rede:** 100Mbps+

**Plano Hetzner Recomendado:** CPX31 ou CCX23
- 4 vCPU
- 8GB RAM
- 160GB SSD
- ~€12-15/mês

---

### Métodos de Deploy

#### Método 1: Pull do GHCR (Recomendado)

```yaml
# compose.osrm-production.yaml
version: "3.8"

services:
  trajetto-osrm:
    image: ghcr.io/dongarcia/trajetto-osrm:production
    pull_policy: always
    container_name: trajetto-osrm
    restart: unless-stopped
    ports:
      - "5000:5000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/route/v1/driving/-46.6333,-23.5505;-60.0217,-3.1190"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - trajetto-network

networks:
  trajetto-network:
    external: true
```

**Deploy com Portainer:**
1. Crie stack "trajetto-osrm"
2. Cole o arquivo compose
3. Deploy
4. Aguarde ~5min para pull da imagem
5. Verifique saúde na UI do Portainer

---

#### Método 2: Build na VPS (Não Recomendado)

⚠️ **Apenas se não puder usar GHCR**

```bash
# SSH na VPS
ssh root@seu-ip-vps

# Clone repositório
git clone <seu-repo>
cd trajetto-api/osrm

# Build (levará 35-50min)
docker build -f Dockerfile.production -t trajetto-osrm:production .

# Execute
docker run -d \
  --name trajetto-osrm \
  -p 5000:5000 \
  --restart unless-stopped \
  trajetto-osrm:production
```

**Requisitos de Build na VPS:**
- 10GB RAM (temporário, apenas durante build)
- 35-50 minutos tempo de build
- 25GB espaço em disco

**Após build completar:**
- RAM runtime: ~500MB
- Pode reduzir VPS para plano de 4GB RAM

---

## 🤖 Build via GitHub Actions

A imagem de produção é construída automaticamente via GitHub Actions e enviada para o GitHub Container Registry (GHCR).

### Arquivo do Workflow

[`.github/workflows/build-osrm.yml`](../.github/workflows/build-osrm.yml)

### Requisitos de Build (GitHub Runners)

| Recurso | Valor |
|---------|-------|
| **Runner** | ubuntu-latest |
| **CPU Cores** | 2-4 (fornecido pelo GitHub) |
| **RAM** | 7GB (tier gratuito GitHub) |
| **Disco** | 14GB disponível |
| **Tempo de Build** | ~25-35min para produção |

⚠️ **Importante:** Build de produção do Brasil pode falhar nos runners gratuitos do GitHub devido a limites de RAM (precisa 8-10GB durante fase de partition). Soluções:

1. **Use self-hosted runner** na sua VPS Hetzner com 10GB RAM
2. **Build diretamente na VPS** e envie para GHCR manualmente
3. **Upgrade para GitHub Team** para runners maiores

---

### Disparando Builds

#### Trigger Manual

```bash
# Via UI do GitHub
# Vá em: Actions → Build OSRM Images → Run workflow

# Via GitHub CLI
gh workflow run build-osrm.yml
```

#### Trigger Automático

Builds automáticos em push para `main` quando arquivos mudarem:
- `osrm/**`
- `.github/workflows/build-osrm.yml`

---

### Usando Imagens Construídas

```bash
# Desenvolvimento local
docker pull ghcr.io/dongarcia/trajetto-osrm:local
docker run -d -p 5000:5000 ghcr.io/dongarcia/trajetto-osrm:local

# Produção
docker pull ghcr.io/dongarcia/trajetto-osrm:production
docker run -d -p 5000:5000 ghcr.io/dongarcia/trajetto-osrm:production
```

**Tags Disponíveis:**
- `latest` - Aponta para local (versão de teste)
- `local` - Versão de teste Centro-Oeste
- `production` - Versão Brasil completo
- `local-AAAAMMDD` - Snapshot datado
- `local-<git-sha>` - Referência do commit git

---

## 🔧 Solução de Problemas

### Container é "Killed" (Exit Code 137)

**Sintoma:**
```
failed to solve: exit code: 137
```

**Causa:** Falta de memória (OOM) - Processo morto pelo OS

**Soluções:**

1. **Verifique RAM disponível:**
```bash
# Linux/macOS
free -h

# Windows WSL2
wsl -e free -h
```

2. **Configure WSL2 (Windows):**
   - Veja [Configuração WSL2 Windows](#configuração-wsl2-windows)
   - Aumente `memory=10GB` no `.wslconfig`
   - Execute `wsl --shutdown` e reinicie Docker

3. **Use versão local ao invés:**
   - `Dockerfile.local` precisa apenas 1.5GB RAM
   - Troque de production → local para testes

4. **Pull do GHCR ao invés de buildar:**
   - Sem build = sem pico de RAM
   - Apenas ~500MB RAM runtime necessária

---

### Build Extremamente Lento ou Trava

**Sintoma:** Build travado em "Partitioning..." por 30+ minutos

**Causas:**
- RAM insuficiente → swapping para disco
- Baixa alocação de CPU
- Gargalo de I/O de disco

**Soluções:**

1. **Aumente memória WSL2:**
```ini
[wsl2]
memory=10GB
processors=12
```

2. **Verifique limites de recursos Docker:**
   - Docker Desktop → Settings → Resources
   - Aumente CPU cores para 8+
   - Aumente RAM para 8GB+

3. **Use SSD ao invés de HDD:**
   - Processamento OSRM é intensivo em I/O
   - HDD será 3-5x mais lento

---

### Respostas de Rota Inválidas

**Sintoma:** Rotas funcionam mas coordenadas fazem snap muito longe (100km+)

**Exemplo:**
```json
{
  "waypoints": [
    {
      "distance": 572953.5011  // 572km snap = RUIM!
    }
  ]
}
```

**Causa:** Coordenadas fora da região do mapa carregado

**Solução:** Verifique se coordenadas estão dentro da região

| Região | Cobertura | Coordenadas de Teste |
|--------|-----------|---------------------|
| **Centro-Oeste** | DF, GO, MT, MS | Brasília → Goiânia |
| **Brasil** | Todos estados | São Paulo → Manaus |

**Distância de snap válida:** < 1km (idealmente < 100m)

---

### Healthcheck Falhando

**Sintoma:** Container mostra "unhealthy" no Docker

**Verificar healthcheck:**
```bash
# Ver logs do healthcheck
docker inspect trajetto-osrm | jq '.[0].State.Health'

# Teste manual
curl "http://localhost:5000/route/v1/driving/-47.9292,-15.7801;-49.2646,-16.6869"
```

**Causas comuns:**
1. OSRM ainda iniciando (aguarde 10-30seg)
2. Porta não exposta corretamente
3. Coordenadas fora da região do mapa

---

## 🧪 Testando Rotas

### Endpoints da API

```bash
# Rota entre dois pontos
GET /route/v1/driving/{lon1},{lat1};{lon2},{lat2}

# Rota com geometria
GET /route/v1/driving/{coords}?overview=full&geometries=geojson

# Snap para estrada mais próxima
GET /nearest/v1/driving/{lon},{lat}
```

### Coordenadas de Teste

#### Centro-Oeste (Dockerfile.local)

```bash
# Brasília → Goiânia (~200km)
curl "http://localhost:5000/route/v1/driving/-47.9292,-15.7801;-49.2646,-16.6869" | jq

# Esperado: distância ~205km, duração ~3h
```

#### Brasil Completo (Dockerfile.production)

```bash
# São Paulo → Rio de Janeiro (~430km)
curl "http://localhost:5000/route/v1/driving/-46.6333,-23.5505;-43.1729,-22.9068" | jq

# São Paulo → Manaus (~3,200km)
curl "http://localhost:5000/route/v1/driving/-46.6333,-23.5505;-60.0217,-3.1190" | jq

# Esperado: distância ~3,200km, duração ~40-50h
```

---

### Validação de Resposta

**Rota Válida:**
```json
{
  "code": "Ok",
  "routes": [{
    "distance": 205496.9,    // metros
    "duration": 10589.3,     // segundos (~3h)
    "geometry": "..."
  }],
  "waypoints": [
    {
      "distance": 0.21,      // ✅ Snap < 1m = BOM!
      "location": [-47.929198, -15.7801],
      "name": "Estrada Parque Contorno do Bosque"
    },
    {
      "distance": 2.11,      // ✅ Snap < 10m = BOM!
      "location": [-49.264618, -16.686892],
      "name": "Avenida República do Líbano"
    }
  ]
}
```

**Rota Inválida (Coordenadas Fora do Mapa):**
```json
{
  "code": "Ok",
  "waypoints": [
    {
      "distance": 572953.50  // ❌ 572km snap = RUIM!
    }
  ]
}
```

**Regra:** Se `waypoints[].distance > 10000` (10km), coordenadas provavelmente estão fora do mapa carregado.

---

## 📚 Recursos Adicionais

- **Documentação OSRM:** https://project-osrm.org/docs/v5.24.0/
- **Downloads Geofabrik:** https://download.geofabrik.de/south-america/brazil.html
- **Wiki OpenStreetMap:** https://wiki.openstreetmap.org/wiki/Routing

---

## 🎯 Resumo

| Versão | Caso de Uso | RAM | Tempo Build | Tamanho Imagem |
|--------|-------------|-----|-------------|----------------|
| **Local** | Desenvolvimento/Testes | 1.5GB | 3-5min | 1.2GB |
| **Production** | Cobertura Brasil Completo | 10GB | 35-50min | 18-20GB |

**Workflow Recomendado:**
1. Desenvolvedores usam **versão local** (Centro-Oeste) para testes
2. Pull do GHCR (sem builds locais)
3. Produção usa **versão production** (Brasil completo)
4. Build da imagem production via **GitHub Actions** ou **na VPS**

---

**Gerado para o Projeto Trajetto**
Última atualização: 2025-01-04

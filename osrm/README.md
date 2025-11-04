# 🗺️ OSRM - Trajetto Routing Engine

## 📦 Arquitetura Multi-Stage

**Build otimizado com layers:**
- ✅ **Stage 1 (Builder):** Processa `brazil-latest.osm.pbf` (1.8GB) → dados otimizados
- ✅ **Stage 2 (Runtime):** Apenas dados processados (~400MB) + servidor
- ✅ **Resultado:** Imagem leve, rápida, usa apenas 1GB RAM em produção

## 🚀 Quick Start

### 1. Build da Imagem (UMA VEZ, ~15-30min)

```bash
# Na raiz do projeto
docker-compose -f compose.osrm-local.yaml build

# Aguarde as 3 etapas:
# - Extract:    ~3-5min  (consome 3-4GB RAM)
# - Partition:  ~8-12min (consome 6-8GB RAM)
# - Customize:  ~2-4min  (consome 2-3GB RAM)
```

### 2. Teste Local

```bash
# Sobe container isolado
docker-compose -f compose.osrm-local.yaml up

# Em outro terminal, teste
# Rota: São Paulo → Rio de Janeiro
curl "http://localhost:5000/route/v1/driving/-46.6333,-23.5505;-43.1729,-22.9068?overview=false"
```

**Resposta esperada:**
```json
{
  "code": "Ok",
  "routes": [{
    "distance": 429172.5,  // ~429km
    "duration": 15249.8    // ~4h 14min
  }]
}
```

### 3. Integrar no Compose Principal

Depois de testar OK, atualize `compose.local.yaml`:

```yaml
trajetto-osrm:
  image: trajetto-osrm:brazil  # Usa imagem local buildada
  ports:
    - "5000:5000"
  networks:
    - trajetto-network
```

## 📊 Performance

| Métrica | Valor |
|---------|-------|
| **Build Time** | 15-30min (uma vez) |
| **Image Size** | ~400-500MB |
| **RAM Usage** | ~1GB runtime |
| **Startup Time** | 5-10s |
| **Query Speed** | ~50-200ms |

## 🔄 Atualizar Dados

Dados do OpenStreetMap são atualizados semanalmente:

```bash
# 1. Baixe novo arquivo
cd osrm
rm brazil-latest.osm.pbf
wget http://download.geofabrik.de/south-america/brazil-latest.osm.pbf

# 2. Rebuild sem cache
docker-compose -f ../compose.osrm-local.yaml build --no-cache

# 3. Tag nova versão
docker tag trajetto-osrm:brazil trajetto-osrm:brazil-$(date +%Y%m%d)
```

## 🚀 Deploy Produção

```bash
# 1. Tag para registry
docker tag trajetto-osrm:brazil ghcr.io/trajetto-organization/trajetto-osrm:brazil

# 2. Push
docker push ghcr.io/trajetto-organization/trajetto-osrm:brazil

# 3. Use no compose.deploy.yaml
services:
  trajetto-osrm:
    image: ghcr.io/trajetto-organization/trajetto-osrm:brazil
```

## 🐛 Troubleshooting

### Build falha com "Killed"
- **Causa:** RAM insuficiente
- **Solução:** Docker Desktop → Settings → Resources → Memory → 10GB

### Container não inicia
```bash
# Ver logs
docker logs trajetto-osrm-dev

# Validar dados
docker run --rm trajetto-osrm:brazil ls -lh /data/
```

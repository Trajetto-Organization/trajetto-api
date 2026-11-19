# Pilha de métricas (VictoriaMetrics)

> Plano de escala, F5-30 (decisão D56). Configuração versionada, **sem subir
> agora**: a pilha custaria 400–600 MB na VPS única e cairia junto com o
> host. Ela sobe na onda 23 (item E-02), num Remote Server pequeno, o
> `trajetto-monitor`, como Applications de imagem. Até lá, o sinal continua
> pelo dead man's switch do `ops-heartbeat` (healthchecks.io), pelo Uptime
> Kuma e pelo Beszel ([deploy.md, seção 20](../../docs/deploy.md#20-alertas-e-monitoramento)).
> O teste `tests/unitaires/lifecycle/monitoring-config.test.ts` confere estes
> arquivos contra o código.

## O desenho

```
swarm de cada ambiente (staging, produção)              trajetto-monitor (Remote Server)
┌───────────────────────────────────────────┐          ┌──────────────────────────────────┐
│ trajetto-api, trajetto-worker, … :9464    │          │ trajetto-victoria-metrics :8428  │
│   GET /metrics com o METRICS_TOKEN        │          │   ▲ lê           ▲ lê e grava    │
│        ▲                                  │  rede    │   │              │               │
│        │ tasks.<App Name>, a cada 30 s    │ privada  │ trajetto-grafana trajetto-vmalert│
│ trajetto-vmagent ─────────────────────────┼─────────▶│ (painéis)        (regras, ALERTS)│
│   env=<ambiente> em toda série            │  :8428   │                                  │
└───────────────────────────────────────────┘          └──────────────────────────────────┘
```

- **vmagent, um por ambiente**, no swarm do ambiente (o projeto
  `trajetto-api`), porque só dentro do swarm o nome `tasks.<App Name>`
  responde com o endereço de cada réplica. Ele lê o `/metrics` de cada
  réplica a cada 30 s, com o `METRICS_TOKEN` daquele ambiente, põe
  `env=<ambiente>` em toda série e grava na VictoriaMetrics pela rede
  privada. Se o monitor cair, ele guarda até 1 GB em disco e reenvia depois.
- **VictoriaMetrics single**, no `trajetto-monitor`, guarda 90 dias. Todo
  pedido a ela (gravar e ler) leva usuário e senha.
- **vmalert** avalia as regras a cada minuto e grava o estado de cada alerta
  na série `ALERTS` da própria VictoriaMetrics. Ele começa **sem enviar
  nada** (`-notifier.blackhole`): quem acorda alguém continua sendo o
  healthchecks.io, com os mesmos códigos. Ver [Os alertas](#os-alertas).
- **Grafana**, no `trajetto-monitor`, com os dois painéis daqui, atrás de
  login e da Cloudflare.

O `/metrics` só tem números de infraestrutura e nenhum rótulo de empresa
nem de pessoa ([arquitetura.md, "Métricas para o Prometheus"](../../docs/arquitetura.md#saúde-e-observabilidade)).
O vmagent acrescenta só `env`, `job` (o nome da Application) e `instance` (o
endereço interno da task no swarm, nunca o de um cliente).

## Os arquivos

Todos são gerados por `yarn monitoring:render` a partir de
`infra/monitoring/monitoring-config.ts`: mude lá e rode o comando (ele passa
o Prettier). O `monitoring-config` falha se algum arquivo estiver
desatualizado, se um código de alerta novo não tiver regra ou se uma regra
ou um painel ler uma métrica que o `/metrics` não expõe.

| Arquivo do repositório                                           | Application                | Caminho no contêiner (_File Mount_)                         |
| ---------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `vmagent/scrape.yml`                                             | `trajetto-vmagent`         | `/etc/vmagent/scrape.yml`                                   |
| `vmagent/jobs/<Application>.yml` (um por Application que existe) | `trajetto-vmagent`         | `/etc/vmagent/jobs/<Application>.yml`                       |
| `vmalert/alert-codes.yml`                                        | `trajetto-vmalert`         | `/etc/vmalert/rules/alert-codes.yml`                        |
| `vmalert/process.yml`                                            | `trajetto-vmalert`         | `/etc/vmalert/rules/process.yml`                            |
| `grafana/provisioning/datasources/victoriametrics.yml`           | `trajetto-grafana`         | `/etc/grafana/provisioning/datasources/victoriametrics.yml` |
| `grafana/provisioning/dashboards/trajetto.yml`                   | `trajetto-grafana`         | `/etc/grafana/provisioning/dashboards/trajetto.yml`         |
| `grafana/dashboards/trajetto-processos.json`                     | `trajetto-grafana`         | `/etc/grafana/dashboards/trajetto/trajetto-processos.json`  |
| `grafana/dashboards/trajetto-alertas.json`                       | `trajetto-grafana`         | `/etc/grafana/dashboards/trajetto/trajetto-alertas.json`    |
| `vmalert-tests/rules.test.yml`                                   | nenhuma (só para conferir) | —                                                           |

O Dokploy não lê arquivos do repositório: cada _File Mount_ (aba
_Advanced → Volumes_, tipo _File Mount_) recebe o conteúdo colado do
arquivo. Depois de mudar um arquivo aqui, cole o conteúdo novo no mount e
faça **Deploy** da Application.

### Provar as regras

As regras rodam contra séries escritas à mão (`vmalert-tests/rules.test.yml`:
o veredito mais novo do ambiente vale, um heartbeat parado para de paginar,
uma réplica sem `/metrics`). Depois de mudar o `monitoring-config.ts`, da
raiz do repositório, com o Docker:

```bash
docker run --rm -v "$PWD/infra/monitoring:/monitoring:ro" \
  victoriametrics/vmalert-tool:v1.155.0@sha256:b03d29d0a11b906a85879a6a4009c9d0a9d5a8b9a744ebb7dd3a7721f1e78f36 \
  unittest --files=/monitoring/vmalert-tests/rules.test.yml
```

E a sintaxe de tudo (as regras e o vmagent), sem subir nada:

```bash
docker run --rm -v "$PWD/infra/monitoring/vmalert:/etc/vmalert/rules:ro" \
  victoriametrics/vmalert:v1.155.0@sha256:3256cba5ddaca5974eae6141105cec4ce37871f1c213f0a5c267ec0111bc68e1 \
  -rule='/etc/vmalert/rules/*.yml' -dryRun
docker run --rm -v "$PWD/infra/monitoring/vmagent:/etc/vmagent:ro" \
  -e METRICS_TOKEN=so-para-conferir -e TRAJETTO_API_APP_NAME=trajetto-api-staging \
  victoriametrics/vmagent:v1.155.0@sha256:8e3c03905be15bba8312d4868e8ae6f9fc2fefee0a41d544472034249ca42bb4 \
  -promscrape.config=/etc/vmagent/scrape.yml -dryRun
```

Os três passaram em 19/11/2026.

## As imagens

Fixadas por digest, conferidas em 19/11/2026 (a versão mais nova com mais
de duas semanas). Na onda 23, confira se há versão mais nova e troque a
versão e o digest juntos.

| Application                 | Imagem                                                                                                              | Memória (_Memory Limit_) |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `trajetto-vmagent`          | `victoriametrics/vmagent:v1.155.0@sha256:8e3c03905be15bba8312d4868e8ae6f9fc2fefee0a41d544472034249ca42bb4`          | 128 MiB                  |
| `trajetto-victoria-metrics` | `victoriametrics/victoria-metrics:v1.155.0@sha256:f60dc268b54ecf87f6e09d740c2b732838aa9193090cc741417c9f6386a130df` | 512 MiB                  |
| `trajetto-vmalert`          | `victoriametrics/vmalert:v1.155.0@sha256:3256cba5ddaca5974eae6141105cec4ce37871f1c213f0a5c267ec0111bc68e1`          | 128 MiB                  |
| `trajetto-grafana`          | `grafana/grafana:13.2.6@sha256:b21409d7951ddcfd63a4b49083e4ef2cc35bc1437d071813bf82bfb238b00bca`                    | 384 MiB                  |

Use as imagens com Alpine (sem o sufixo `-scratch`): o campo de comando do
Dokploy roda pelo `sh`. O vmagent é o único que fica no swarm de cada
ambiente: os 128 MiB entram na soma da régua da
[seção 23 do deploy.md](../../docs/deploy.md#23-recursos-da-vps-e-logs).

## Montar (onda 23, nesta ordem)

**Antes.** O `trajetto-monitor` cadastrado como Remote Server, na mesma
rede privada da Contabo que os servidores dos ambientes. A porta 8428 fica
fora do firewall de entrada da Contabo (o DROP final a fecha para a
internet) e só é alcançada pela rede privada (conferido no passo 2).

**Segredos novos** (cada um com `openssl rand -hex 32`, guardados no cofre):
a senha da VictoriaMetrics (uma só, para o vmagent, o vmalert e o Grafana),
a senha do admin do Grafana e, se ainda não existir, o `METRICS_TOKEN` de
cada ambiente (um valor por ambiente).

1. **O `/metrics` em cada Application do ambiente.** No _Environment_ da
   `trajetto-api` e de cada Application de papel (`trajetto-worker`,
   `trajetto-scheduler`, `trajetto-worker-external`, `trajetto-realtime`,
   `trajetto-ingest`, as que existirem): `METRICS_PORT=9464` (a porta que os
   arquivos do vmagent leem) e `METRICS_TOKEN` com o valor do ambiente.
   **Deploy** de cada uma. O log de cada réplica diz `metrics listening`
   com a porta; `metrics port could not be opened` quer dizer outra coisa
   ocupando a porta. Nenhuma _Domain_ nem porta publicada: só a rede do
   swarm alcança a 9464.
2. **`trajetto-victoria-metrics`** (no `trajetto-monitor`, projeto
   `trajetto-monitor`): _Create Service → Application_, provider Docker com a
   imagem da tabela. _Advanced_ → comando:
   `/victoria-metrics-prod -envflag.enable -envflag.prefix=VM_`.
   _Environment_:
   - `VM_storageDataPath=/storage`
   - `VM_retentionPeriod=90d`
   - `VM_httpAuth_username=trajetto`
   - `VM_httpAuth_password=<a senha da VictoriaMetrics>`

   _Volumes_: um volume em `/storage`. _Ports_: 8428 → 8428, TCP. Memória
   512 MiB. **Deploy**. Confira as duas portas: de um servidor de ambiente,
   `curl -u trajetto:<senha> http://<IP privado do monitor>:8428/health`
   responde `OK`; de fora (a sua máquina), o mesmo pedido ao IP público
   espera até o tempo limite. Se o de fora responder, apague a porta e
   reveja o firewall antes de seguir.

3. **`trajetto-vmalert`** (no monitor): imagem da tabela; comando
   `/vmalert-prod -envflag.enable -envflag.prefix=VM_`. _Environment_
   (troque `<vm>` pelo App Name da `trajetto-victoria-metrics`):
   - `VM_rule=/etc/vmalert/rules/*.yml`
   - `VM_datasource_url=http://<vm>:8428`
   - `VM_remoteWrite_url=http://<vm>:8428`
   - `VM_remoteRead_url=http://<vm>:8428`
   - `VM_notifier_blackhole=true`
   - `VM_evaluationInterval=1m`
   - `VM_datasource_basicAuth_username`, `VM_remoteWrite_basicAuth_username`
     e `VM_remoteRead_basicAuth_username` = `trajetto`
   - `VM_datasource_basicAuth_password`, `VM_remoteWrite_basicAuth_password`
     e `VM_remoteRead_basicAuth_password` = a senha da VictoriaMetrics

   _File Mounts_: os dois arquivos de `vmalert/`. Memória 128 MiB. **Deploy**.
   O log diz quantas regras leu: os códigos do `ALERT_KINDS` mais as 6 do
   `process.yml`.

4. **`trajetto-grafana`** (no monitor): imagem da tabela, sem comando.
   _Environment_:
   - `GF_SECURITY_ADMIN_PASSWORD=<a senha do admin>`
   - `GF_SERVER_ROOT_URL=https://grafana.example.com` (o seu domínio)
   - `GF_USERS_ALLOW_SIGN_UP=false`
   - `GF_AUTH_ANONYMOUS_ENABLED=false`
   - `GF_ANALYTICS_REPORTING_ENABLED=false`
   - `GF_ANALYTICS_CHECK_FOR_UPDATES=false`
   - `VICTORIA_METRICS_URL=http://<vm>:8428`
   - `VICTORIA_METRICS_USER=trajetto`
   - `VICTORIA_METRICS_PASSWORD=<a senha da VictoriaMetrics>`

   _File Mounts_: os quatro arquivos de `grafana/`. _Volumes_: um volume em
   `/var/lib/grafana`. _Domains_: o host do Grafana, pela Cloudflare (com o
   Cloudflare Access na frente, como o painel do Dokploy). Memória 384 MiB.
   **Deploy**. A pasta _Trajetto_ aparece com os dois painéis, só de
   leitura (mudança é pelo repositório).

5. **`trajetto-vmagent`, em cada ambiente** (primeiro a staging): no projeto
   `trajetto-api` do ambiente, _Create Service → Application_, imagem da
   tabela; comando `/vmagent-prod -envflag.enable -envflag.prefix=VM_`.
   _Environment_:
   - `VM_promscrape_config=/etc/vmagent/scrape.yml`
   - `VM_remoteWrite_url=http://<IP privado do monitor>:8428/api/v1/write`
   - `VM_remoteWrite_label=env=staging` (ou `env=production`)
   - `VM_remoteWrite_basicAuth_username=trajetto`
   - `VM_remoteWrite_basicAuth_password=<a senha da VictoriaMetrics>`
   - `VM_remoteWrite_tmpDataPath=/vmagent-data`
   - `VM_remoteWrite_maxDiskUsagePerURL=1GB`
   - `METRICS_TOKEN=<o METRICS_TOKEN deste ambiente>`
   - `TRAJETTO_API_APP_NAME=<o App Name da trajetto-api>` e, para cada
     Application de papel que existe, a variável do arquivo dela
     (`TRAJETTO_WORKER_APP_NAME`, `TRAJETTO_SCHEDULER_APP_NAME`,
     `TRAJETTO_WORKER_EXTERNAL_APP_NAME`, `TRAJETTO_REALTIME_APP_NAME`,
     `TRAJETTO_INGEST_APP_NAME`)

   _File Mounts_: `vmagent/scrape.yml` e o arquivo de `vmagent/jobs/` de
   cada Application que existe no ambiente (uma Application de papel criada
   depois ganha o mount e a variável dela). _Volumes_: um volume em
   `/vmagent-data`. _Placement_: `trajetto.app`. Memória 128 MiB. **Deploy**.

**Conferir.** Na task do vmagent (_Docker Terminal_ do Dokploy),
`wget -qO- http://127.0.0.1:8429/targets` lista cada réplica com `state=up`.
No Grafana, o painel _Trajetto · processos_ mostra cada Application do
ambiente e _Trajetto · alertas_ mostra a idade do último veredito abaixo de
2 min. Para ver um alerta de ponta a ponta, pare o Redis da staging por
dois minutos (o mesmo teste da [seção 20](../../docs/deploy.md#ligar-uma-vez)):
`TrajettoRedisDown` aparece no painel de alertas, e o healthchecks.io recebe
o `/fail`.

**Desfazer.** _Replicas_ 0 (ou apagar) nas Applications da pilha e
`METRICS_PORT` vazia nas da API, com **Deploy**. Nada da API depende da
pilha: sem ela, nenhuma porta nova e nenhum alerta muda.

## Os alertas

**Os motivos do heartbeat** (`vmalert/alert-codes.yml`, `severity=page`):
uma regra por código do `ALERT_KINDS` (`src/shared/health/alert-rules.ts`),
com o título e o caminho do runbook do código. A regra não refaz a conta:
ela lê `trajetto_alert_active{code}`, o veredito que o `ops-heartbeat` do
minuto deu, e por isso nunca discorda do healthchecks.io sobre quando um
motivo está ativo. Só o processo que rodou o heartbeat do minuto atualiza a
série, e o que rodou o do minuto anterior continua mostrando o que julgou
então: vale só a série da réplica com a avaliação mais nova do ambiente
(`trajetto_alert_evaluated_timestamp_seconds`), e só enquanto ela tem menos
de 5 min. O alerta dispara com o motivo ativo por 1 min.

**O que só o scrape vê** (`vmalert/process.yml`, `severity=warn`, em
observação): os limiares fixos do [slo.md](../../docs/slo.md#os-limiares-fixos-do-plano-e-onde-estão-hoje)
(event loop acima de 80% por 5 min, atraso p99 acima de 200 ms, pedido
esperando o pool por 1 min; o canário da threadpool não sai no `/metrics`)
e a saúde da própria pilha (uma réplica sem `/metrics`, o heartbeat parado,
uma série recusada).

**Ninguém é acordado pelo vmalert** enquanto ele roda com
`-notifier.blackhole`: o estado fica em `ALERTS` e no painel. Paginar por
ele pede um Alertmanager (outra Application, com o canal do Telegram) e a
troca de `VM_notifier_blackhole` por `VM_notifier_url`; é decisão do dono
depois de ver as regras de processo por algumas semanas, e o healthchecks.io
continua sendo o dead man's switch de fora (ele é quem avisa quando o
próprio monitor cai).

### Um alvo fora

`TrajettoMetricsTargetDown`: o vmagent não leu o `/metrics` de uma réplica
por 3 min. Na lista do vmagent (`/targets`, acima), o erro diz qual:

- `401`: o `METRICS_TOKEN` do vmagent é diferente do da Application (ou é o
  do outro ambiente). Os dois têm de ser o mesmo valor.
- `connection refused`: a Application está sem `METRICS_PORT=9464`, ou o
  log da réplica tem `metrics port could not be opened`.
- `no such host` ou nenhum alvo: o App Name da variável `TRAJETTO_*_APP_NAME`
  está errado, ou o arquivo do job foi montado para uma Application que não
  existe neste ambiente.
- A réplica caiu: o mesmo motivo aparece no Kuma e no healthchecks.io.

### Heartbeat parado

`TrajettoAlertVerdictStale`: nenhum processo do ambiente julgou os alertas
há mais de 5 min. O `ops-heartbeat` roda no processo com o cron
(`CRON_ENABLED`): o scheduler (ou o worker, ou a `trajetto-api` com
`PROCESS_ROLE=all`) caiu, ou o banco está fora. O healthchecks.io avisa a
mesma coisa pelo silêncio. Primeiro passo: o [runbook do cron atrasado](../../docs/runbooks/cron-overdue.md)
e o `process_heartbeat` do ambiente.

### Série recusada

`TrajettoMetricsRefusedSeries`: o `/metrics` deixou uma série de fora porque
um rótulo não estava na lista (`METRIC_LABELS`) ou tinha cara de id, e-mail,
IP ou documento. É um defeito de código, nunca de operação: o log da réplica
tem `metrics series refused: a label is not safe` com a série. A série não
saiu, então nada vazou; a correção é no código que a criou
(`src/shared/health/prometheus.ts`).

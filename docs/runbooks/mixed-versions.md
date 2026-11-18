# mixed-versions — Processos do mesmo ambiente em commits diferentes

**Dispara quando:** os processos vivos deste ambiente no `process_heartbeat` rodam dois ou mais commits há mais de 30 min, contados de quando o commit mais novo apareceu.

## O que significa

O deploy implanta todos os papéis da mesma imagem em poucos minutos (migração, IA, worker, scheduler, worker-external, API, ingest e realtime), cada um com a tag `<tag>-<papel>` no digest da API. Meia hora com commits diferentes quer dizer que um papel ficou no build anterior: o deploy dele falhou, o Swarm reverteu a task nova (o healthcheck não passou), ou a Application ficou de fora do deploy (sem o secret `DOKPLOY_<PAPEL>_APPLICATION_ID` no environment do GitHub).

Uma frota mista funciona por um tempo, porque toda mudança do plano é compatível com a versão anterior. Mas ela é o estado que as contrações (as migrations da fase de contract) não podem encontrar, e um worker velho processa as filas com o código velho.

## Primeira ação

1. Veja quem roda o quê:

   ```sql
   SELECT role, build_commit, count(*), min(started_at)
   FROM process_heartbeat
   WHERE updated_at > now() - interval '90 seconds'
   GROUP BY role, build_commit
   ORDER BY role;
   ```

2. Compare com o commit do último deploy (o resumo do run, ou `GET /health/liveness` da API).
3. Na Application do papel atrasado, no Dokploy: o último deploy falhou? O log diz por quê. Confira se a imagem é `ghcr.io/trajetto-organization/trajetto-api:<tag>-<papel>` e faça o _Deploy_.
4. Se o papel não tem o secret do applicationId no environment do GitHub, cadastre-o (`docs/deploy.md`, seção 13) para o próximo run implantá-lo.

## Como confirmar

A consulta mostra um commit só, e o motivo some do heartbeat. Com o `ROLLOUT_ROLES_EXPECTED` configurado, o próximo deploy só fica verde com todos os papéis no commit novo.

## Quando escalar

Se o papel não sobe no commit novo nem com o Deploy à mão, ou o run de deploy fica vermelho na conferência dos papéis, chame o dono: o rollback leva todos os papéis juntos (`production.yml` com `image_tag`).

## [1.2.2](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.2.1...v1.2.2) (2026-10-31)


### Bug Fixes

* **ci:** pipeline vermelho só por defeito do código, nunca por rede ou tempo ([d7f8f65](https://github.com/Trajetto-Organization/trajetto-api/commit/d7f8f65857ab05684ab1719f13d2888ee82c2759))
* **ci:** todo job roda num Ubuntu fixo (24.04), nunca no ubuntu-latest ([3134462](https://github.com/Trajetto-Organization/trajetto-api/commit/3134462c66eda49b5b253d833771b935e3f2db10))

## [1.2.1](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.2.0...v1.2.1) (2026-10-30)


### Bug Fixes

* **api:** o yarn dev gera o client do Prisma antes de esperar o banco ([d22d953](https://github.com/Trajetto-Organization/trajetto-api/commit/d22d953bb3eda4a9207b9eccdbb0c082de0d6092))

# [1.2.0](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.1.0...v1.2.0) (2026-10-30)


### Features

* **api:** robots.txt e sitemap próprios no host da API ([2d3e547](https://github.com/Trajetto-Organization/trajetto-api/commit/2d3e547f0aa7cb77dd3bc80d132a9e644db53c57))

# [1.1.0](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.0.4...v1.1.0) (2026-10-29)


### Bug Fixes

* **api:** a API volta sozinha depois que o Postgres derruba as conexões ([221b989](https://github.com/Trajetto-Organization/trajetto-api/commit/221b989b6dd3610a083e2ec2c53ce0dd2dd852bc))
* **api:** a documentação pública não tinha limite nenhum ([34e7947](https://github.com/Trajetto-Organization/trajetto-api/commit/34e7947414a7b13675d76115aef31311790f03ea))
* **api:** a sonda da IA confere o token como as leituras e diz o erro inteiro ([802d790](https://github.com/Trajetto-Organization/trajetto-api/commit/802d79013293a9845ab4b66d1fa91a459a249c60))
* **api:** esteira verde e deploy como Applications do Dokploy ([84b6727](https://github.com/Trajetto-Organization/trajetto-api/commit/84b67277cce0827b3e303678f1c4b16e2ac2570b))
* **api:** Prisma 7 — banco caindo no COMMIT volta a 503 e sessão sempre em UTC ([926937b](https://github.com/Trajetto-Organization/trajetto-api/commit/926937b5cf49e00b2604bb3aa6043a3a5e2ac233))
* **api:** Prisma 7 — conexão com FATAL sai do pool e auditoria repete o 57P03 ([589cb44](https://github.com/Trajetto-Organization/trajetto-api/commit/589cb44d71622d40974bc7fd2ec9f153ac96e58f))
* **api:** Prisma 7 — correções da revisão e gates reais da integração ([853e987](https://github.com/Trajetto-Organization/trajetto-api/commit/853e987a05cbf4571875a21248ee80d3606f1ca5))
* **api:** reenvio do fim de pausa que perde a corrida é replay, não 409 ([73ef682](https://github.com/Trajetto-Organization/trajetto-api/commit/73ef682dd2d75c4ec1b8297f5bffc2dd5864d176))
* **api:** um papel errado respondia 401, e o painel de métricas não tinha teste ([8d7e63f](https://github.com/Trajetto-Organization/trajetto-api/commit/8d7e63f0615529f2841429e6cf84f25ae34887ad))
* **auth:** banco fora do ar é 503, não 401 — e o /health responde a tempo ([58c32b8](https://github.com/Trajetto-Organization/trajetto-api/commit/58c32b8d18bb7ed6143569321f01bc9d8647bcb1))
* **auth:** iat dos tokens no mesmo instante do exp ([1cfe5da](https://github.com/Trajetto-Organization/trajetto-api/commit/1cfe5dabd890fafab64846fe74a6996841be1932))
* **comprovante:** mapa estático pede os tiles com o Referer da web ([75b8aba](https://github.com/Trajetto-Organization/trajetto-api/commit/75b8aba35d43eb7630840e14cc9a785c830ca429))
* **concorrência:** os três interruptores que perdiam um clique de dois ([c9ad665](https://github.com/Trajetto-Organization/trajetto-api/commit/c9ad6659b023c07d695857b3fd4f1c3774ec6aad))
* **concorrência:** três read-then-write e o teto de chave que nunca valeu ([527408d](https://github.com/Trajetto-Organization/trajetto-api/commit/527408d8220f96f21466d4d7a018d5f88ca00742))
* **deploy:** repete o deploy do Dokploy que termina em erro ([2bf704c](https://github.com/Trajetto-Organization/trajetto-api/commit/2bf704c31aad66b4b766456d8d5b2002d9a5b2f5))
* **entregas:** exportacao exige escrita, como todo o resto do produto ([7b71cac](https://github.com/Trajetto-Organization/trajetto-api/commit/7b71cacb85c24f423f4fa48a03bfb2c5d3d84f4e))
* **fatia-7:** a documentacao da listagem passa a dizer que e NDJSON ([f8ab4e8](https://github.com/Trajetto-Organization/trajetto-api/commit/f8ab4e84c8497cbc3dd0271bb6d029d66875a83e))
* **fatia-7:** motorista nao planeja rota -- guarda de despachante unificada ([7725494](https://github.com/Trajetto-Organization/trajetto-api/commit/77254945a2705f4b8fbba00aab74237ad8c68b20))
* **fatia-7:** tenant dentro do where de toda mutacao de rota, e update-route ([ad38624](https://github.com/Trajetto-Organization/trajetto-api/commit/ad3862427a8382f6c8c85032fb76c33561b3922c))
* **http:** uma requisição malformada deixou de virar erro do servidor ([848151f](https://github.com/Trajetto-Organization/trajetto-api/commit/848151f7fc46c304572e28185ccbdd4e9ab77f07))
* **ia:** certifi 2026.10.18 e Pillow 13, sem as críticas do scan ([e9404e2](https://github.com/Trajetto-Organization/trajetto-api/commit/e9404e20d562159161c6167aa28100f545ee1265))
* idempotencia dos canais de notificacao, canal a canal ([afe128c](https://github.com/Trajetto-Organization/trajetto-api/commit/afe128c42df8425f5eebcb7d713c139636db9215))
* **imagem:** sem npm/yarn no runtime e bcrypt 6, sem o tar vulnerável ([7ea17db](https://github.com/Trajetto-Organization/trajetto-api/commit/7ea17dbd4d0ce507f72e3ef9246ce81e1c824f56))
* **infra:** downloads do GHCR pelo IPv4 e faixas de rede conferidas toda semana ([577fc5a](https://github.com/Trajetto-Organization/trajetto-api/commit/577fc5ac133c44922bbb60a21695b4498ff94cab))
* **infra:** IPv4 preferido pelo sistema no lugar do script de egress ([d413cb1](https://github.com/Trajetto-Organization/trajetto-api/commit/d413cb117aacf4ba571744adefcd9aeb46df1b85))
* **integridade:** apagar motorista ou veiculo nao apaga mais de quem foi o trabalho ([b2c66e4](https://github.com/Trajetto-Organization/trajetto-api/commit/b2c66e40ffd0c656d5a31eda3686281f1aa18d18))
* **rotas:** liberar uma rota passou a avisar o quadro, e a partida virou idempotente ([e125ac6](https://github.com/Trajetto-Organization/trajetto-api/commit/e125ac68ef9b33cfadf59ccae8b4be5118393f51))
* **segurança:** a repetição idempotente agora tem que ser de quem repete ([61f28f3](https://github.com/Trajetto-Organization/trajetto-api/commit/61f28f362289e68aae47c52c58652116246d63f1))
* **segurança:** força bruta no login e no 2FA, e a chave do chat como credencial ([1992e6b](https://github.com/Trajetto-Organization/trajetto-api/commit/1992e6b92e6a53f022c10ce86d09088f2bfa0045))
* **segurança:** o handshake do socket agora é contado, e /refresh-token tem teto ([2dc5501](https://github.com/Trajetto-Organization/trajetto-api/commit/2dc5501510fb364c253c5be06dd10e41e1dc065a))
* **segurança:** seis furos cross-tenant e a separação motorista/despachante ([9107195](https://github.com/Trajetto-Organization/trajetto-api/commit/9107195f3e092da1113b04cbd391859dfed7187c))
* **segurança:** tokens de uso único que só eram únicos sem concorrência ([c066abe](https://github.com/Trajetto-Organization/trajetto-api/commit/c066abe8131d9d06fc98c2afa784415ed68465e6))
* **segurança:** último MASTER, oráculo de existência e idempotência global ([5ec668e](https://github.com/Trajetto-Organization/trajetto-api/commit/5ec668ec301ae53f77330ce8644ff99241c0938c))
* separa liveness de readiness e tira o boot do caminho do restart em massa ([a881f2d](https://github.com/Trajetto-Organization/trajetto-api/commit/a881f2d776249b9d5bb7655facb725dc2f9c3cd9))
* **socket:** a permissão revogada agora tira da sala, sem derrubar a conexão ([de2dbda](https://github.com/Trajetto-Organization/trajetto-api/commit/de2dbda1e20e1d084687073d2dfdb64ae580aa4c))
* **socket:** a posição de cada motorista deixou de ir para toda a empresa ([60ab7a9](https://github.com/Trajetto-Organization/trajetto-api/commit/60ab7a9eafc0216d469e72bb08c6bd1c83883326))
* **streaming:** dezoito controllers em que todo o `catch` era código morto ([15f11e9](https://github.com/Trajetto-Organization/trajetto-api/commit/15f11e95574d94f4e3d9d6ed8e80ceab97ffd073))
* teto de pageSize e OR de busca que anulava o termo procurado ([e2f645c](https://github.com/Trajetto-Organization/trajetto-api/commit/e2f645ce387878626615d35736c298f0897c5436))
* transicao de status de entrega deixa de ter janela de corrida ([9657f88](https://github.com/Trajetto-Organization/trajetto-api/commit/9657f889c64aea4d614c9b2ccc7e7298e02d6fb4))
* **upload:** uma queda do bucket deixou de apagar o canhoto do motorista ([ed1bcb7](https://github.com/Trajetto-Organization/trajetto-api/commit/ed1bcb78dfefe4f706a76d623984e3f8420704df))
* virgula faltando na descricao do get-delivery ([d1a55b0](https://github.com/Trajetto-Organization/trajetto-api/commit/d1a55b05aaa2dd80c4aee2903e9e45a80a86bdf1))


### Features

* **api:** ajustes finais de 28/10 — IDs, saúde de R2/Resend, filas, imagem e documentação ([a6d0bcc](https://github.com/Trajetto-Organization/trajetto-api/commit/a6d0bccae15f467625590586219dd522dd5134d2))
* **api:** as credenciais de integração não deixavam rastro na auditoria ([348e108](https://github.com/Trajetto-Organization/trajetto-api/commit/348e10840f9641112dc3034ac3fad749717fe50e))
* **api:** fase final de estabilização, redesign e esteira staging → produção ([217b8e3](https://github.com/Trajetto-Organization/trajetto-api/commit/217b8e3d65bddbca1546ccd02e5dba4543b11dd8))
* **api:** Prisma 7.10.1 com adapter-pg, sem query engine ([0e0d707](https://github.com/Trajetto-Organization/trajetto-api/commit/0e0d707e8719eb903003eff4ec1078b48365a35f))
* **api:** sem interruptores de transição; a logo dos e-mails vem da própria API ([005b4e2](https://github.com/Trajetto-Organization/trajetto-api/commit/005b4e24e74737359dd81d971f58a12e2d5b90aa))
* backup e restore do Postgres, com o ensaio de restauracao feito ([69bdd9c](https://github.com/Trajetto-Organization/trajetto-api/commit/69bdd9c3161a5f3b1940e711127158a1c9b32ece))
* **dashboard:** o painel principal passou a saber que a empresa entrega ([04f39a4](https://github.com/Trajetto-Organization/trajetto-api/commit/04f39a4e7213845101d9926e6abcca4950295d0c))
* **entregas:** o motorista passa a saber quando o painel muda uma entrega dele ([4c6c59d](https://github.com/Trajetto-Organization/trajetto-api/commit/4c6c59d30599f12685e38c35f2371e7bd95c7f4f))
* **fatia-10:** canhoto lido pela IA, decidido por uma pessoa ([a710c92](https://github.com/Trajetto-Organization/trajetto-api/commit/a710c92ae7490619d0b9306e00e6eb38315e236a))
* **fatia-11:** API publica /integration/v1 com chave, escopo e cursor ([2698b27](https://github.com/Trajetto-Organization/trajetto-api/commit/2698b27fd5c315a97049c962f3e7cd12428b0578))
* **fatia-11:** contrato de integracao -- catalogo, assinatura e chaves ([9970b87](https://github.com/Trajetto-Organization/trajetto-api/commit/9970b87fd3657c5ae220a5c6aafc1be1642add26))
* **fatia-7:** "Em rota" vira fato sobre a rota, com um escritor so ([04ffb10](https://github.com/Trajetto-Organization/trajetto-api/commit/04ffb10302adf9f2219e64d1ac2cc1d4999f181f))
* **fatia-7:** a ordem das paradas chega ao telefone do motorista ([2e760cf](https://github.com/Trajetto-Organization/trajetto-api/commit/2e760cffed54e33b91d816c3bbc94c84ba0717e3))
* **fatia-7:** a parada se resolve pelo desfecho da entrega, no mesmo commit ([9cdc890](https://github.com/Trajetto-Organization/trajetto-api/commit/9cdc8904e72220f1729a618a83a29ce619eb2115))
* **fatia-7:** a rota passa a existir como entidade -- modelo e regras ([4af89eb](https://github.com/Trajetto-Organization/trajetto-api/commit/4af89eb0ad73d0fd6d254476512b3c48c33f4cf3))
* **fatia-7:** dois eventos de rota no outbox, nao quatro ([6fe49df](https://github.com/Trajetto-Organization/trajetto-api/commit/6fe49dfbb98a4195f4ba7ec62529d05ab3f6b88f))
* **fatia-7:** eventos de rota em tempo real, com duas plateias ([85daea4](https://github.com/Trajetto-Organization/trajetto-api/commit/85daea4aec5e8721b8141db0235f06f86a07aa69))
* **fatia-7:** repositorio e use cases de escrita da rota ([a1a5144](https://github.com/Trajetto-Organization/trajetto-api/commit/a1a5144bacf3f3b4dbbb5959e78a1a0cab070e0f))
* **fatia-7:** superficie HTTP da rota -- 10 endpoints, schemas e Swagger ([49290d9](https://github.com/Trajetto-Organization/trajetto-api/commit/49290d90d768977e25e0f50613eb003ed660087b))
* **fatia-7:** use cases de leitura e de parada, e uma unica partida ([f8cd9f8](https://github.com/Trajetto-Organization/trajetto-api/commit/f8cd9f8f126df0f1b978007960b603b1f1d029ee))
* **fatia-8:** importacao por planilha com estorno ([4a2fe2b](https://github.com/Trajetto-Organization/trajetto-api/commit/4a2fe2bbf60b10915ab4ceb111eb5599aeca7935))
* **fatia-8:** leitor da planilha de importacao, com modelo nosso ([23e70f3](https://github.com/Trajetto-Organization/trajetto-api/commit/23e70f3b32b3af584253d38c7cb633ee0712b617))
* **fatia-8:** mudar status na mao passa a exigir motivo, e vira evento ([9fc855c](https://github.com/Trajetto-Organization/trajetto-api/commit/9fc855c639c1e79255797dd97a853d0d8fdae456))
* **fatia-8:** superficie http da importacao e exportacao em streaming ([8f91985](https://github.com/Trajetto-Organization/trajetto-api/commit/8f9198572a1f3b876738cf1a34190351ccfb6d7e))
* **fatia-8:** trilha de suporte -- tudo que aconteceu com a entrega, numa lista ([5689a1b](https://github.com/Trajetto-Organization/trajetto-api/commit/5689a1b885214cb53d51271534d96f1b69958c68))
* **fatia-9:** a empresa escreve as proprias mensagens ao cliente ([a9d0fe4](https://github.com/Trajetto-Organization/trajetto-api/commit/a9d0fe4f9a2c38e39289e90b857a946622a61314))
* **fatia-9:** comprovante em PDF com hash e pagina publica de verificacao ([81d87b6](https://github.com/Trajetto-Organization/trajetto-api/commit/81d87b62686506f5ca136b204e45edc27349327f))
* **fatia-9:** o cliente sabe quando o caminhao sai ([6020b23](https://github.com/Trajetto-Organization/trajetto-api/commit/6020b237e232cb3037e4419f9fb449f5c3715c05))
* **fatia-9:** o pipeline de notificacao passa a enderecar quem nao tem conta ([f371ca2](https://github.com/Trajetto-Organization/trajetto-api/commit/f371ca2fa5838d0af0d11168782e52bace7c9a69))
* **fatia-9:** portal do destinatario, sem login e escrito como subtracao ([757adf0](https://github.com/Trajetto-Organization/trajetto-api/commit/757adf01277489f49cacbdb59de0e1d44d7540e7))
* **integrations:** monitor do outro lado — o que o sistema do cliente pediu ([a14d380](https://github.com/Trajetto-Organization/trajetto-api/commit/a14d3808593850418568aa4300f5daecd3162e14))
* **integrations:** portal público, /docs fechado e o corpo assinado de verdade ([63f69b1](https://github.com/Trajetto-Organization/trajetto-api/commit/63f69b19d2710b7ecf44e2faf50fc56c7ae8da70))
* **integrations:** webhooks saem na mesma transação do fato que descrevem ([7635cf5](https://github.com/Trajetto-Organization/trajetto-api/commit/7635cf500e33c87016bbb0eed9874658c1f345c5))
* modulo de Entregas, Chat, fila em Postgres e correcoes da auditoria ([81a14dd](https://github.com/Trajetto-Organization/trajetto-api/commit/81a14dda881ff97c972603588d9324c4f6ae0b21))
* **rotas:** a designação em lote virou o que o plano diz que ela é — uma rota ([f5b0868](https://github.com/Trajetto-Organization/trajetto-api/commit/f5b08686af4e44006861c902474c64d0e936b50f))
* **torre:** posições do motorista particionadas por dia e a torre de controle ([7032f80](https://github.com/Trajetto-Organization/trajetto-api/commit/7032f804952680bce4dfde5e8fa5ffbab71c3a1b))


### Performance Improvements

* **api:** as paradas de uma rota entravam uma a uma, e ninguém olhava o plano ([afa20c0](https://github.com/Trajetto-Organization/trajetto-api/commit/afa20c0a69fa004cc3e1a8fe3260c7b30d3cdc84))
* **api:** auditoria de 28/10 — Sistema, imports, exports, login e decisões da reunião ([ddba288](https://github.com/Trajetto-Organization/trajetto-api/commit/ddba2883b622fa89351854f12824ac74e7a9286b))
* **api:** quatro gargalos medidos com k6 e corrigidos ([52ee094](https://github.com/Trajetto-Organization/trajetto-api/commit/52ee0944889f8257ee5c8ca1ce6229bd68e61cf9))
* indices por tenant -- 15 entram, 15 saem, saldo liquido zero ([932c8fe](https://github.com/Trajetto-Organization/trajetto-api/commit/932c8fe096f852ec6eb7d5172233e6a9399dfc3b))
* **trends:** o gráfico custava trezentas idas ao banco; agora custa duas ([8e6352e](https://github.com/Trajetto-Organization/trajetto-api/commit/8e6352e57986f5c0792099a95c61282d43f9a164))

## [1.0.4](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.0.3...v1.0.4) (2026-08-12)


### Bug Fixes

* tira o CHANGELOG.md do lint ([9bf25eb](https://github.com/Trajetto-Organization/trajetto-api/commit/9bf25eb793869d973c86d35fcec1b0d9bb509854))

## [1.0.3](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.0.2...v1.0.3) (2026-08-11)


### Bug Fixes

* para de vazar clientes Redis a cada tentativa de reconexao ([573f7ad](https://github.com/Trajetto-Organization/trajetto-api/commit/573f7ad8e0687f3f84cd99c42d8264e703d2f0e2))

## [1.0.2](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.0.1...v1.0.2) (2026-08-11)


### Performance Improvements

* remove date-fns nao utilizado e move glob para devDependencies ([22b81be](https://github.com/Trajetto-Organization/trajetto-api/commit/22b81be382b05807de59f762e8866501c468b8ae))

## [1.0.1](https://github.com/Trajetto-Organization/trajetto-api/compare/v1.0.0...v1.0.1) (2026-08-11)


### Bug Fixes

* separa os caches do yarn e serializa o acesso no build Docker ([f809ef0](https://github.com/Trajetto-Organization/trajetto-api/commit/f809ef0d269a8226dae0cd3f3bf2ffacaadcd951))

# 1.0.0 (2026-08-11)


### Bug Fixes

* alinha o Node do CI em 22 e tira a dependencia do baseUrl depreciado ([b226d12](https://github.com/Trajetto-Organization/trajetto-api/commit/b226d12a7354cc703042e7cde44cd1315a5652fe))
* compose evolution deploy rename ([57f4579](https://github.com/Trajetto-Organization/trajetto-api/commit/57f45798f736d455cc112f2f95ca5bde268d6cf6))
* compose.local fixes ([392eb00](https://github.com/Trajetto-Organization/trajetto-api/commit/392eb00542b95895c63b9f1f43f87be4300b0e51))
* deploy.yml e2e test environment and compose.production variables ([0109e86](https://github.com/Trajetto-Organization/trajetto-api/commit/0109e86b244da2b8008fbeedb09d17ced7be71dd))
* destrava o build Docker e torna a poda de producao deterministica ([541e0a0](https://github.com/Trajetto-Organization/trajetto-api/commit/541e0a017cb5461747a8295a266a81c54f018f72))
* drena o multipart antes de responder erro e remove R2_PUBLIC_DOMAIN ([6b30a20](https://github.com/Trajetto-Organization/trajetto-api/commit/6b30a20d29ca03d2bae8f6ec51f4f6512db583e4))
* e2e and unitaires tests ([80a82a5](https://github.com/Trajetto-Organization/trajetto-api/commit/80a82a5de87aa52b00b2c137ffb2d47ac3061ea2))
* evolution api configs ([cb56e6a](https://github.com/Trajetto-Organization/trajetto-api/commit/cb56e6ac9816b2b185434eb33a2dda1834a7e4e3))
* evolution api fields ([3b6aeae](https://github.com/Trajetto-Organization/trajetto-api/commit/3b6aeaeb2a65ed16588da4a06b1de563fb39ed6a))
* excel export odometer photo ([aeb44e2](https://github.com/Trajetto-Organization/trajetto-api/commit/aeb44e2b29ab6f9a9618a224eb9dc5dbaae683e0))
* excel fine export fixes ([4123103](https://github.com/Trajetto-Organization/trajetto-api/commit/4123103856a107e9e00b7efe99d7cadc458856a0))
* fecha bypass de isolamento multi-tenant via businessId no body ([e5dd895](https://github.com/Trajetto-Organization/trajetto-api/commit/e5dd895e4950925243286885b5913b9b23940977))
* fix compose.deploy whatsapp seed ([afdaa79](https://github.com/Trajetto-Organization/trajetto-api/commit/afdaa795e760f7bb67f5e0d47958f016fdb03b89))
* fix compose.deploy/tsup configurations ([0c690b4](https://github.com/Trajetto-Organization/trajetto-api/commit/0c690b455c36fc0898b114a460ce12473ac48c4c))
* fix kanban card ([f65638f](https://github.com/Trajetto-Organization/trajetto-api/commit/f65638f76cd087fd33254db00259392024c070d4))
* fix seed whatsapp instance in production ([9148b13](https://github.com/Trajetto-Organization/trajetto-api/commit/9148b1368c76d251eab9c7bfe87b1f75c3dabc4b))
* fix two factor authentication send email title ([2be682a](https://github.com/Trajetto-Organization/trajetto-api/commit/2be682a7f59d2ec9c6c1c463fc59f0e44b0f31a5))
* fix vehicle module ([9a97596](https://github.com/Trajetto-Organization/trajetto-api/commit/9a975969f8adda8f3662f96e6ece5e422b6a28de))
* ghcr actions ([75373a8](https://github.com/Trajetto-Organization/trajetto-api/commit/75373a88054b91b52b61845244a8f1910a0371f7))
* github actions and .env.test ([b88dd62](https://github.com/Trajetto-Organization/trajetto-api/commit/b88dd6201a385a82e9b2f14043f9a69121445de8))
* github workflow variables ([38f9314](https://github.com/Trajetto-Organization/trajetto-api/commit/38f9314ce2777a1f3b8a5a35f10a423f5d2cac25))
* remove ignoreDeprecations invalido que quebrava o typecheck ([a308554](https://github.com/Trajetto-Organization/trajetto-api/commit/a308554081d74e3b3f3c0866c99569f35e17f274))
* service-order routes ([21cdddd](https://github.com/Trajetto-Organization/trajetto-api/commit/21cdddd85832461b5aa63157caffe655d1d8a2de))
* shared email provider ([d55b3ed](https://github.com/Trajetto-Organization/trajetto-api/commit/d55b3ed60a4bc8279bc7d1a0f5747772182da590))
* tsup config ([b624587](https://github.com/Trajetto-Organization/trajetto-api/commit/b6245871e7c03287b50de91e683fb6aceca8d1c4))
* tsup.config/dockefile ([af8067b](https://github.com/Trajetto-Organization/trajetto-api/commit/af8067b50d807af5c8db446de46ca7cdb9316ea4))
* tsyringe whatsapp worker ([126c681](https://github.com/Trajetto-Organization/trajetto-api/commit/126c6813ddef8989f3486b787cf79165147d5df1))
* unitaires tests / create-user-usecase throw catch apperror / add replicas on deploy config docker compose ([d360712](https://github.com/Trajetto-Organization/trajetto-api/commit/d3607121e189a7141c00bbfa0f2611ea0089a904))
* whatsapp module ([f239f89](https://github.com/Trajetto-Organization/trajetto-api/commit/f239f89741116667a279dcd4f116718d858f9507))
* whatsapp webhook ([fce029f](https://github.com/Trajetto-Organization/trajetto-api/commit/fce029f8d147d66bf85e77b7e79ec0a0c7f1aae8))
* whatsapp webhook logs ([d22bc7f](https://github.com/Trajetto-Organization/trajetto-api/commit/d22bc7fbd8df2dccf21e72de17308f228f98a5cc))


### Features

* remove api from compose.development/update method terminologies in scripts/add a timeout for workers in case they fail, preventing an infinite loop. ([d925000](https://github.com/Trajetto-Organization/trajetto-api/commit/d9250006b189155ebbef8edb45d912241c3c3a80))


### Performance Improvements

* migra a imagem da API para Alpine e remove binarios inuteis do sharp ([c64d6f4](https://github.com/Trajetto-Organization/trajetto-api/commit/c64d6f485c1eaff30872104c6ebeed70d11d79c3))

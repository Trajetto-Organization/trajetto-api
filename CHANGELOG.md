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

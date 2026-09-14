# Uniques globais num SaaS multi-tenant — análise e o que está bloqueado

Status: **aguardando decisão de produto** em quatro campos. Nada foi alterado.

O schema tem 53 declarações de unicidade. A pergunta não é "este dado é único
no Brasil?" — é **"duas transportadoras podem ter o mesmo registro?"**, e para
os campos que importam identidade nacional não decide nada.

## O padrão que o inventário revela

Todos os uniques globais de negócio nascem na migration inicial
(`20250509134728_router_engine_table`, linhas 422/425/431/434). **Todo modelo
criado depois** — `Shipper`, `OccurrenceType`, `Delivery`, `ChatThread`,
`Fuel`, `VehicleChecklist`, `AIUsagePeriod`, `BusinessEntitlement` — usa
composto com `businessId`, sem exceção.

Isso é evidência de que a convenção evoluiu e os modelos antigos ficaram para
trás, não de que alguém decidiu conscientemente manter `Vehicle` e `Driver`
globais. Reforçando: o schema é muito comentado — há justificativa escrita para
`PushDeviceToken.token` ser global, para `ScheduledJobExecution`, para
`Notification.deliveryId`. Os blocos `Vehicle` (469-515) e `Driver` (432-467)
são os dois únicos modelos do arquivo **sem um único comentário**.

## Manter global — decidido pelo código

| Campo | Por quê |
|---|---|
| `User.email` | O login é `findFirst` por e-mail puro, sem tenant. Reset de senha, 2FA e verificação de e-mail identificam a pessoa só pelo e-mail, em três tabelas de token que nem têm `businessId`. E `businessId` é nullable (o MASTER não pertence a nenhuma transportadora), então a chave composta nem funcionaria — o Postgres trata NULLs como distintos. **Mudar quebra a autenticação inteira.** |
| `Business.*` | `Business` **é** o tenant. Não há `businessId` para compor. |
| `Branch.cnpj` | CNPJ é identidade nacional emitida pela Receita. Duas transportadoras registrarem o mesmo CNPJ de filial é, por definição, erro de cadastro. |
| `TrafficViolationCode` | Tabela de referência DETRAN. Dado nacional compartilhado. |
| Tokens, `PushDeviceToken.token`, `client_submission_id`, chaves de idempotência | Ids técnicos de alta entropia. Colisão entre tenants é impossível na prática. |

> Achado lateral: existe `findUserByEmailAndBusinessId`
> (`user-repository.ts:296`), declarado na interface e implementado no fake, e
> **nenhum usecase o chama**. Alguém já considerou e-mail por tenant, escreveu
> o método e nunca ligou nada nele.

## Recomendo mudar — defensável pelo código

### `Branch.erp_code`

É o código do ERP **do próprio cliente**: texto livre de até 50 caracteres, sem
semântica nacional, sem validação de formato. Cada transportadora numera as
filiais dela como quiser — `001`, `MATRIZ`, `SP01`.

**Com 3.600 tenants, colisão em `001` é matemática, não hipótese.** O primeiro
cliente que digitar `001` bloqueia os outros 3.599 — e a mensagem que ele vê é
*"os códigos ERP de filiais devem ser únicos em todo o sistema"*, que o suporte
não tem como defender.

Quebra: `branch-repository.ts:161` (é `findFirst`, então **compila**), mais os
chamadores em `create-business-usecase.ts:101` e `update-business-usecase.ts`.
Atenção ao acoplamento: `create-business-usecase.ts:118-125` cria a filial
matriz copiando `...businessData`, então mesmo CNPJ, razão social, e-mail e
`erp_code` da empresa.

### `Driver.rg`

RG **não é identidade nacional**. É emitido por SSP estadual, e o mesmo número
existir em UFs diferentes é fato conhecido. Um unique global em RG está
factualmente errado, **independentemente de multi-tenancy**. Além disso é
`String` não-nulo: todo motorista é obrigado a ter um, então não dá para deixar
em branco para contornar.

Alternativa igualmente defensável: **remover o unique de vez**. A identidade
real do motorista já é o CPF.

Quebra: **a compilação**, em `driver-repository.ts:174` (`findUnique`). É o
único par do schema onde a mudança se auto-detecta.

## Bloqueado — precisa de decisão de produto

O código mostra que a resposta atual é "global", e que ela é **declarada ao
usuário final**: as mensagens de erro dizem literalmente "em todo o sistema"
(`vehicle-already-exists-error.ts:4`, `driver-cpf-already-exists-error.ts:4`,
e mais seis), e essas strings aparecem na documentação OpenAPI pública. Não é
refatoração; é mudança de produto.

### `Vehicle.license_plate` + `Vehicle.renavam`

Placa e RENAVAM **são** identidade nacional única de um veículo. Mas `Vehicle`
não representa *o veículo* — representa *o veículo na operação daquela
transportadora*: tem `driverId`, `branchId`, `current_mileage`,
`maintenance_interval_km`, `status`, tudo operacional e específico do tenant.

E o schema **já modela o agregado, explicitamente**: `enum FleetType { OWNED,
THIRD_PARTY }` (linha 47), `Vehicle.fleet_type` (476), `Vehicle.fleet_id`
(477, documentado como *"Fleet ID if third party"*), `enum ContractType` (42),
`Driver.contract_type` (446). O que ele **não** modela é o compartilhamento:
`Vehicle.businessId` é `String` não-nulo, 1:N, sem tabela de vínculo e sem
vigência. Um veículo pertence a uma transportadora, para sempre.

Ou seja: a modelagem diz *"esta transportadora tem, na frota dela, um veículo
que é de terceiro"* — a descrição exata de um agregado — e o unique global
torna **impossível** que duas transportadoras cadastrem o mesmo agregado.

> **Pergunta:** quando um caminhoneiro agregado presta serviço para a
> Transportadora A e para a B, as duas devem conseguir cadastrar o caminhão
> dele — cada uma com sua quilometragem, seu plano de manutenção e suas multas?
> Ou é regra do produto que uma placa só existe em uma frota, e a segunda
> precisa esperar a primeira dar baixa?

> **Ponto adicional que a resposta precisa cobrir:**
> `findVehicleByLicensePlate` (`vehicle-repository.ts:184`) consulta **todos os
> tenants**. Se a Transportadora B digita uma placa que a A usa, ela recebe
> confirmação de que aquele veículo existe no sistema — é vazamento de
> existência por enumeração. Mesmo que a decisão seja manter global, a mensagem
> precisa parar de confirmar isso.

### `Driver.cnh` + `Driver.cpf`

Mesmo raciocínio. CPF e CNH identificam a *pessoa*; `Driver` é a pessoa
*contratada por aquela transportadora* — tem `branchId`, `status`,
`contract_type`, e uma `ChatThread` própria por `[businessId, driverId]`.

As duas decisões **andam juntas**: o agregado é o par motorista + caminhão.
Decidir uma sem a outra deixa o produto num meio-termo onde a Transportadora B
cadastra o motorista mas não o caminhão.

> **Pergunta:** um motorista autônomo pode estar cadastrado em duas
> transportadoras ao mesmo tempo? Se sim, cada uma vê só os próprios
> abastecimentos, checklists, multas e conversa de chat dele?

### `Branch.corporate_reason` + `Branch.email`

Razão social não é única nacionalmente — é registrada por UF na Junta
Comercial. E aqui o unique é redundante: o `cnpj` já é o identificador forte da
filial.

O e-mail tem um problema que nem é entre tenants: hoje **uma mesma
transportadora não consegue usar `contato@empresa.com.br` em duas filiais
dela**. Compor com `businessId` não resolve isso; só remover o unique resolve.

> **Pergunta:** razão social e e-mail de filial precisam mesmo ser únicos, ou
> basta o CNPJ? Uma transportadora pode repetir o e-mail de contato entre as
> filiais dela?

## Três armadilhas, se a decisão for mudar

1. **A migration sozinha não muda comportamento nenhum** para
   `license_plate`, `renavam` e `cnh`. A rejeição vive no usecase, via
   `findFirst` **sem `businessId`** (`vehicle-repository.ts:184` e `:197`,
   `driver-repository.ts:184`). Trocar `@unique` por `@@unique` sem tocar
   nesses três métodos produz uma migration de risco com zero efeito
   observável — e uma constraint que nunca é exercitada, porque o usecase
   bloqueia antes.

2. **Só `cpf` e `rg` avisam.** São os dois `findUnique` reais. Os outros passam
   silenciosos no `tsc`.

3. **Os fakes in-memory replicam a semântica global**
   (`in-memory-vehicle-repository.ts:154`) e são usados nos testes de
   isolamento. Precisam mudar junto, senão a suíte passa a validar a regra
   antiga.

Sobre os dados existentes não há risco: ir de global para composto é sempre um
**relaxamento** — toda linha que satisfazia `UNIQUE(cpf)` satisfaz
`UNIQUE(businessId, cpf)`. O risco está no caminho de volta: uma vez
permitidos duplicados entre tenants, reverter exige limpeza manual.

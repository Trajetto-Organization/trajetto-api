# Modelos de WhatsApp (Meta)

> Gerado a partir do código por `yarn docs:whatsapp` (`scripts/generate-whatsapp-docs.ts`): `src/shared/notifications/whatsapp-templates.ts` (17 internos) e `src/shared/delivery/customer-whatsapp-templates.ts` (4 ao cliente). Plano de 02/11/2026, itens B1, B2, B7 e B8. Mudou um modelo no código? Rode `yarn docs:whatsapp` (o `whatsapp-templates-doc.test.ts` falha enquanto este arquivo e o código divergirem) e reenvie o modelo para revisão na Meta **antes** de publicar o código.

## Como criar na Meta (igual para todos)

WhatsApp Manager > Modelos de mensagem > Criar modelo:

- **Categoria:** Utilidade. **Idioma:** Português (BR). **Tipo de variável:** Número.
- **Nome:** exatamente o do título de cada modelo.
- **Cabeçalho e rodapé:** nenhum. **Botões:** nenhum nos 17 internos; nos 4 ao cliente, dois botões de URL (abaixo).
- **Corpo:** copie o bloco exatamente, com as quebras e as linhas em branco, sem negrito e sem emoji no texto fixo.
- **Amostras:** preencha cada `{{n}}` com a coluna Amostra.
- **Período de validade da mensagem:** ative e escolha o valor indicado. Se a lista da Meta não tiver o valor exato, escolha o mais próximo abaixo.
- **Botões de URL (só os 4 ao cliente):** tipo URL dinâmica, com a origem da web do ambiente (`https://staging.intrajetto.com` no staging, `https://www.intrajetto.com` na produção) seguida do caminho da tabela. A única variável é o fim da URL: o token de acompanhamento (64 caracteres hexadecimais). "Parar de receber" abre a rota curta `/parar/<token>` da web (item B5).

Todos os corpos começam e terminam com texto fixo, nunca têm duas variáveis seguidas e ficam abaixo de 1024 caracteres no pior caso (o código corta cada valor no limite da tabela, com "…", e nunca envia um valor vazio: vai o valor padrão). `tests/unitaires/notifications/whatsapp-templates.test.ts` confere essas regras.

## O que o código faz quando um modelo falta ou não foi aprovado

- O envio daquele modelo falha sem nova tentativa (erro da Meta 132000, 132001 ou 132012), com uma linha de erro no log que nomeia o modelo. Os outros modelos continuam saindo.
- Uma pausa da Meta (132015) segura só aquele modelo e tenta de novo depois (`template-lane.ts`).
- O `/health/providers` lista os 21 modelos com o estado de cada um (`template:<nome>`) e acusa como problema: modelo inexistente, não aprovado, fora de pt_BR, na categoria MARKETING, com outra quantidade de variáveis ou, nos 4 ao cliente, sem os dois botões de URL terminados em `{{1}}`.
- O webhook `template_category_update` (assine no app da Meta) registra um erro no log quando um dos 21 sai de UTILITY, no aviso de 24 h antes e na mudança.

## Os 17 modelos internos

### `trajetto_entrega_insucesso`

- **Evento:** delivery-occurrence.reported
- **Validade:** 3 horas
- **Variáveis:** 5

Corpo (copie exatamente, com as linhas em branco):

```text
A entrega para {{1}} foi registrada como Insucesso após uma ocorrência.

Ocorrência: {{2}}
Registrada por: {{3}}
Relato: {{4}}
Fotos anexadas: {{5}}

Confira os detalhes da entrega no Trajetto.
```

| Variável | O que leva                                | Limite | Valor padrão               | Amostra                                                                       |
| -------- | ----------------------------------------- | ------ | -------------------------- | ----------------------------------------------------------------------------- |
| `{{1}}`  | Nome do destinatário da entrega           | 150    | destinatário não informado | Mercado Bom Preço Ltda                                                        |
| `{{2}}`  | Tipo de ocorrência que causou o insucesso | 100    | não informada              | Cliente ausente                                                               |
| `{{3}}`  | Quem registrou a ocorrência               | 100    | não informado              | João Pereira                                                                  |
| `{{4}}`  | Relato de quem registrou, em uma linha    | 200    | não informado              | Ninguém atendeu no portão após três tentativas e o telefone estava desligado. |
| `{{5}}`  | Quantidade de fotos anexadas              | 10     | nenhuma                    | 2                                                                             |

### `trajetto_autorizacao_ocorrencia`

- **Evento:** delivery-occurrence.authorization_requested (NOT_DELIVERED ou PAUSE)
- **Validade:** 15 minutos (ou 10, se a lista da Meta não tiver 15)
- **Variáveis:** 5

Corpo (copie exatamente, com as linhas em branco):

```text
Uma ocorrência na entrega para {{1}} aguarda a sua autorização.

Ocorrência: {{2}}
Solicitante: {{3}}
Respostas do formulário: {{4}}
Relato: {{5}}

Responda pela torre de controle do Trajetto.
```

| Variável | O que leva                                              | Limite | Valor padrão               | Amostra                                                              |
| -------- | ------------------------------------------------------- | ------ | -------------------------- | -------------------------------------------------------------------- |
| `{{1}}`  | Nome do destinatário da entrega                         | 150    | destinatário não informado | Mercado Bom Preço Ltda                                               |
| `{{2}}`  | Tipo de ocorrência que pede autorização                 | 100    | não informada              | Recusa no recebimento                                                |
| `{{3}}`  | Quem pediu, com " (motorista)" quando foi o motorista   | 112    | não informado              | João Pereira (motorista)                                             |
| `{{4}}`  | Respostas do formulário: "Rótulo: valor; Rótulo: valor" | 200    | nenhuma                    | Ligou para o cliente: Sim; Motivo da recusa: Mercadoria avariada     |
| `{{5}}`  | Relato de quem registrou, em uma linha                  | 200    | não informado              | Duas caixas chegaram amassadas e o cliente recusou o pedido inteiro. |

### `trajetto_autorizacao_entrega`

- **Evento:** delivery-occurrence.authorization_requested (DELIVERED)
- **Validade:** 15 minutos (ou 10, se a lista da Meta não tiver 15)
- **Variáveis:** 5

Corpo (copie exatamente, com as linhas em branco):

```text
A entrega para {{1}} aguarda a sua autorização para ser registrada como Entregue.

Tipo de entrega: {{2}}
Solicitante: {{3}}
Respostas do formulário: {{4}}
Relato: {{5}}

Responda pela torre de controle do Trajetto.
```

| Variável | O que leva                                              | Limite | Valor padrão               | Amostra                                                                |
| -------- | ------------------------------------------------------- | ------ | -------------------------- | ---------------------------------------------------------------------- |
| `{{1}}`  | Nome do destinatário da entrega                         | 150    | destinatário não informado | Farmácia Vida Nova                                                     |
| `{{2}}`  | Tipo de entrega (tipo de ocorrência DELIVERED)          | 100    | não informado              | Entregue a vizinho                                                     |
| `{{3}}`  | Quem pediu, com " (motorista)" quando foi o motorista   | 112    | não informado              | Carlos Lima (motorista)                                                |
| `{{4}}`  | Respostas do formulário: "Rótulo: valor; Rótulo: valor" | 200    | nenhuma                    | Nome de quem recebeu: Ana Costa; Número da casa do vizinho: 152        |
| `{{5}}`  | Relato de quem registrou, em uma linha                  | 200    | não informado              | Destinatário viajando; a vizinha autorizou o recebimento por telefone. |

### `trajetto_autorizacao_sem_resposta`

- **Evento:** delivery-occurrence.authorization_escalated
- **Validade:** 30 minutos
- **Variáveis:** 4

Corpo (copie exatamente, com as linhas em branco):

```text
O pedido de autorização na entrega para {{1}} está sem resposta há {{2}} minutos.

Motivo: {{3}}
Solicitante: {{4}}

Responda pela torre de controle do Trajetto.
```

| Variável | O que leva                                                                             | Limite | Valor padrão               | Amostra                                          |
| -------- | -------------------------------------------------------------------------------------- | ------ | -------------------------- | ------------------------------------------------ |
| `{{1}}`  | Nome do destinatário da entrega                                                        | 150    | destinatário não informado | Mercado Bom Preço Ltda                           |
| `{{2}}`  | Minutos inteiros de espera quando escalou                                              | 10     | mais de 10                 | 12                                               |
| `{{3}}`  | Tipo do pedido                                                                         | 100    | não informado              | Cliente ausente                                  |
| `{{4}}`  | Quem pediu e a situação: " (motorista, aguardando no endereço)" quando foi o motorista | 136    | não informado              | João Pereira (motorista, aguardando no endereço) |

### `trajetto_multa_registrada`

- **Evento:** fine.created
- **Validade:** 12 horas
- **Variáveis:** 11

Corpo (copie exatamente, com as linhas em branco):

```text
Uma nova multa de trânsito foi registrada no Trajetto para um veículo da sua empresa. Os dados do registro estão abaixo.

Veículo: {{1}}
Motorista: {{2}}
Filial: {{3}}
Infração: {{4}}
Data da infração: {{5}}
Local: {{6}}
Pontos na carteira: {{7}}
Valor: {{8}}
Vencimento: {{9}}
Observação: {{10}}
Registrada por: {{11}}

Confira os detalhes completos da multa na página Multas do Trajetto.
```

| Variável | O que leva                                                                  | Limite | Valor padrão  | Amostra                                                                 |
| -------- | --------------------------------------------------------------------------- | ------ | ------------- | ----------------------------------------------------------------------- |
| `{{1}}`  | Placa do veículo multado                                                    | 20     | não informado | RTA4F21                                                                 |
| `{{2}}`  | Motorista vinculado à multa                                                 | 60     | não informado | Carlos Eduardo Pereira                                                  |
| `{{3}}`  | Filial, pela razão social                                                   | 80     | não informada | Transportes Andrade Ltda - Filial Campinas                              |
| `{{4}}`  | Código da infração e a descrição, quando houver                             | 120    | não informada | 745-50 – Transitar em velocidade superior à máxima permitida em até 20% |
| `{{5}}`  | Dia da infração no fuso da empresa                                          | 20     | não informada | 14/10/2026                                                              |
| `{{6}}`  | Local da infração                                                           | 100    | não informado | Rodovia Anhanguera, km 98, sentido interior                             |
| `{{7}}`  | Pontos na carteira (zero é "0")                                             | 10     | não informado | 4                                                                       |
| `{{8}}`  | Valor da multa                                                              | 30     | não informado | R$ 130,16                                                               |
| `{{9}}`  | Dia do vencimento no fuso da empresa                                        | 20     | não informado | 28/11/2026                                                              |
| `{{10}}` | Observação da multa, em uma linha                                           | 100    | nenhuma       | Notificação recebida pelos Correios                                     |
| `{{11}}` | Quem registrou: "Nome (e-mail)", ou "Suporte Trajetto" quando foi um master | 120    | não informado | Fernanda Lopes (fernanda.lopes@exemplo.com.br)                          |

### `trajetto_ordem_servico`

- **Evento:** service-order.created, service-order.updated (troca de responsável)
- **Validade:** 12 horas
- **Variáveis:** 7

Corpo (copie exatamente, com as linhas em branco):

```text
Uma ordem de serviço do veículo {{1}} foi atribuída a você como responsável.

Código da OS: {{2}}
Descrição: {{3}}
Tipo de manutenção: {{4}}
Data da ordem: {{5}}
Valor total: {{6}}
Quilometragem: {{7}}

Confira os detalhes da ordem de serviço no Trajetto.
```

| Variável | O que leva                                                 | Limite | Valor padrão         | Amostra                                                     |
| -------- | ---------------------------------------------------------- | ------ | -------------------- | ----------------------------------------------------------- |
| `{{1}}`  | Placa do veículo da ordem                                  | 20     | sem placa cadastrada | RTA4F21                                                     |
| `{{2}}`  | Código curto da ordem (o "OS #…" do web, sem "#")          | 40     | não informado        | 8f2c4a9e1b3d                                                |
| `{{3}}`  | Descrição da ordem, em uma linha                           | 150    | não informada        | Troca de óleo do motor e dos filtros de ar e de combustível |
| `{{4}}`  | Tipo de manutenção (Interna ou Externa)                    | 20     | não informado        | Externa                                                     |
| `{{5}}`  | Data da ordem no fuso da empresa                           | 20     | não informada        | 02/11/2026                                                  |
| `{{6}}`  | Valor total da ordem                                       | 30     | não informado        | R$ 1.850,00                                                 |
| `{{7}}`  | Quilometragem na abertura e, quando houver, após o serviço | 80     | não informada        | 152.340 km na abertura e 152.410 km após o serviço          |

### `trajetto_conta_pagar`

- **Evento:** account-payable.created, account-payable.updated (troca de responsável)
- **Validade:** 12 horas
- **Variáveis:** 6

Corpo (copie exatamente, com as linhas em branco):

```text
Uma conta a pagar no valor de {{1}} foi atribuída a você como responsável.

Favorecido: {{2}}
Vencimento: {{3}}
Categoria: {{4}}
Descrição: {{5}}
Ordem de serviço vinculada: {{6}}

Confira os detalhes da conta a pagar no Trajetto.
```

| Variável | O que leva                                       | Limite | Valor padrão  | Amostra                            |
| -------- | ------------------------------------------------ | ------ | ------------- | ---------------------------------- |
| `{{1}}`  | Valor da conta                                   | 30     | não informado | R$ 1.850,00                        |
| `{{2}}`  | Favorecido: o fornecedor ou o nome digitado      | 120    | não informado | Auto Center Rota Sul               |
| `{{3}}`  | Dia do vencimento no fuso da empresa             | 20     | não informado | 10/11/2026                         |
| `{{4}}`  | Categoria; "Outros (descrição)" quando é OTHER   | 120    | não informada | Manutenção                         |
| `{{5}}`  | Descrição da conta, em uma linha                 | 150    | não informada | Revisão dos 150 mil km do caminhão |
| `{{6}}`  | Ordem de serviço vinculada: código curto e placa | 80     | nenhuma       | 8f2c4a9e1b3d (veículo RTA4F21)     |

### `trajetto_kanban_card_criado`

- **Evento:** kanban-card.created
- **Validade:** 12 horas
- **Variáveis:** 4

Corpo (copie exatamente, com as linhas em branco):

```text
Um novo card do kanban da sua empresa no Trajetto foi atribuído a você como responsável.

Card: {{1}}
Prioridade: {{2}}
Vencimento: {{3}}
Descrição: {{4}}

Confira os detalhes do card no kanban do Trajetto.
```

| Variável | O que leva                                       | Limite | Valor padrão  | Amostra                                                                                     |
| -------- | ------------------------------------------------ | ------ | ------------- | ------------------------------------------------------------------------------------------- |
| `{{1}}`  | Título do card                                   | 100    | sem título    | Trocar pastilhas de freio do caminhão RKT4B21                                               |
| `{{2}}`  | Prioridade, com o emoji de urgência              | 20     | 🟢 Baixa      | 🔴 Alta                                                                                     |
| `{{3}}`  | Dia de vencimento no fuso da empresa             | 20     | não informado | 22/11/2026                                                                                  |
| `{{4}}`  | Descrição em uma linha (linhas unidas com " · ") | 200    | não informada | Levar o caminhão à oficina parceira até sexta e conferir também o nível do fluido de freio. |

### `trajetto_kanban_card_atualizado`

- **Evento:** kanban-card.updated (troca de responsável)
- **Validade:** 12 horas
- **Variáveis:** 4

Corpo (copie exatamente, com as linhas em branco):

```text
Um card do kanban da sua empresa no Trajetto foi atualizado e passou para a sua responsabilidade.

Card: {{1}}
Prioridade: {{2}}
Vencimento: {{3}}
Descrição: {{4}}

Confira os detalhes do card no kanban do Trajetto.
```

| Variável | O que leva                                       | Limite | Valor padrão  | Amostra                                                                         |
| -------- | ------------------------------------------------ | ------ | ------------- | ------------------------------------------------------------------------------- |
| `{{1}}`  | Título do card                                   | 100    | sem título    | Revisão dos 50.000 km da van QWE2F45                                            |
| `{{2}}`  | Prioridade, com o emoji de urgência              | 20     | 🟢 Baixa      | 🟡 Média                                                                        |
| `{{3}}`  | Dia de vencimento no fuso da empresa             | 20     | não informado | 18/11/2026                                                                      |
| `{{4}}`  | Descrição em uma linha (linhas unidas com " · ") | 200    | não informada | Conferir o orçamento da oficina e aprovar a troca do óleo e dos filtros da van. |

### `trajetto_modulo_plano`

- **Evento:** business-module.changed (para os outros masters)
- **Validade:** 12 horas
- **Variáveis:** 4

Corpo (copie exatamente, com as linhas em branco):

```text
Um módulo do plano de uma empresa foi alterado no Trajetto.

Empresa: {{1}}
Módulo: {{2}}
Situação atual: {{3}}
Alteração feita por: {{4}}

Se esta alteração não era esperada, confira imediatamente os módulos dessa empresa no Trajetto.
```

| Variável | O que leva                                  | Limite | Valor padrão  | Amostra                                        |
| -------- | ------------------------------------------- | ------ | ------------- | ---------------------------------------------- |
| `{{1}}`  | Empresa, pela razão social                  | 150    | não informada | Transportes Serra Azul Ltda                    |
| `{{2}}`  | Nome do módulo, como a tela mostra          | 60     | não informado | Entregas                                       |
| `{{3}}`  | Novo estado do módulo                       | 20     | não informada | Desabilitado                                   |
| `{{4}}`  | Master que fez a alteração: "Nome (e-mail)" | 203    | não informado | Rafael Moreira (rafael.moreira@exemplo.com.br) |

### `trajetto_modulo_habilitado_empresa`

- **Evento:** business-module.changed (administradores, módulo habilitado)
- **Validade:** 12 horas
- **Variáveis:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Um módulo foi habilitado no plano da sua empresa pelo Suporte Trajetto.

Empresa: {{1}}
Módulo: {{2}}

As telas do módulo já estão disponíveis no menu do Trajetto.
```

| Variável | O que leva                         | Limite | Valor padrão  | Amostra                     |
| -------- | ---------------------------------- | ------ | ------------- | --------------------------- |
| `{{1}}`  | Empresa, pela razão social         | 150    | não informada | Transportes Serra Azul Ltda |
| `{{2}}`  | Nome do módulo, como a tela mostra | 60     | não informado | Entregas                    |

### `trajetto_modulo_desabilitado_empresa`

- **Evento:** business-module.changed (administradores, módulo desabilitado)
- **Validade:** 12 horas
- **Variáveis:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Um módulo foi desabilitado no plano da sua empresa pelo Suporte Trajetto.

Empresa: {{1}}
Módulo: {{2}}

As telas do módulo saíram do menu, mas nenhum dado foi apagado: ao reabilitar o módulo, tudo volta como estava.
```

| Variável | O que leva                         | Limite | Valor padrão  | Amostra                     |
| -------- | ---------------------------------- | ------ | ------------- | --------------------------- |
| `{{1}}`  | Empresa, pela razão social         | 150    | não informada | Transportes Serra Azul Ltda |
| `{{2}}`  | Nome do módulo, como a tela mostra | 60     | não informado | Gestão de Frota             |

### `trajetto_limite_plano`

- **Evento:** business-limit.changed (para os outros masters)
- **Validade:** 12 horas
- **Variáveis:** 5

Corpo (copie exatamente, com as linhas em branco):

```text
Um limite do plano de uma empresa foi alterado no Trajetto.

Empresa: {{1}}
Tipo de limite: {{2}}
Limite anterior: {{3}}
Novo limite: {{4}}
Alteração feita por: {{5}}

Se esta alteração não era esperada, confira imediatamente o plano dessa empresa no Trajetto.
```

| Variável | O que leva                                  | Limite | Valor padrão  | Amostra                                        |
| -------- | ------------------------------------------- | ------ | ------------- | ---------------------------------------------- |
| `{{1}}`  | Empresa, pela razão social                  | 150    | não informada | Transportes Serra Azul Ltda                    |
| `{{2}}`  | Qual limite contratado mudou                | 60     | não informado | Veículos contratados                           |
| `{{3}}`  | Limite anterior, com a unidade              | 60     | não informado | 20 veículos                                    |
| `{{4}}`  | Novo limite, com a unidade                  | 60     | não informado | 35 veículos                                    |
| `{{5}}`  | Master que fez a alteração: "Nome (e-mail)" | 203    | não informado | Rafael Moreira (rafael.moreira@exemplo.com.br) |

### `trajetto_limite_plano_empresa`

- **Evento:** business-limit.changed (administradores)
- **Validade:** 12 horas
- **Variáveis:** 4

Corpo (copie exatamente, com as linhas em branco):

```text
Um limite do plano da sua empresa foi alterado pelo Suporte Trajetto.

Empresa: {{1}}
Tipo de limite: {{2}}
Limite anterior: {{3}}
Novo limite: {{4}}

Acompanhe o consumo na aba Limites de Uso do Trajetto.
```

| Variável | O que leva                     | Limite | Valor padrão  | Amostra                     |
| -------- | ------------------------------ | ------ | ------------- | --------------------------- |
| `{{1}}`  | Empresa, pela razão social     | 150    | não informada | Transportes Serra Azul Ltda |
| `{{2}}`  | Qual limite contratado mudou   | 60     | não informado | Fotos da Verificação IA     |
| `{{3}}`  | Limite anterior, com a unidade | 60     | não informado | 500 fotos por mês           |
| `{{4}}`  | Novo limite, com a unidade     | 60     | não informado | 1.000 fotos por mês         |

### `trajetto_master_criado`

- **Evento:** master-user.created (para quem criou)
- **Validade:** 1 hora
- **Variáveis:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Você criou um novo usuário Master no Trajetto.

Nome: {{1}}
E-mail: {{2}}

O link para definir a senha de acesso foi enviado para esse e-mail.
```

| Variável | O que leva            | Limite | Valor padrão  | Amostra                      |
| -------- | --------------------- | ------ | ------------- | ---------------------------- |
| `{{1}}`  | Nome do novo master   | 100    | não informado | Juliana Prado Souza          |
| `{{2}}`  | E-mail do novo master | 254    | não informado | juliana.prado@exemplo.com.br |

### `trajetto_master_atualizado`

- **Evento:** master-user.updated (para quem alterou)
- **Validade:** 1 hora
- **Variáveis:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Você alterou os dados de um usuário Master no Trajetto.

Usuário: {{1}}
Alterações: {{2}}

Confira os dados desse usuário na lista de usuários Master do Trajetto.
```

| Variável | O que leva                             | Limite | Valor padrão   | Amostra                                                                                                        |
| -------- | -------------------------------------- | ------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `{{1}}`  | Nome do master editado, como era antes | 100    | não informado  | Juliana Prado Souza                                                                                            |
| `{{2}}`  | Resumo do que mudou, em uma linha      | 480    | dados da conta | nome: Juliana Prado → Juliana Prado Souza, e-mail: juliana.prado@exemplo.com.br → juliana.souza@exemplo.com.br |

### `trajetto_conta_master_atualizada`

- **Evento:** master-user.account-updated (para o master cuja conta mudou)
- **Validade:** 12 horas
- **Variáveis:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Sua conta Master no Trajetto foi alterada.

Alterações: {{1}}
Alteração feita por: {{2}}

Se você não reconhece esta alteração, avise a equipe do Trajetto imediatamente para proteger sua conta.
```

| Variável | O que leva                                  | Limite | Valor padrão   | Amostra                                                                                                   |
| -------- | ------------------------------------------- | ------ | -------------- | --------------------------------------------------------------------------------------------------------- |
| `{{1}}`  | Resumo do que mudou na conta, em uma linha  | 480    | dados da conta | e-mail: juliana.prado@exemplo.com.br → juliana.souza@exemplo.com.br, link de redefinição de senha enviado |
| `{{2}}`  | Master que fez a alteração: "Nome (e-mail)" | 203    | não informado  | Rafael Moreira (rafael.moreira@exemplo.com.br)                                                            |

## Os 4 modelos ao cliente final

Um por momento. A mensagem sai **uma por parada**, não por NF-e (item B6): a referência lista as NF-e da parada.

### `trajetto_cliente_saiu_para_entrega`

- **Evento:** delivery.dispatched (a rota saiu com a entrega)
- **Validade:** 12 horas
- **Variáveis:** 3 · **Botões de URL:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Olá, {{1}}. A transportadora {{2}} informa que a sua entrega ({{3}}) saiu hoje para o endereço de destino.

Acompanhe pelo botão abaixo.
```

| Variável | O que leva                                                                                    | Limite | Valor padrão                 | Amostra                |
| -------- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------- |
| `{{1}}`  | Nome do destinatário                                                                          | 60     | cliente                      | Mercado Bom Preço      |
| `{{2}}`  | Nome da transportadora (fantasia, senão razão social)                                         | 60     | responsável pela sua entrega | Transportes Serra Azul |
| `{{3}}`  | Referência da carga: "NF-e 123, 124 e mais 2", senão "pedido X", senão "sem número informado" | 60     | sem número informado         | NF-e 4521 e 4522       |

| Botão (URL) | Texto              | URL na Meta                              | Amostra do sufixo                                                  |
| ----------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| 0           | Acompanhar entrega | `https://<host da web>/acompanhar/{{1}}` | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |
| 1           | Parar de receber   | `https://<host da web>/parar/{{1}}`      | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |

### `trajetto_cliente_a_caminho`

- **Evento:** delivery.on_the_way (o motorista está indo para o endereço)
- **Validade:** 1 hora
- **Variáveis:** 3 · **Botões de URL:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Olá, {{1}}. O motorista da transportadora {{2}} está a caminho do seu endereço com a entrega ({{3}}).

Acompanhe pelo botão abaixo.
```

| Variável | O que leva                                                                                    | Limite | Valor padrão                 | Amostra                |
| -------- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------- |
| `{{1}}`  | Nome do destinatário                                                                          | 60     | cliente                      | Mercado Bom Preço      |
| `{{2}}`  | Nome da transportadora (fantasia, senão razão social)                                         | 60     | responsável pela sua entrega | Transportes Serra Azul |
| `{{3}}`  | Referência da carga: "NF-e 123, 124 e mais 2", senão "pedido X", senão "sem número informado" | 60     | sem número informado         | NF-e 4521 e 4522       |

| Botão (URL) | Texto              | URL na Meta                              | Amostra do sufixo                                                  |
| ----------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| 0           | Acompanhar entrega | `https://<host da web>/acompanhar/{{1}}` | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |
| 1           | Parar de receber   | `https://<host da web>/parar/{{1}}`      | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |

### `trajetto_cliente_entregue`

- **Evento:** delivery.delivered (comprovante ou painel)
- **Validade:** 12 horas
- **Variáveis:** 4 · **Botões de URL:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Olá, {{1}}. A transportadora {{2}} confirma que a entrega ({{3}}) foi concluída em {{4}}.

O comprovante está disponível pelo botão abaixo.
```

| Variável | O que leva                                                                                    | Limite | Valor padrão                 | Amostra                |
| -------- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------- |
| `{{1}}`  | Nome do destinatário                                                                          | 60     | cliente                      | Mercado Bom Preço      |
| `{{2}}`  | Nome da transportadora (fantasia, senão razão social)                                         | 60     | responsável pela sua entrega | Transportes Serra Azul |
| `{{3}}`  | Referência da carga: "NF-e 123, 124 e mais 2", senão "pedido X", senão "sem número informado" | 60     | sem número informado         | NF-e 4521 e 4522       |
| `{{4}}`  | Data e hora da entrega no fuso da transportadora                                              | 30     | data não informada           | 17/09/2026, 14:30      |

| Botão (URL) | Texto              | URL na Meta                              | Amostra do sufixo                                                  |
| ----------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| 0           | Acompanhar entrega | `https://<host da web>/acompanhar/{{1}}` | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |
| 1           | Parar de receber   | `https://<host da web>/parar/{{1}}`      | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |

### `trajetto_cliente_insucesso`

- **Evento:** delivery.failed (ocorrência que impede a entrega, ou painel)
- **Validade:** 12 horas
- **Variáveis:** 3 · **Botões de URL:** 2

Corpo (copie exatamente, com as linhas em branco):

```text
Olá, {{1}}. A transportadora {{2}} não conseguiu concluir a entrega ({{3}}) hoje.

Veja os detalhes pelo botão abaixo.
```

| Variável | O que leva                                                                                    | Limite | Valor padrão                 | Amostra                |
| -------- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------- |
| `{{1}}`  | Nome do destinatário                                                                          | 60     | cliente                      | Mercado Bom Preço      |
| `{{2}}`  | Nome da transportadora (fantasia, senão razão social)                                         | 60     | responsável pela sua entrega | Transportes Serra Azul |
| `{{3}}`  | Referência da carga: "NF-e 123, 124 e mais 2", senão "pedido X", senão "sem número informado" | 60     | sem número informado         | NF-e 4521 e 4522       |

| Botão (URL) | Texto              | URL na Meta                              | Amostra do sufixo                                                  |
| ----------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| 0           | Acompanhar entrega | `https://<host da web>/acompanhar/{{1}}` | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |
| 1           | Parar de receber   | `https://<host da web>/parar/{{1}}`      | `0f3a6c1e9b2d4f8a7c5e3b1d9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a` |

## Depois do rollout

`trajetto_notification` (o modelo genérico, classificado como Marketing) não é mais usado pelo código. Exclua-o na Meta **só depois** de alguns dias sem uso. As variáveis `META_WHATSAPP_TEMPLATE_NAME` e `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME` não são mais lidas e saem do código depois do rollout.

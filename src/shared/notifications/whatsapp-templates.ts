/**
 * The WhatsApp templates the product sends, one per event and audience (plan
 * of 02/11/2026, items B1, B2 and B7). The single source of truth for:
 *
 *  - what each render must produce (name and parameter count — a mismatch is
 *    Meta's 132000, permanent);
 *  - how each parameter is fitted before it leaves (flattened, cut with "…",
 *    a fallback instead of an empty string — Meta refuses an empty parameter
 *    with 131008/100);
 *  - the 1024-character body guard (Meta's 132005);
 *  - /health/providers, which checks each name is APPROVED, pt_BR, UTILITY
 *    and has this many variables;
 *  - the copy the owner pastes into Meta (docs/whatsapp-modelos.md).
 *
 * Before, every internal notice went out under one generic template with a
 * single parameter, `trajetto_notification`; vague enough that Meta filed it
 * as Marketing. The bodies below are the reviewed texts: never edit one
 * without a new review at Meta (an approved template takes one edit a day,
 * ten in thirty days), and never rename one here without creating it there
 * first.
 */

/** Meta's ceiling for a template's rendered body (fixed text + parameters). */
const WHATSAPP_BODY_LIMIT = 1024;

interface WhatsAppTemplateVariable {
  /** What it carries, in pt-BR, for the documentation and the review. */
  meaning: string;

  /** Short name shown in the web's fixed preview, e.g. "[destinatário]". */
  label?: string;

  /** Longest value sent; longer ones are cut and end in "…". */
  max: number;

  /** Sent when the value is missing or empty: Meta refuses "". */
  fallback: string;

  /** Meta's example value for the review. */
  sample: string;
}

interface WhatsAppTemplateButton {
  /** The button's label, as created at Meta. */
  text: string;

  /** The path after the web origin, ending in the button's only variable. */
  path: string;

  sample: string;
}

interface WhatsAppTemplateDefinition {
  name: string;

  /** Internal notices go to users; customer messages to people without one. */
  audience: "internal" | "customer";

  /** The events (and the case, when one event has two texts) it serves. */
  serves: string;

  /** The body exactly as approved, with {{1}}…{{n}}. */
  body: string;

  variables: readonly WhatsAppTemplateVariable[];

  /** URL buttons, in order (index 0, 1…). Customer templates only. */
  buttons?: readonly WhatsAppTemplateButton[];

  /** The validity period to pick at Meta, in pt-BR. */
  validity: string;
}

const NOT_INFORMED = "não informado";
const NOT_INFORMED_F = "não informada";

const ACTOR = (meaning: string): WhatsAppTemplateVariable => ({
  meaning,
  max: 203,
  fallback: NOT_INFORMED,
  sample: "Rafael Moreira (rafael.moreira@exemplo.com.br)",
});

const COMPANY: WhatsAppTemplateVariable = {
  meaning: "Empresa, pela razão social",
  max: 150,
  fallback: NOT_INFORMED_F,
  sample: "Transportes Serra Azul Ltda",
};

const MODULE: WhatsAppTemplateVariable = {
  meaning: "Nome do módulo, como a tela mostra",
  max: 60,
  fallback: NOT_INFORMED,
  sample: "Entregas",
};

const RECIPIENT: WhatsAppTemplateVariable = {
  meaning: "Nome do destinatário da entrega",
  max: 150,
  fallback: "destinatário não informado",
  sample: "Mercado Bom Preço Ltda",
};

const ONE_LINE_REPORT = (sample: string): WhatsAppTemplateVariable => ({
  meaning: "Relato de quem registrou, em uma linha",
  max: 200,
  fallback: NOT_INFORMED,
  sample,
});

const REQUESTER = (sample: string): WhatsAppTemplateVariable => ({
  meaning: 'Quem pediu, com " (motorista)" quando foi o motorista',
  max: 112,
  fallback: NOT_INFORMED,
  sample,
});

const ANSWERS = (sample: string): WhatsAppTemplateVariable => ({
  meaning: 'Respostas do formulário: "Rótulo: valor; Rótulo: valor"',
  max: 200,
  fallback: "nenhuma",
  sample,
});

const LIMIT_KIND: WhatsAppTemplateVariable = {
  meaning: "Qual limite contratado mudou",
  max: 60,
  fallback: NOT_INFORMED,
  sample: "Veículos contratados",
};

const LIMIT_VALUE = (
  meaning: string,
  sample: string,
): WhatsAppTemplateVariable => ({
  meaning,
  max: 60,
  fallback: NOT_INFORMED,
  sample,
});

const KANBAN_VARIABLES = (samples: {
  title: string;
  priority: string;
  due: string;
  description: string;
}): readonly WhatsAppTemplateVariable[] => [
  {
    meaning: "Título do card",
    max: 100,
    fallback: "sem título",
    sample: samples.title,
  },
  {
    meaning: "Prioridade, com o emoji de urgência",
    max: 20,
    fallback: "🟢 Baixa",
    sample: samples.priority,
  },
  {
    meaning: "Dia de vencimento no fuso da empresa",
    max: 20,
    fallback: NOT_INFORMED,
    sample: samples.due,
  },
  {
    meaning: 'Descrição em uma linha (linhas unidas com " · ")',
    max: 200,
    fallback: NOT_INFORMED_F,
    sample: samples.description,
  },
];

/**
 * The 17 internal templates (B1), all UTILITY, pt_BR, no header, footer or
 * buttons. The names are the owner's, created at Meta exactly so.
 */
const INTERNAL_WHATSAPP_TEMPLATES = {
  trajetto_entrega_insucesso: {
    name: "trajetto_entrega_insucesso",
    audience: "internal",
    serves: "delivery-occurrence.reported",
    body: "A entrega para {{1}} foi registrada como Insucesso após uma ocorrência.\n\nOcorrência: {{2}}\nRegistrada por: {{3}}\nRelato: {{4}}\nFotos anexadas: {{5}}\n\nConfira os detalhes da entrega no Trajetto.",
    variables: [
      RECIPIENT,
      {
        meaning: "Tipo de ocorrência que causou o insucesso",
        max: 100,
        fallback: NOT_INFORMED_F,
        sample: "Cliente ausente",
      },
      {
        meaning: "Quem registrou a ocorrência",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "João Pereira",
      },
      ONE_LINE_REPORT(
        "Ninguém atendeu no portão após três tentativas e o telefone estava desligado.",
      ),
      {
        meaning: "Quantidade de fotos anexadas",
        max: 10,
        fallback: "nenhuma",
        sample: "2",
      },
    ],
    validity: "3 horas",
  },

  trajetto_autorizacao_ocorrencia: {
    name: "trajetto_autorizacao_ocorrencia",
    audience: "internal",
    serves:
      "delivery-occurrence.authorization_requested (NOT_DELIVERED ou PAUSE)",
    body: "Uma ocorrência na entrega para {{1}} aguarda a sua autorização.\n\nOcorrência: {{2}}\nSolicitante: {{3}}\nRespostas do formulário: {{4}}\nRelato: {{5}}\n\nResponda pela torre de controle do Trajetto.",
    variables: [
      RECIPIENT,
      {
        meaning: "Tipo de ocorrência que pede autorização",
        max: 100,
        fallback: NOT_INFORMED_F,
        sample: "Recusa no recebimento",
      },
      REQUESTER("João Pereira (motorista)"),
      ANSWERS(
        "Ligou para o cliente: Sim; Motivo da recusa: Mercadoria avariada",
      ),
      ONE_LINE_REPORT(
        "Duas caixas chegaram amassadas e o cliente recusou o pedido inteiro.",
      ),
    ],
    validity: "15 minutos (ou 10, se a lista da Meta não tiver 15)",
  },

  trajetto_autorizacao_entrega: {
    name: "trajetto_autorizacao_entrega",
    audience: "internal",
    serves: "delivery-occurrence.authorization_requested (DELIVERED)",
    body: "A entrega para {{1}} aguarda a sua autorização para ser registrada como Entregue.\n\nTipo de entrega: {{2}}\nSolicitante: {{3}}\nRespostas do formulário: {{4}}\nRelato: {{5}}\n\nResponda pela torre de controle do Trajetto.",
    variables: [
      { ...RECIPIENT, sample: "Farmácia Vida Nova" },
      {
        meaning: "Tipo de entrega (tipo de ocorrência DELIVERED)",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "Entregue a vizinho",
      },
      REQUESTER("Carlos Lima (motorista)"),
      ANSWERS(
        "Nome de quem recebeu: Ana Costa; Número da casa do vizinho: 152",
      ),
      ONE_LINE_REPORT(
        "Destinatário viajando; a vizinha autorizou o recebimento por telefone.",
      ),
    ],
    validity: "15 minutos (ou 10, se a lista da Meta não tiver 15)",
  },

  trajetto_autorizacao_sem_resposta: {
    name: "trajetto_autorizacao_sem_resposta",
    audience: "internal",
    serves: "delivery-occurrence.authorization_escalated",
    body: "O pedido de autorização na entrega para {{1}} está sem resposta há {{2}} minutos.\n\nMotivo: {{3}}\nSolicitante: {{4}}\n\nResponda pela torre de controle do Trajetto.",
    variables: [
      RECIPIENT,
      {
        meaning: "Minutos inteiros de espera quando escalou",
        max: 10,
        fallback: "mais de 10",
        sample: "12",
      },
      {
        meaning: "Tipo do pedido",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "Cliente ausente",
      },
      {
        meaning:
          'Quem pediu e a situação: " (motorista, aguardando no endereço)" quando foi o motorista',
        max: 136,
        fallback: NOT_INFORMED,
        sample: "João Pereira (motorista, aguardando no endereço)",
      },
    ],
    validity: "30 minutos",
  },

  trajetto_multa_registrada: {
    name: "trajetto_multa_registrada",
    audience: "internal",
    serves: "fine.created",
    body: "Uma nova multa de trânsito foi registrada no Trajetto para um veículo da sua empresa. Os dados do registro estão abaixo.\n\nVeículo: {{1}}\nMotorista: {{2}}\nFilial: {{3}}\nInfração: {{4}}\nData da infração: {{5}}\nLocal: {{6}}\nPontos na carteira: {{7}}\nValor: {{8}}\nVencimento: {{9}}\nObservação: {{10}}\nRegistrada por: {{11}}\n\nConfira os detalhes completos da multa na página Multas do Trajetto.",
    variables: [
      {
        meaning: "Placa do veículo multado",
        max: 20,
        fallback: NOT_INFORMED,
        sample: "RTA4F21",
      },
      {
        meaning: "Motorista vinculado à multa",
        max: 60,
        fallback: NOT_INFORMED,
        sample: "Carlos Eduardo Pereira",
      },
      {
        meaning: "Filial, pela razão social",
        max: 80,
        fallback: NOT_INFORMED_F,
        sample: "Transportes Andrade Ltda - Filial Campinas",
      },
      {
        meaning: "Código da infração e a descrição, quando houver",
        max: 120,
        fallback: NOT_INFORMED_F,
        sample:
          "745-50 – Transitar em velocidade superior à máxima permitida em até 20%",
      },
      {
        meaning: "Dia da infração no fuso da empresa",
        max: 20,
        fallback: NOT_INFORMED_F,
        sample: "14/10/2026",
      },
      {
        meaning: "Local da infração",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "Rodovia Anhanguera, km 98, sentido interior",
      },
      {
        meaning: 'Pontos na carteira (zero é "0")',
        max: 10,
        fallback: NOT_INFORMED,
        sample: "4",
      },
      {
        meaning: "Valor da multa",
        max: 30,
        fallback: NOT_INFORMED,
        sample: "R$ 130,16",
      },
      {
        meaning: "Dia do vencimento no fuso da empresa",
        max: 20,
        fallback: NOT_INFORMED,
        sample: "28/11/2026",
      },
      {
        meaning: "Observação da multa, em uma linha",
        max: 100,
        fallback: "nenhuma",
        sample: "Notificação recebida pelos Correios",
      },
      {
        meaning:
          'Quem registrou: "Nome (e-mail)", ou "Suporte Trajetto" quando foi um master',
        max: 120,
        fallback: NOT_INFORMED,
        sample: "Fernanda Lopes (fernanda.lopes@exemplo.com.br)",
      },
    ],
    validity: "12 horas",
  },

  trajetto_ordem_servico: {
    name: "trajetto_ordem_servico",
    audience: "internal",
    serves:
      "service-order.created, service-order.updated (troca de responsável)",
    body: "Uma ordem de serviço do veículo {{1}} foi atribuída a você como responsável.\n\nCódigo da OS: {{2}}\nDescrição: {{3}}\nTipo de manutenção: {{4}}\nData da ordem: {{5}}\nValor total: {{6}}\nQuilometragem: {{7}}\n\nConfira os detalhes da ordem de serviço no Trajetto.",
    variables: [
      {
        meaning: "Placa do veículo da ordem",
        max: 20,
        fallback: "sem placa cadastrada",
        sample: "RTA4F21",
      },
      {
        meaning: 'Código curto da ordem (o "OS #…" do web, sem "#")',
        max: 40,
        fallback: NOT_INFORMED,
        sample: "8f2c4a9e1b3d",
      },
      {
        meaning: "Descrição da ordem, em uma linha",
        max: 150,
        fallback: NOT_INFORMED_F,
        sample: "Troca de óleo do motor e dos filtros de ar e de combustível",
      },
      {
        meaning: "Tipo de manutenção (Interna ou Externa)",
        max: 20,
        fallback: NOT_INFORMED,
        sample: "Externa",
      },
      {
        meaning: "Data da ordem no fuso da empresa",
        max: 20,
        fallback: NOT_INFORMED_F,
        sample: "02/11/2026",
      },
      {
        meaning: "Valor total da ordem",
        max: 30,
        fallback: NOT_INFORMED,
        sample: "R$ 1.850,00",
      },
      {
        meaning: "Quilometragem na abertura e, quando houver, após o serviço",
        max: 80,
        fallback: NOT_INFORMED_F,
        sample: "152.340 km na abertura e 152.410 km após o serviço",
      },
    ],
    validity: "12 horas",
  },

  trajetto_conta_pagar: {
    name: "trajetto_conta_pagar",
    audience: "internal",
    serves:
      "account-payable.created, account-payable.updated (troca de responsável)",
    body: "Uma conta a pagar no valor de {{1}} foi atribuída a você como responsável.\n\nFavorecido: {{2}}\nVencimento: {{3}}\nCategoria: {{4}}\nDescrição: {{5}}\nOrdem de serviço vinculada: {{6}}\n\nConfira os detalhes da conta a pagar no Trajetto.",
    variables: [
      {
        meaning: "Valor da conta",
        max: 30,
        fallback: NOT_INFORMED,
        sample: "R$ 1.850,00",
      },
      {
        meaning: "Favorecido: o fornecedor ou o nome digitado",
        max: 120,
        fallback: NOT_INFORMED,
        sample: "Auto Center Rota Sul",
      },
      {
        meaning: "Dia do vencimento no fuso da empresa",
        max: 20,
        fallback: NOT_INFORMED,
        sample: "10/11/2026",
      },
      {
        meaning: 'Categoria; "Outros (descrição)" quando é OTHER',
        max: 120,
        fallback: NOT_INFORMED_F,
        sample: "Manutenção",
      },
      {
        meaning: "Descrição da conta, em uma linha",
        max: 150,
        fallback: NOT_INFORMED_F,
        sample: "Revisão dos 150 mil km do caminhão",
      },
      {
        meaning: "Ordem de serviço vinculada: código curto e placa",
        max: 80,
        fallback: "nenhuma",
        sample: "8f2c4a9e1b3d (veículo RTA4F21)",
      },
    ],
    validity: "12 horas",
  },

  trajetto_kanban_card_criado: {
    name: "trajetto_kanban_card_criado",
    audience: "internal",
    serves: "kanban-card.created",
    body: "Um novo card do kanban da sua empresa no Trajetto foi atribuído a você como responsável.\n\nCard: {{1}}\nPrioridade: {{2}}\nVencimento: {{3}}\nDescrição: {{4}}\n\nConfira os detalhes do card no kanban do Trajetto.",
    variables: KANBAN_VARIABLES({
      title: "Trocar pastilhas de freio do caminhão RKT4B21",
      priority: "🔴 Alta",
      due: "22/11/2026",
      description:
        "Levar o caminhão à oficina parceira até sexta e conferir também o nível do fluido de freio.",
    }),
    validity: "12 horas",
  },

  trajetto_kanban_card_atualizado: {
    name: "trajetto_kanban_card_atualizado",
    audience: "internal",
    serves: "kanban-card.updated (troca de responsável)",
    body: "Um card do kanban da sua empresa no Trajetto foi atualizado e passou para a sua responsabilidade.\n\nCard: {{1}}\nPrioridade: {{2}}\nVencimento: {{3}}\nDescrição: {{4}}\n\nConfira os detalhes do card no kanban do Trajetto.",
    variables: KANBAN_VARIABLES({
      title: "Revisão dos 50.000 km da van QWE2F45",
      priority: "🟡 Média",
      due: "18/11/2026",
      description:
        "Conferir o orçamento da oficina e aprovar a troca do óleo e dos filtros da van.",
    }),
    validity: "12 horas",
  },

  trajetto_modulo_plano: {
    name: "trajetto_modulo_plano",
    audience: "internal",
    serves: "business-module.changed (para os outros masters)",
    body: "Um módulo do plano de uma empresa foi alterado no Trajetto.\n\nEmpresa: {{1}}\nMódulo: {{2}}\nSituação atual: {{3}}\nAlteração feita por: {{4}}\n\nSe esta alteração não era esperada, confira imediatamente os módulos dessa empresa no Trajetto.",
    variables: [
      COMPANY,
      MODULE,
      {
        meaning: "Novo estado do módulo",
        max: 20,
        fallback: NOT_INFORMED_F,
        sample: "Desabilitado",
      },
      ACTOR('Master que fez a alteração: "Nome (e-mail)"'),
    ],
    validity: "12 horas",
  },

  trajetto_modulo_habilitado_empresa: {
    name: "trajetto_modulo_habilitado_empresa",
    audience: "internal",
    serves: "business-module.changed (administradores, módulo habilitado)",
    body: "Um módulo foi habilitado no plano da sua empresa pelo Suporte Trajetto.\n\nEmpresa: {{1}}\nMódulo: {{2}}\n\nAs telas do módulo já estão disponíveis no menu do Trajetto.",
    variables: [COMPANY, MODULE],
    validity: "12 horas",
  },

  trajetto_modulo_desabilitado_empresa: {
    name: "trajetto_modulo_desabilitado_empresa",
    audience: "internal",
    serves: "business-module.changed (administradores, módulo desabilitado)",
    body: "Um módulo foi desabilitado no plano da sua empresa pelo Suporte Trajetto.\n\nEmpresa: {{1}}\nMódulo: {{2}}\n\nAs telas do módulo saíram do menu, mas nenhum dado foi apagado: ao reabilitar o módulo, tudo volta como estava.",
    variables: [COMPANY, { ...MODULE, sample: "Gestão de Frota" }],
    validity: "12 horas",
  },

  trajetto_limite_plano: {
    name: "trajetto_limite_plano",
    audience: "internal",
    serves: "business-limit.changed (para os outros masters)",
    body: "Um limite do plano de uma empresa foi alterado no Trajetto.\n\nEmpresa: {{1}}\nTipo de limite: {{2}}\nLimite anterior: {{3}}\nNovo limite: {{4}}\nAlteração feita por: {{5}}\n\nSe esta alteração não era esperada, confira imediatamente o plano dessa empresa no Trajetto.",
    variables: [
      COMPANY,
      LIMIT_KIND,
      LIMIT_VALUE("Limite anterior, com a unidade", "20 veículos"),
      LIMIT_VALUE("Novo limite, com a unidade", "35 veículos"),
      ACTOR('Master que fez a alteração: "Nome (e-mail)"'),
    ],
    validity: "12 horas",
  },

  trajetto_limite_plano_empresa: {
    name: "trajetto_limite_plano_empresa",
    audience: "internal",
    serves: "business-limit.changed (administradores)",
    body: "Um limite do plano da sua empresa foi alterado pelo Suporte Trajetto.\n\nEmpresa: {{1}}\nTipo de limite: {{2}}\nLimite anterior: {{3}}\nNovo limite: {{4}}\n\nAcompanhe o consumo na aba Limites de Uso do Trajetto.",
    variables: [
      COMPANY,
      { ...LIMIT_KIND, sample: "Fotos da Verificação IA" },
      LIMIT_VALUE("Limite anterior, com a unidade", "500 fotos por mês"),
      LIMIT_VALUE("Novo limite, com a unidade", "1.000 fotos por mês"),
    ],
    validity: "12 horas",
  },

  trajetto_master_criado: {
    name: "trajetto_master_criado",
    audience: "internal",
    serves: "master-user.created (para quem criou)",
    body: "Você criou um novo usuário Master no Trajetto.\n\nNome: {{1}}\nE-mail: {{2}}\n\nO link para definir a senha de acesso foi enviado para esse e-mail.",
    variables: [
      {
        meaning: "Nome do novo master",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "Juliana Prado Souza",
      },
      {
        meaning: "E-mail do novo master",
        max: 254,
        fallback: NOT_INFORMED,
        sample: "juliana.prado@exemplo.com.br",
      },
    ],
    validity: "1 hora",
  },

  trajetto_master_atualizado: {
    name: "trajetto_master_atualizado",
    audience: "internal",
    serves: "master-user.updated (para quem alterou)",
    body: "Você alterou os dados de um usuário Master no Trajetto.\n\nUsuário: {{1}}\nAlterações: {{2}}\n\nConfira os dados desse usuário na lista de usuários Master do Trajetto.",
    variables: [
      {
        meaning: "Nome do master editado, como era antes",
        max: 100,
        fallback: NOT_INFORMED,
        sample: "Juliana Prado Souza",
      },
      {
        meaning: "Resumo do que mudou, em uma linha",
        max: 480,
        fallback: "dados da conta",
        sample:
          "nome: Juliana Prado → Juliana Prado Souza, e-mail: juliana.prado@exemplo.com.br → juliana.souza@exemplo.com.br",
      },
    ],
    validity: "1 hora",
  },

  trajetto_conta_master_atualizada: {
    name: "trajetto_conta_master_atualizada",
    audience: "internal",
    serves: "master-user.account-updated (para o master cuja conta mudou)",
    body: "Sua conta Master no Trajetto foi alterada.\n\nAlterações: {{1}}\nAlteração feita por: {{2}}\n\nSe você não reconhece esta alteração, avise a equipe do Trajetto imediatamente para proteger sua conta.",
    variables: [
      {
        meaning: "Resumo do que mudou na conta, em uma linha",
        max: 480,
        fallback: "dados da conta",
        sample:
          "e-mail: juliana.prado@exemplo.com.br → juliana.souza@exemplo.com.br, link de redefinição de senha enviado",
      },
      ACTOR('Master que fez a alteração: "Nome (e-mail)"'),
    ],
    validity: "12 horas",
  },
} as const satisfies Record<string, WhatsAppTemplateDefinition>;

type InternalWhatsAppTemplateName = keyof typeof INTERNAL_WHATSAPP_TEMPLATES;

/**
 * What an internal render returns: which template, and its parameters in
 * order ({{1}}, {{2}}…), raw. The registry fits them (fitTemplateParameters)
 * just before the send, so a render states facts and never formats for Meta.
 */
interface RenderedWhatsApp {
  template: InternalWhatsAppTemplateName;
  parameters: ReadonlyArray<string | number | null | undefined>;
}

/** The fixed text of a body: what counts toward 1024 besides the values. */
function fixedTextLength(definition: WhatsAppTemplateDefinition): number {
  return definition.body.replace(/\{\{\d+\}\}/g, "").length;
}

/** How many distinct {{n}} the body carries. */
function bodyVariableCount(body: string): number {
  return new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
}

/**
 * A render that does not match its template: a bug in the code, not in the
 * message. Sending it would be Meta's 132000 on every attempt.
 */
class WhatsAppTemplateMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppTemplateMismatchError";
  }
}

/**
 * Meta refuses a parameter with a newline, a tab or four spaces in a row, so
 * every value goes on one line; cut to the variable's limit with "…"; and an
 * empty result becomes the variable's fallback — in that order, so a value
 * made only of blanks still says something.
 */
function fitParameter(
  value: string | number | null | undefined,
  variable: WhatsAppTemplateVariable,
): string {
  const flattened =
    value === null || value === undefined
      ? ""
      : String(value).replace(/\s+/g, " ").trim();

  if (flattened.length === 0) return variable.fallback;

  if (flattened.length <= variable.max) return flattened;

  return `${flattened.slice(0, Math.max(1, variable.max - 1)).trimEnd()}…`;
}

/**
 * The parameters as they leave: fitted one by one, then the body as a whole
 * held under Meta's 1024 by cutting the longest value until it fits.
 */
function fitTemplateParameters(
  definition: WhatsAppTemplateDefinition,
  raw: ReadonlyArray<string | number | null | undefined>,
): string[] {
  if (raw.length !== definition.variables.length) {
    throw new WhatsAppTemplateMismatchError(
      `Template ${definition.name} takes ${definition.variables.length} parameters; the render gave ${raw.length}`,
    );
  }

  const parameters = raw.map((value, index) =>
    fitParameter(value, definition.variables[index]),
  );

  const fixed = fixedTextLength(definition);

  let total = fixed + parameters.reduce((sum, p) => sum + p.length, 0);

  while (total > WHATSAPP_BODY_LIMIT) {
    let longest = 0;

    parameters.forEach((parameter, index) => {
      if (parameter.length > parameters[longest].length) longest = index;
    });

    const current = parameters[longest];
    const excess = total - WHATSAPP_BODY_LIMIT;
    const keep = Math.max(1, current.length - excess - 1);

    // Nothing left to cut: the fixed text alone exceeds the limit, which the
    // registry test rules out.
    if (keep >= current.length) break;

    parameters[longest] = `${current.slice(0, keep).trimEnd()}…`;
    total = fixed + parameters.reduce((sum, p) => sum + p.length, 0);
  }

  return parameters;
}

/** Which template a rendered internal notice names, fitted for the send. */
function prepareInternalWhatsApp(rendered: RenderedWhatsApp): {
  name: string;
  parameters: string[];
} {
  const definition: WhatsAppTemplateDefinition | undefined =
    INTERNAL_WHATSAPP_TEMPLATES[rendered.template];

  if (!definition) {
    throw new WhatsAppTemplateMismatchError(
      `Unknown WhatsApp template ${String(rendered.template)}`,
    );
  }

  return {
    name: definition.name,
    parameters: fitTemplateParameters(definition, rendered.parameters),
  };
}

/** The body with each {{n}} replaced, e.g. by the samples (documentation). */
function fillTemplateBody(body: string, values: ReadonlyArray<string>): string {
  return body.replace(
    /\{\{(\d+)\}\}/g,
    (match, index: string) => values[Number(index) - 1] ?? match,
  );
}

export {
  INTERNAL_WHATSAPP_TEMPLATES,
  WHATSAPP_BODY_LIMIT,
  WhatsAppTemplateMismatchError,
  bodyVariableCount,
  fillTemplateBody,
  fitParameter,
  fitTemplateParameters,
  fixedTextLength,
  prepareInternalWhatsApp,
};

export type {
  InternalWhatsAppTemplateName,
  RenderedWhatsApp,
  WhatsAppTemplateButton,
  WhatsAppTemplateDefinition,
  WhatsAppTemplateVariable,
};

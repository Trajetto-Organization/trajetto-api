/**
 * docs/whatsapp-modelos.md, from the WhatsApp template registries (plan of
 * 02/11/2026, B7): the exact copy the owner pastes into Meta — each body,
 * limit, default and sample as the code sends and measures them.
 *
 * Pure apart from prettier: renderWhatsAppTemplatesDoc() builds the markdown,
 * formatWhatsAppTemplatesDoc() gives it the repository's prettier style (the
 * CI checks every markdown file). `yarn docs:whatsapp`
 * (scripts/generate-whatsapp-docs.ts) writes the file, and
 * tests/unitaires/notifications/whatsapp-templates-doc.test.ts fails when
 * the file and the registries drift.
 */
import { resolve } from "node:path";

import * as prettier from "prettier";

import { CUSTOMER_WHATSAPP_TEMPLATES } from "@/shared/delivery/customer-whatsapp-templates";
import {
  INTERNAL_WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from "@/shared/notifications/whatsapp-templates";

const WHATSAPP_TEMPLATES_DOC_PATH = "docs/whatsapp-modelos.md";

type TemplateDoc = Pick<
  WhatsAppTemplateDefinition,
  "name" | "serves" | "body" | "variables" | "buttons" | "validity"
>;

/** A table cell: a pipe would split it. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function section(template: TemplateDoc): string {
  const lines: string[] = [];
  const buttons = template.buttons;

  lines.push(`### \`${template.name}\``, "");
  lines.push(`- **Evento:** ${template.serves}`);
  lines.push(`- **Validade:** ${template.validity}`);
  lines.push(
    `- **Variáveis:** ${template.variables.length}${
      buttons ? ` · **Botões de URL:** ${buttons.length}` : ""
    }`,
    "",
  );
  lines.push("Corpo (copie exatamente, com as linhas em branco):", "");
  lines.push("```text", template.body, "```", "");
  lines.push(
    "| Variável | O que leva | Limite | Valor padrão | Amostra |",
    "|---|---|---|---|---|",
  );

  template.variables.forEach((variable, index) => {
    lines.push(
      `| \`{{${index + 1}}}\` | ${cell(variable.meaning)} | ${variable.max} | ${cell(variable.fallback)} | ${cell(variable.sample)} |`,
    );
  });

  if (buttons) {
    lines.push(
      "",
      "| Botão (URL) | Texto | URL na Meta | Amostra do sufixo |",
      "|---|---|---|---|",
    );

    buttons.forEach((button, index) => {
      lines.push(
        `| ${index} | ${button.text} | \`https://<host da web>/${button.path}\` | \`${button.sample}\` |`,
      );
    });
  }

  lines.push("");

  return lines.join("\n");
}

/** The markdown, before prettier. */
function renderWhatsAppTemplatesDoc(): string {
  const internal = Object.values(INTERNAL_WHATSAPP_TEMPLATES) as TemplateDoc[];
  const customer = Object.values(CUSTOMER_WHATSAPP_TEMPLATES) as TemplateDoc[];
  const total = internal.length + customer.length;

  return [
    "# Modelos de WhatsApp (Meta)",
    "",
    `> Gerado a partir do código por \`yarn docs:whatsapp\` (\`scripts/generate-whatsapp-docs.ts\`): \`src/shared/notifications/whatsapp-templates.ts\` (${internal.length} internos) e \`src/shared/delivery/customer-whatsapp-templates.ts\` (${customer.length} ao cliente). Plano de 02/11/2026, itens B1, B2, B7 e B8. Mudou um modelo no código? Rode \`yarn docs:whatsapp\` (o \`whatsapp-templates-doc.test.ts\` falha enquanto este arquivo e o código divergirem) e reenvie o modelo para revisão na Meta **antes** de publicar o código.`,
    "",
    "## Como criar na Meta (igual para todos)",
    "",
    "WhatsApp Manager > Modelos de mensagem > Criar modelo:",
    "",
    "- **Categoria:** Utilidade. **Idioma:** Português (BR). **Tipo de variável:** Número.",
    "- **Nome:** exatamente o do título de cada modelo.",
    `- **Cabeçalho e rodapé:** nenhum. **Botões:** nenhum nos ${internal.length} internos; nos ${customer.length} ao cliente, dois botões de URL (abaixo).`,
    "- **Corpo:** copie o bloco exatamente, com as quebras e as linhas em branco, sem negrito e sem emoji no texto fixo.",
    "- **Amostras:** preencha cada `{{n}}` com a coluna Amostra.",
    "- **Período de validade da mensagem:** ative e escolha o valor indicado. Se a lista da Meta não tiver o valor exato, escolha o mais próximo abaixo.",
    `- **Botões de URL (só os ${customer.length} ao cliente):** tipo URL dinâmica, com a origem da web do ambiente (\`https://staging.intrajetto.com\` no staging, \`https://www.intrajetto.com\` na produção) seguida do caminho da tabela. A única variável é o fim da URL: o token de acompanhamento (64 caracteres hexadecimais). "Parar de receber" abre a rota curta \`/parar/<token>\` da web (item B5).`,
    "",
    'Todos os corpos começam e terminam com texto fixo, nunca têm duas variáveis seguidas e ficam abaixo de 1024 caracteres no pior caso (o código corta cada valor no limite da tabela, com "…", e nunca envia um valor vazio: vai o valor padrão). `tests/unitaires/notifications/whatsapp-templates.test.ts` confere essas regras.',
    "",
    "## O que o código faz quando um modelo falta ou não foi aprovado",
    "",
    "- O envio daquele modelo falha sem nova tentativa (erro da Meta 132000, 132001 ou 132012), com uma linha de erro no log que nomeia o modelo. Os outros modelos continuam saindo.",
    "- Uma pausa da Meta (132015) segura só aquele modelo e tenta de novo depois (`template-lane.ts`).",
    `- O \`/health/providers\` lista os ${total} modelos com o estado de cada um (\`template:<nome>\`) e acusa como problema: modelo inexistente, não aprovado, fora de pt_BR, na categoria MARKETING, com outra quantidade de variáveis ou, nos ${customer.length} ao cliente, sem os dois botões de URL terminados em \`{{1}}\`.`,
    `- O webhook \`template_category_update\` (assine no app da Meta) registra um erro no log quando um dos ${total} sai de UTILITY, no aviso de 24 h antes e na mudança.`,
    "",
    `## Os ${internal.length} modelos internos`,
    "",
    ...internal.map(section),
    `## Os ${customer.length} modelos ao cliente final`,
    "",
    "Um por momento. A mensagem sai **uma por parada**, não por NF-e (item B6): a referência lista as NF-e da parada.",
    "",
    ...customer.map(section),
    "## Depois do rollout",
    "",
    "`trajetto_notification` (o modelo genérico, classificado como Marketing) não é mais usado pelo código. Exclua-o na Meta **só depois** de alguns dias sem uso. As variáveis `META_WHATSAPP_TEMPLATE_NAME` e `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME` não são mais lidas e saem do código depois do rollout.",
    "",
  ].join("\n");
}

/** The markdown in the repository's prettier style, as the CI checks it. */
async function formatWhatsAppTemplatesDoc(markdown: string): Promise<string> {
  const filepath = resolve(process.cwd(), WHATSAPP_TEMPLATES_DOC_PATH);
  const options = (await prettier.resolveConfig(filepath)) ?? {};

  return prettier.format(markdown, { ...options, filepath });
}

export {
  WHATSAPP_TEMPLATES_DOC_PATH,
  formatWhatsAppTemplatesDoc,
  renderWhatsAppTemplatesDoc,
};

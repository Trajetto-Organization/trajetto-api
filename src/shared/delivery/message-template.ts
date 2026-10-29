import Handlebars from "handlebars";

/**
 * What a company says to the person waiting for a delivery.
 *
 * The voice is theirs. A carrier that addresses "prezado cliente" and one that
 * writes under the shipper's brand are both right, and a single hard-coded
 * sentence would make Trajetto speak over them to their own customers.
 *
 * Rendered with the same Handlebars the transactional mails already use, over
 * a CLOSED variable set. Closed on purpose: the templates are edited in a
 * form by a dispatcher, and a template language with access to the whole
 * payload would let a typo print an internal id — or let somebody curious
 * print the driver's phone into a message that goes to a customer.
 */
interface DeliveryMessageVariables {
  /** The person the carrier is writing to. */
  destinatario: string;

  /** The carrier's own name, as they want to be called. */
  transportadora: string;

  /** The load, by whichever reference the company uses. */
  nota: string;
  pedido: string;

  cidade: string;
  uf: string;

  /** Already formatted for a reader, never an ISO string. */
  previsao: string;
  data_entrega: string;

  recebido_por: string;

  /** The tracking page. Always present — it is the point of the message. */
  link: string;

  /** One click to stop. Required in every channel that allows a link. */
  link_descadastro: string;
}

/** Every name a template may use, for the editor to show and validate. */
const TEMPLATE_VARIABLES: Array<keyof DeliveryMessageVariables> = [
  "destinatario",
  "transportadora",
  "nota",
  "pedido",
  "cidade",
  "uf",
  "previsao",
  "data_entrega",
  "recebido_por",
  "link",
  "link_descadastro",
];

type MessageTemplateErrorCode =
  | "INVALID_TEMPLATE_SYNTAX"
  | "UNSUPPORTED_TEMPLATE_SYNTAX"
  | "UNKNOWN_TEMPLATE_VARIABLE";

/**
 * A template outside the language we publish: it does not parse, or it uses
 * Handlebars features the editor never offered, or a name we do not provide.
 *
 * A distinct class so the notification pipeline can tell it apart from a
 * provider outage: retrying a template that cannot render only repeats the
 * failure, five times, while the customer hears nothing.
 */
class InvalidMessageTemplateError extends Error {
  constructor(
    message: string,
    readonly code: MessageTemplateErrorCode,

    /** Where the parser stopped, when it said; for the editor's message. */
    readonly line?: number,
  ) {
    super(message);
    this.name = "InvalidMessageTemplateError";
  }
}

interface TemplateInspection {
  /** Every variable the template prints, known or not, in order of use. */
  used: string[];

  /** Printed names we do not publish (`{{motorista}}`). */
  unknown: string[];

  /**
   * Handlebars features outside the published language, as short labels
   * (`{{#if}}`, `{{> cabecalho}}`, `{{log}}`). Never the arguments: those are
   * the tenant's text and have no place in an error message or a log.
   */
  unsupported: string[];
}

// Handlebars AST nodes, narrowed to the fields read below. Typed locally
// because the package's `hbs.AST` namespace is not exported in a way every
// consumer resolves, and only these few fields matter.
interface TemplateNode {
  type: string;
  path?: {
    type: string;
    original?: unknown;
    parts?: string[];
    depth?: number;
    data?: boolean;
  };
  name?: { original?: unknown };
  params?: unknown[];
  hash?: unknown;
}

const MAX_LABEL_LENGTH = 40;

function labelOf(node: TemplateNode): string {
  const name = String(node.path?.original ?? node.name?.original ?? "…").slice(
    0,
    MAX_LABEL_LENGTH,
  );

  switch (node.type) {
    case "BlockStatement":
      return `{{#${name}}}`;
    case "PartialStatement":
    case "PartialBlockStatement":
      return `{{> ${name}}}`;
    case "Decorator":
    case "DecoratorBlock":
      return `{{* ${name}}}`;
    default:
      return `{{${name}}}`;
  }
}

/**
 * The single variable a mustache prints, or null when it does anything else.
 *
 * Only the plain form is the published language: one bare name, no `this.`,
 * no `./`, no `@data`, no nested path, no arguments and no hash. Every one of
 * those is a way to reach something other than the closed variable set, or
 * to call a helper (`{{log "…" level="error"}}` is a mustache too).
 */
function plainVariableOf(node: TemplateNode): string | null {
  const { path } = node;

  if (!path || path.type !== "PathExpression") return null;
  if (path.data || path.depth !== 0) return null;
  if (!path.parts || path.parts.length !== 1) return null;
  if (path.original !== path.parts[0]) return null;
  if ((node.params?.length ?? 0) > 0 || node.hash) return null;

  return path.parts[0];
}

function parseLineOf(error: unknown): number | undefined {
  const candidate = error as { lineNumber?: unknown; message?: unknown };

  if (typeof candidate?.lineNumber === "number") return candidate.lineNumber;

  const match = /line (\d+)/.exec(String(candidate?.message ?? ""));

  return match ? Number(match[1]) : undefined;
}

/**
 * Parses a template and sorts what it uses into the published language and
 * the rest. Throws `InvalidMessageTemplateError` when it does not parse.
 *
 * The walk is over the top level only, and that is enough: text, comments
 * and plain mustaches have no children, and every node that does (blocks,
 * partial blocks, decorator blocks) is itself refused.
 */
function inspectTemplate(template: string): TemplateInspection {
  let program: { body: TemplateNode[] };

  try {
    program = Handlebars.parse(template) as unknown as { body: TemplateNode[] };
  } catch (error) {
    const firstLine = String(
      error instanceof Error ? error.message : error,
    ).split("\n")[0];

    throw new InvalidMessageTemplateError(
      `Template does not parse: ${firstLine}`,
      "INVALID_TEMPLATE_SYNTAX",
      parseLineOf(error),
    );
  }

  const known = new Set<string>(TEMPLATE_VARIABLES as string[]);

  const used: string[] = [];
  const unsupported = new Set<string>();

  for (const node of program.body) {
    if (node.type === "ContentStatement" || node.type === "CommentStatement") {
      continue;
    }

    const variable =
      node.type === "MustacheStatement" ? plainVariableOf(node) : null;

    if (variable === null) {
      unsupported.add(labelOf(node));
      continue;
    }

    used.push(variable);
  }

  return {
    used,
    unknown: [...new Set(used.filter((name) => !known.has(name)))],
    unsupported: [...unsupported],
  };
}

/**
 * The same verdict as the save, for code that only needs a yes or a throw:
 * a template that parses, uses only the plain form, and only names we publish.
 */
function assertRenderableTemplate(template: string): TemplateInspection {
  const inspection = inspectTemplate(template);

  if (inspection.unsupported.length > 0) {
    throw new InvalidMessageTemplateError(
      `Template uses unsupported syntax: ${inspection.unsupported.join(", ")}`,
      "UNSUPPORTED_TEMPLATE_SYNTAX",
    );
  }

  if (inspection.unknown.length > 0) {
    throw new InvalidMessageTemplateError(
      `Template uses unknown variables: ${inspection.unknown
        .map((name) => `{{${name}}}`)
        .join(", ")}`,
      "UNKNOWN_TEMPLATE_VARIABLE",
    );
  }

  return inspection;
}

/**
 * An environment of its own, so a partial or helper registered on the global
 * Handlebars (the transactional mails share it) can never be reached from a
 * tenant's text. The AST check above is what actually closes the language;
 * this keeps the two worlds from sharing state.
 */
const sandbox = Handlebars.create();

/**
 * Compiled with escaping OFF, and that is a deliberate, bounded decision.
 *
 * These messages are plain text — WhatsApp and the body of an e-mail — and
 * HTML-escaping them turns every "Café & Cia" into "Café &amp; Cia" in a
 * customer's message. The values are never interpolated into markup: the mail
 * template puts the rendered body into a text node, and WhatsApp has no markup
 * at all. If a channel that renders HTML is ever added, it escapes at ITS
 * boundary, which is where escaping belongs.
 *
 * The template is checked again here, not only at save time: a row written
 * before the save validated anything, or by a path that skips the use case,
 * must fail as a template error — which the pipeline does not retry — and
 * never run a helper such as `{{log}}`.
 */
function renderDeliveryMessage(
  template: string,
  variables: DeliveryMessageVariables,
): string {
  assertRenderableTemplate(template);

  try {
    const compiled = sandbox.compile(template, {
      noEscape: true,
      knownHelpersOnly: true,
    });

    return compiled(variables).trim();
  } catch (error) {
    throw new InvalidMessageTemplateError(
      `Template could not be rendered: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
      "INVALID_TEMPLATE_SYNTAX",
    );
  }
}

/**
 * Whether a template only uses names we publish.
 *
 * Checked when the company SAVES it, not when it sends: a dispatcher who typed
 * `{{motorista}}` must find out in the form, not by a customer receiving a
 * message with a blank in it. Throws `InvalidMessageTemplateError` when the
 * template does not parse at all.
 */
function unknownTemplateVariables(template: string): string[] {
  return inspectTemplate(template).unknown;
}

export {
  TEMPLATE_VARIABLES,
  InvalidMessageTemplateError,
  assertRenderableTemplate,
  inspectTemplate,
  renderDeliveryMessage,
  unknownTemplateVariables,
};
export type {
  DeliveryMessageVariables,
  MessageTemplateErrorCode,
  TemplateInspection,
};

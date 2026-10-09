import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The sections of the internal reference (/docs), in pt-BR (decision 11.4).
 *
 * Routes name their tag; the transform turns a camelCase name into kebab-case
 * (`fuelType` → `fuel-type`), so the 39 sections read one way however each
 * route file spells it. Every tag a route uses must be listed here — the
 * contract test refuses an operation in a section nobody described.
 */
interface ApiTag {
  name: string;
  description: string;
}

const TAG_GROUPS: ReadonlyArray<{ name: string; tags: ApiTag[] }> = [
  {
    name: "Frota",
    tags: [
      { name: "vehicle", description: "Veículos: cadastro, quilometragem, situação e exportação." },
      { name: "vehicle-type", description: "Tipos de veículo da empresa." },
      { name: "driver", description: "Motoristas: cadastro, CNH, vínculo com usuário e exportação." },
      { name: "fuel", description: "Abastecimentos: registro pelo app e pelo painel, histórico por veículo e exportação." },
      { name: "fuel-type", description: "Tipos de combustível da empresa." },
      { name: "vehicle-checklist", description: "Checklists de inspeção de veículos, com fotos." },
      { name: "service-order", description: "Ordens de serviço de manutenção." },
      { name: "service-order-part", description: "Peças lançadas numa ordem de serviço." },
      { name: "part", description: "Catálogo de peças." },
      { name: "supplier", description: "Fornecedores (oficinas, postos, autopeças)." },
      { name: "fine", description: "Multas de trânsito." },
      { name: "traffic-violation-code", description: "Tabela de códigos de infração do CTB." },
      { name: "account-payable", description: "Contas a pagar da frota." },
      { name: "kanban", description: "Quadro kanban da manutenção." },
    ],
  },
  {
    name: "Entregas",
    tags: [
      { name: "delivery", description: "Entregas: cadastro, importação de NF-e, ocorrências, comprovantes e torre de controle." },
      { name: "route", description: "Rotas: montagem, atribuição ao motorista, paradas e acompanhamento." },
      { name: "driver-pause", description: "Pausas do motorista durante a rota." },
      { name: "shipper", description: "Embarcadores (clientes da transportadora)." },
      { name: "occurrence-type", description: "Tipos de ocorrência e seus formulários." },
      { name: "status-change-reason", description: "Motivos de mudança de status." },
      { name: "import", description: "Importações em lote (planilhas e XMLs) e o andamento delas." },
      { name: "chat", description: "Chat com os motoristas e atendimentos (tickets) da torre." },
      { name: "integration", description: "API pública de integração, autenticada por chave de API." },
      { name: "integration-admin", description: "Gestão das chaves de API e dos webhooks da empresa." },
    ],
  },
  {
    name: "Administração",
    tags: [
      { name: "business", description: "Empresas (tenants): cadastro, plano, módulos, limites e exclusão." },
      { name: "branch", description: "Filiais da empresa." },
      { name: "user", description: "Usuários, sessão, senha e autenticação em dois fatores." },
      { name: "profile-access", description: "Perfis de acesso." },
      { name: "permission", description: "Permissões de leitura e escrita de cada perfil." },
      { name: "activity", description: "Registro de atividades (auditoria) da empresa." },
      { name: "dashboard", description: "Indicadores do painel." },
      { name: "quote", description: "Pedidos de orçamento vindos do site." },
    ],
  },
  {
    name: "Plataforma",
    tags: [
      { name: "notification", description: "Notificações no app e no painel, preferências e tokens de push." },
      { name: "whatsapp", description: "Preferências de aviso por WhatsApp." },
      { name: "upload", description: "URLs assinadas para enviar arquivos direto ao armazenamento." },
      { name: "ai-analysis", description: "Verificação por IA de fotos e documentos." },
      { name: "public", description: "Rotas abertas, sem sessão (rastreio e formulários do site)." },
      { name: "diagnostics", description: "Diagnóstico enviado pelos clientes." },
      { name: "health", description: "Saúde e prontidão do serviço." },
    ],
  },
];

const API_TAGS: ApiTag[] = TAG_GROUPS.flatMap((group) => group.tags);

/** `x-tagGroups`: how renderers group the sections in their side menu. */
const API_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));

/** `fuelType` → `fuel-type`; a kebab-case name is returned as it is. */
function normalizeTagName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The version of the reference: the API package's own, read at boot. `1.0.0`
 * typed into http.ts never moved with a release. From the working directory,
 * not `__dirname`: the build bundles this file into build/server.js, and the
 * image runs from /app, where package.json is copied.
 */
function apiVersion(packageJsonPath = path.join(process.cwd(), "package.json")): string {
  try {
    const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };

    return typeof version === "string" && version.length > 0 ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const API_INFO_DESCRIPTION = [
  "Referência interna da API do Trajetto: frota, entregas e administração.",
  "",
  "Toda recusa sai no mesmo formato — `{ code, message }`, com `issues` (uma frase por campo) no 400 `VALIDATION_ERROR` — e o `code` também vem no cabeçalho `x-error-code`. Não encontrado é 404 (o registro de outra empresa recebe a mesma resposta); conflito com o estado atual é 409. Um 500 traz `requestId`; um 503 traz `retry-after`.",
  "",
  "A API de integração, autenticada por chave, tem a sua própria referência em `/integration/docs`.",
].join("\n");

export {
  API_INFO_DESCRIPTION,
  API_TAG_GROUPS,
  API_TAGS,
  apiVersion,
  normalizeTagName,
};

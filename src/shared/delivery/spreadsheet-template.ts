/**
 * The spreadsheet a company fills in to load a day's work without an
 * integration.
 *
 * One row per document. That is the whole shape, and it is deliberate: the
 * people filling this in are dispatchers with a spreadsheet, not developers
 * with a schema, and every structure beyond "one line, one delivery" — nested
 * sheets, repeated blocks, a header row that means something different from
 * the others — is a structure somebody gets wrong at 6am.
 *
 * Columns are named in Portuguese because the person typing reads Portuguese.
 * Matching is forgiving on purpose (see `normalizeHeader`): an operator who
 * types "Destinatário" or "destinatario" or "DESTINATARIO " has not made a
 * mistake, and refusing them would be refusing the format we published.
 */
interface TemplateColumn {
  /** The key the parser produces. */
  key: string;

  /** What the header says in the file we publish. */
  header: string;

  required?: boolean;

  /** Other spellings we accept, beyond the normalisation below. */
  aliases?: string[];

  /** Shown in the template's second row, as a worked example. */
  example?: string;

  /** Shown as a cell note in the published template. */
  help?: string;
}

const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    key: "tipo",
    header: "Tipo",
    aliases: ["tipo de registro", "entrega ou coleta"],
    example: "entrega",
    help: 'Deixe em branco para "entrega". Use "ordem de serviço" para um serviço no endereço (ex.: recolher cestos retornáveis) ou "coleta" para buscar carga.',
  },

  {
    key: "recipient_name",
    header: "Destinatário",
    required: true,
    aliases: ["cliente", "nome do destinatario", "razao social"],
    example: "Padaria Central Ltda",
  },
  {
    key: "recipient_document",
    header: "Documento",
    aliases: ["cpf", "cnpj", "cpf/cnpj", "documento do destinatario"],
    example: "11222333000181",
    help: "CPF (11 dígitos) ou CNPJ (14). Pontuação é ignorada.",
  },
  {
    key: "recipient_telephone",
    header: "Telefone",
    aliases: ["celular", "fone", "telefone do destinatario"],
    example: "11999999999",
  },
  {
    key: "recipient_email",
    header: "E-mail",
    aliases: ["email", "email do destinatario"],
  },

  {
    key: "cep",
    header: "CEP",
    required: true,
    example: "01001000",
    help: "8 dígitos. Pontuação é ignorada.",
  },
  {
    key: "city",
    header: "Cidade",
    required: true,
    aliases: ["municipio"],
    example: "São Paulo",
  },
  {
    key: "uf",
    header: "UF",
    required: true,
    aliases: ["estado"],
    example: "SP",
  },
  {
    key: "street",
    header: "Logradouro",
    required: true,
    aliases: ["endereco", "rua"],
    example: "Praça da Sé",
  },
  {
    key: "address_number",
    header: "Número",
    aliases: ["numero", "nro", "num"],
    example: "100",
  },
  {
    key: "complement",
    header: "Complemento",
    aliases: ["compl"],
  },
  {
    key: "neighborhood",
    header: "Bairro",
    example: "Sé",
  },

  {
    key: "invoice_key",
    header: "Chave da NF-e",
    aliases: ["chave nfe", "chave de acesso", "chave"],
    help: "44 dígitos. Quando presente, é ela que impede importar a mesma nota duas vezes.",
  },
  {
    key: "invoice_number",
    header: "Número da NF",
    aliases: ["nf", "nota fiscal", "numero da nota"],
    example: "12345",
  },
  {
    key: "code",
    header: "Pedido",
    aliases: ["codigo", "codigo do pedido", "numero do pedido", "op"],
    example: "PED-4471",
    help: "Sem a chave da NF-e, é o pedido (junto com o embarcador) que impede a duplicata.",
  },

  {
    key: "scheduled_date",
    header: "Data prevista",
    aliases: ["data", "previsao", "data de entrega"],
    example: "16/09/2026",
    help: "Aceita 16/09/2026 e 2026-09-16.",
  },
  {
    key: "notes",
    header: "Observações",
    aliases: ["observacao", "obs"],
  },

  {
    key: "item_description",
    header: "Item",
    aliases: ["descricao do item", "produto"],
    help: "Um item por linha. Cargas com muitos itens entram pelo XML da NF-e.",
  },
  {
    key: "item_quantity",
    header: "Quantidade",
    aliases: ["qtd", "qtde"],
    example: "2",
  },
  {
    key: "item_unit",
    header: "Unidade",
    aliases: ["un", "und"],
    example: "CX",
  },
  {
    key: "item_unit_value",
    header: "Valor unitário",
    aliases: ["valor", "preco unitario"],
    example: "45,90",
    help: "Vírgula é o decimal.",
  },

  {
    key: "route_name",
    header: "Rota",
    aliases: ["nome da rota"],
    example: "Zona Sul — manhã",
    help: "Preencher as colunas de rota cria a rota e põe esta linha nela, na ordem da planilha.",
  },
  {
    key: "route_date",
    header: "Data da rota",
    aliases: ["data rota"],
    example: "16/09/2026",
  },
  {
    key: "route_driver_cnh",
    header: "CNH do motorista",
    aliases: ["cnh", "motorista"],
    example: "01234567890",
    help: "A CNH identifica o motorista sem que a planilha precise conhecer ids.",
  },
  {
    key: "route_vehicle_plate",
    header: "Placa do veículo",
    aliases: ["placa", "veiculo"],
    example: "ABC1D23",
  },
];

/**
 * Makes two spellings of the same header comparable.
 *
 * Accents, case, surrounding spaces, double spaces and underscores all vanish.
 * A dispatcher who typed "Nº da NF" and one who typed "numero_da_nf" meant the
 * same column, and a format that only accepts one of them is a format that
 * generates support tickets instead of deliveries.
 *
 * The asterisk goes too, and that one is not a courtesy: the template we
 * publish marks its required columns "Destinatário *", so a file filled in
 * from our own model comes back with asterisks in the header row. Without
 * this the four columns that matter most would arrive unrecognised and every
 * row would fail as incomplete — the format refusing the exact file it told
 * people to use.
 */
function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_.*]/g, " ")
    .replace(/[º°]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every accepted spelling of every column, pointing at its key. */
const HEADER_LOOKUP: Map<string, string> = (() => {
  const lookup = new Map<string, string>();

  for (const column of TEMPLATE_COLUMNS) {
    lookup.set(normalizeHeader(column.header), column.key);

    for (const alias of column.aliases ?? []) {
      lookup.set(normalizeHeader(alias), column.key);
    }

    // The key itself, so a file exported by our own API round-trips.
    lookup.set(normalizeHeader(column.key), column.key);
  }

  return lookup;
})();

const REQUIRED_KEYS = TEMPLATE_COLUMNS.filter((column) => column.required).map(
  (column) => column.key,
);

export { HEADER_LOOKUP, REQUIRED_KEYS, TEMPLATE_COLUMNS, normalizeHeader };
export type { TemplateColumn };

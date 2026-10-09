/**
 * The request bodies the public reference publishes, by operationId.
 *
 * The zod converter publishes no request example, and a renderer left without
 * one invents a body from the schema. It cannot know what the schema does not
 * say — one shipper field and not both, a CNPJ with valid check digits — so
 * the web portal showed a curl the API refused with nine issues. Each write
 * carries a real body here instead: the E2E suite posts it with a real key
 * and expects 201, and the unit suite validates it against the published JSON
 * Schema, as a generated client would.
 *
 * Unmasked CEP and CNPJ: the published schema describes the cleaned value
 * (`^\d{8}$`, 14 characters). The API also accepts masks, but an example a
 * strict client refuses is not an example.
 */
const CREATE_DELIVERY_REQUEST_BODY = {
  shipper_cnpj: "12345678000195",
  code: "PED-10452",
  invoice_key: "35260912345678000195550010000104521000104529",
  invoice_number: "10452",
  recipient_name: "Mercado Bom Preço Ltda",
  recipient_document: "12345678000190",
  cep: "13010000",
  street: "Rua das Flores",
  address_number: "120",
  neighborhood: "Centro",
  city: "Campinas",
  uf: "SP",
  scheduled_date: "2026-09-24",
  items: [{ description: "Caixa de óleo 900 ml", quantity: 12, unit: "CX" }],
};

const PUBLIC_REQUEST_EXAMPLES: Readonly<Record<string, unknown>> = {
  createDelivery: CREATE_DELIVERY_REQUEST_BODY,
};

export { CREATE_DELIVERY_REQUEST_BODY, PUBLIC_REQUEST_EXAMPLES };

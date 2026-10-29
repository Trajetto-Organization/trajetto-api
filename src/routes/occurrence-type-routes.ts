import { FastifyInstance } from "fastify";

import { CreateOccurrenceTypeController } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-controller";
import { ListOccurrenceTypeController } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-controller";

import { UpdateOccurrenceTypeController } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-controller";
import { DeleteOccurrenceTypeController } from "@/modules/occurrence-type/usecases/delete-occurrence-type/delete-occurrence-type-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  occurrenceTypeSchemas,
  occurrenceTypeResponses,
} from "./documentation/occurrence-type-documentation";
import { itemOf, ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { errorResponse } from "./documentation/common-responses";
import { occurrenceTypeListSearchMetaDoc } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-documentation";

const createOccurrenceTypeController = new CreateOccurrenceTypeController();
const listOccurrenceTypeController = new ListOccurrenceTypeController();

const updateOccurrenceTypeController = new UpdateOccurrenceTypeController();
const deleteOccurrenceTypeController = new DeleteOccurrenceTypeController();

const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function occurrenceTypeRoutes(app: FastifyInstance) {
  app.post(
    "/create-occurrence-type/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrence-type"],
        summary: "Cria um tipo de ocorrência",
        description:
          'Acrescenta um tipo ao catálogo de ocorrências da empresa. `blocks_delivery` marca os impeditivos: relatar um leva a entrega ativa a Insucesso. `requires_authorization` faz o relato do motorista esperar a decisão da torre (fica PENDENTE, sem efeito). `form_fields` define o formulário que o motorista preenche (até 20 campos; definição inválida → 400 VALIDATION_ERROR com as mensagens). `category` (decisão 14.3; padrão NOT_DELIVERED): DELIVERED = registrar comprova a entrega, com as exigências do tipo (`requires_receipt_photo`, `requires_signature`, `requires_photo`, formulário, autorização); NOT_DELIVERED = os tipos de problema (impeditivos ou informativos); PAUSE = pausa da jornada, com `pause_kind` obrigatório (MEAL, REST, OTHER) e sem fotos, assinatura, formulário nem autorização. Combinação fora dessa matriz → 400 VALIDATION_ERROR com `issues` (ex.: "Só tipos de não entrega podem ser impeditivos."). Motorista não gerencia o catálogo (403). Nome já usado na empresa → 409 OCCURRENCE_TYPE_NAME_TAKEN. Depois de gravar, emite `catalogChanged` (occurrence_type) para as telas abertas da empresa.',
        params: occurrenceTypeSchemas.businessIdParam,
        body: occurrenceTypeSchemas.createOccurrenceType,
        response: {
          201: occurrenceTypeResponses.occurrenceTypeCreated,
          400: errorResponse,
          401: errorResponse,
          403: occurrenceTypeResponses.codedError,
          404: occurrenceTypeResponses.lookupNotFound,
          409: occurrenceTypeResponses.codedError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    createOccurrenceTypeController.handle,
  );

  app.get(
    "/list-occurrence-type",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        deliveriesModule,
        verifyPermission("occurrence_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrence-type"],
        summary: "Lista os tipos de ocorrência",
        description:
          'Tabela paginada no servidor: ordena por `sort`/`order` (name, created_at, updated_at) e filtra por `status` (active, inactive), `blocking` (yes, no), `photo` (yes, no) e `category` (DELIVERED, NOT_DELIVERED, PAUSE), além da busca por id, nome ou descrição. A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões e as opções de cada filtro com as contagens (cada uma com os demais filtros aplicados). Inclui o tipo de sistema \'Comprovante rejeitado\' (`is_system`), que o motorista nunca vê, e os tipos padrão (`is_default`: "Entrega normal", "Refeição", "Descanso", "Outra pausa"). Cada linha diz se já foi usada (`in_use`), o que trava a categoria no diálogo. Token de motorista recebe 403 PERMISSION_DENIED (o app lê os tipos pelas rotas dele).',
        querystring: occurrenceTypeSchemas.listOccurrenceTypes,
        response: {
          200: ndjsonList(
            itemOf(occurrenceTypeResponses.occurrenceTypeList),
            offsetMetaWith(occurrenceTypeListSearchMetaDoc),
          ),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: occurrenceTypeResponses.lookupNotFound,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    listOccurrenceTypeController.handle,
  );

  app.patch(
    "/update-occurrence-type/:occurrenceTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrence-type"],
        summary: "Edita um tipo de ocorrência",
        description:
          "Edita o tipo ou liga/desliga `is_active`. Um tipo desativado mantém o histórico e sai dos seletores de nova ocorrência. Um `form_fields` diferente do atual sobe `form_version` em 1 (o mesmo formulário reenviado não muda a versão); `null` ou `[]` remove o formulário. Desligar `requires_authorization` não decide os relatos já pendentes. Tipo inexistente ou de outra empresa → 404 OCCURRENCE_TYPE_NOT_FOUND (a mesma resposta nos dois casos). Nome de outro tipo da empresa → 409 OCCURRENCE_TYPE_NAME_TAKEN. O tipo do sistema ('Comprovante rejeitado', `is_system`) não é editável → 409 OCCURRENCE_TYPE_SYSTEM. Mudar `category` ou `pause_kind` de um tipo já usado (ocorrência ou pausa) ou padrão → 409 OCCURRENCE_TYPE_CATEGORY_LOCKED. Desativar (ou tirar da categoria) o último tipo ativo de entrega ou de pausa → 409 OCCURRENCE_TYPE_LAST_OF_CATEGORY: sem ele o motorista não comprova (ou não pausa). Combinação fora da matriz da categoria (com o tipo como ficaria) → 400 VALIDATION_ERROR com `issues`. Desativar grava `deactivated_at`; reativar o limpa. Emite `catalogChanged` (occurrence_type).",
        params: occurrenceTypeSchemas.occurrenceTypeBusinessParams,
        body: occurrenceTypeSchemas.updateOccurrenceType,
        response: {
          200: occurrenceTypeResponses.occurrenceTypeUpdated,
          400: errorResponse,
          401: errorResponse,
          403: occurrenceTypeResponses.codedError,
          404: occurrenceTypeResponses.occurrenceTypeNotFound,
          409: occurrenceTypeResponses.codedError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    updateOccurrenceTypeController.handle,
  );

  app.delete(
    "/delete-occurrence-type/:occurrenceTypeId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Same guard as create and update: a suspended company changes nothing
      // in its catalogue (DLV-SHP-7).
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("occurrence_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["occurrence-type"],
        summary: "Exclui um tipo de ocorrência",
        description:
          "Remove um tipo nunca usado. Um tipo já citado por ocorrências ou pausas deve ser desativado (409 OCCURRENCE_TYPE_IN_USE); o tipo do sistema não é excluído (409 OCCURRENCE_TYPE_SYSTEM), nem os tipos padrão (409 OCCURRENCE_TYPE_DEFAULT: os aplicativos instalados comprovam e pausam por eles). Excluir o último tipo ativo de entrega ou de pausa → 409 OCCURRENCE_TYPE_LAST_OF_CATEGORY, como ao desativá-lo. Tipo inexistente ou de outra empresa → 404 OCCURRENCE_TYPE_NOT_FOUND. Empresa inativa recebe 403 TENANT_INACTIVE. Emite `catalogChanged` (occurrence_type).",
        params: occurrenceTypeSchemas.occurrenceTypeBusinessParams,
        response: {
          200: occurrenceTypeResponses.occurrenceTypeDeleted,
          400: occurrenceTypeResponses.codedError,
          403: occurrenceTypeResponses.codedError,
          404: occurrenceTypeResponses.occurrenceTypeNotFound,
          409: occurrenceTypeResponses.codedError,
          500: occurrenceTypeResponses.internalServerError,
        },
      },
    },
    deleteOccurrenceTypeController.handle,
  );
}

export { occurrenceTypeRoutes };

import { FastifyInstance } from "fastify";

import { CreateSupplierController } from "@/modules/supplier/usecases/create-supplier/create-supplier-controller";
import { DeleteSupplierController } from "@/modules/supplier/usecases/delete-supplier/delete-supplier-controller";

import { ListSupplierController } from "@/modules/supplier/usecases/list-supplier/list-supplier-controller";
import { SearchSupplierCursorController } from "@/modules/supplier/usecases/search-supplier-cursor/search-supplier-cursor-controller";

import { UpdateSupplierController } from "@/modules/supplier/usecases/update-supplier/update-supplier-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import {
  supplierResponses,
  supplierSchemas,
} from "./documentation/supplier-documentation";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";

const createSupplierController = new CreateSupplierController();
const deleteSupplierController = new DeleteSupplierController();

const listSupplierController = new ListSupplierController();
const searchSupplierCursorController = new SearchSupplierCursorController();

const updateSupplierController = new UpdateSupplierController();

async function supplierRoutes(app: FastifyInstance) {
  // Maintenance supply chain, only meaningful with fleet operations —
  // gated for the whole plugin.
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/create-supplier/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("supplier_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Cadastra um fornecedor",
        description:
          "Cadastra uma oficina, loja ou prestador da empresa. Nome (sem diferenciar maiúsculas), CNPJ e e-mail são únicos dentro da empresa — duas transportadoras podem cadastrar a mesma oficina. Avisa as outras telas abertas pelo evento `catalogChanged` (entidade `supplier`).",
        params: supplierSchemas.updateDeleteBusiness,
        body: supplierSchemas.createSupplier,
        response: {
          201: supplierResponses.supplierCreated,
          400: supplierResponses.createSupplierErrors,
          404: supplierResponses.sessionUserNotFound,
          409: supplierResponses.supplierConflict,
          500: supplierResponses.internalServerError,
        },
      },
    },
    createSupplierController.handle,
  );

  app.get(
    "/list-supplier",
    {
      onRequest: [ensureAuthenticated],
      // A MASTER naming a switched-off company gets TENANT_INACTIVE, as on
      // every other route of the plugin.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("supplier_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Lista os fornecedores da empresa",
        description:
          "Fornecedores de uma empresa numa tabela paginada. Ordena no servidor (`sort`/`order`) e filtra por UF (um ou mais valores separados por vírgula), além da busca livre (ID, nome, e-mail, cidade, rua e os dígitos de CNPJ, CEP e telefone). A primeira linha (`meta`) traz o total do filtro e, em `searchMeta`, os cartões (total, com telefone, com e-mail, principais estados) e as opções do filtro de UF com as contagens — calculados sobre a empresa inteira, nunca sobre a página. O MASTER informa `businessId`.",
        querystring: supplierSchemas.listSupplier,
        response: {
          200: ndjsonList(
            supplierResponses.supplierRow,
            offsetMetaWith(supplierResponses.supplierListSearchMeta),
          ),
          400: supplierResponses.listSupplierErrors,
          404: supplierResponses.sessionUserNotFound,
          500: supplierResponses.internalServerError,
        },
      },
    },
    listSupplierController.handle,
  );

  app.get(
    "/search-supplier-business",
    {
      onRequest: [ensureAuthenticated],
      // A MASTER naming a switched-off company gets TENANT_INACTIVE, as on
      // every other route of the plugin.
      preHandler: [
        verifyBusinessActive,
        verifyPermission("supplier_manage", "read"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Busca fornecedores da empresa (cursor)",
        description:
          "Os fornecedores de uma empresa para os seletores, em NDJSON paginado por cursor, mais recentes primeiro. `search` filtra no servidor por nome, e-mail, cidade ou dígitos do CNPJ. A primeira linha traz `meta.searchMeta.{nextCursor, hasMore}`; passe `nextCursor` como `cursor` para a próxima página.",
        querystring: supplierSchemas.searchSupplierCursor,
        response: {
          200: ndjsonCursor(supplierResponses.supplierRow),
          400: supplierResponses.searchSupplierErrors,
          404: supplierResponses.sessionUserNotFound,
          500: supplierResponses.internalServerError,
        },
      },
    },
    searchSupplierCursorController.handle,
  );

  app.patch(
    "/update-supplier/:supplierId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("supplier_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Atualiza um fornecedor",
        description:
          "Atualiza os dados do fornecedor. Ele precisa ser da empresa do caminho — fornecedor não muda de empresa, nem pelo MASTER. Nome, CNPJ e e-mail continuam únicos dentro da empresa. Avisa as outras telas pelo evento `catalogChanged`.",
        params: supplierSchemas.supplierParams,
        body: supplierSchemas.updateSupplier,
        response: {
          200: supplierResponses.supplierUpdated,
          400: supplierResponses.updateSupplierErrors,
          403: supplierResponses.supplierForbidden,
          404: supplierResponses.supplierNotFound,
          409: supplierResponses.supplierConflict,
          500: supplierResponses.internalServerError,
        },
      },
    },
    updateSupplierController.handle,
  );

  app.delete(
    "/delete-supplier/:supplierId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyPermission("supplier_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Exclui um fornecedor sem histórico",
        description:
          "Exclui o fornecedor só quando nada o referencia. Com ordens de serviço, peças ou contas a pagar vinculadas, responde 409 SUPPLIER_IN_USE com as contagens: excluir apagaria a oficina das ordens de serviço, a origem das peças e o favorecido das contas. Avisa as outras telas pelo evento `catalogChanged`.",
        params: supplierSchemas.supplierParams,
        response: {
          200: supplierResponses.supplierDeleted,
          400: supplierResponses.deleteSupplierErrors,
          403: supplierResponses.supplierForbidden,
          404: supplierResponses.supplierNotFound,
          409: supplierResponses.supplierInUse,
          500: supplierResponses.internalServerError,
        },
      },
    },
    deleteSupplierController.handle,
  );
}

export { supplierRoutes };

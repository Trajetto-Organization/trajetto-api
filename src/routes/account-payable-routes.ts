import { FastifyInstance } from "fastify";

import { CreateAccountPayableController } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-controller";
import { ListAccountPayableController } from "@/modules/account-payable/usecases/list-account-payable/list-account-payable-controller";

import { ListAccountPayableByResponsibleUserController } from "@/modules/account-payable/usecases/list-account-payable-by-responsible-user/list-account-payable-by-responsible-user-controller";

import { UpdateAccountPayableController } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-controller";
import { DeleteAccountPayableController } from "@/modules/account-payable/usecases/delete-account-payable/delete-account-payable-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  accountPayableSchemas,
  accountPayableResponses,
} from "./documentation/account-payable-documentation";

const createAccountPayableController = new CreateAccountPayableController();
const listAccountPayableController = new ListAccountPayableController();

const listAccountPayableByResponsibleUserController =
  new ListAccountPayableByResponsibleUserController();

const updateAccountPayableController = new UpdateAccountPayableController();
const deleteAccountPayableController = new DeleteAccountPayableController();

async function accountPayableRoutes(app: FastifyInstance) {
  app.post(
    "/create-account-payable/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Create a new account payable",
        description:
          "Register a new financial obligation or bill to be paid with amount, due date, supplier information, and payment details",
        params: accountPayableSchemas.businessIdParam,
        body: accountPayableSchemas.createAccountPayable,
        response: {
          201: accountPayableResponses.accountPayableCreated,
          400: accountPayableResponses.createAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    createAccountPayableController.handle,
  );

  app.get(
    "/list-account-payable",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "List accounts payable",
        description:
          "Retrieve a paginated list of financial obligations and bills with payment status, amounts, and supplier information",
        querystring: accountPayableSchemas.listAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableList,
          400: accountPayableResponses.listAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    listAccountPayableController.handle,
  );

  app.get(
    "/list-account-payable-by-responsible-user",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "List accounts payable by responsible user",
        description:
          "Retrieve a paginated list of accounts payable where the authenticated user is the responsible party (typically for drivers/employees)",
        querystring: accountPayableSchemas.listAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableList,
          400: accountPayableResponses.listAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    listAccountPayableByResponsibleUserController.handle,
  );

  app.patch(
    "/update-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Update an account payable",
        description:
          "Update existing financial obligation details including payment status, amounts, due dates, and associated information",
        params: accountPayableSchemas.accountPayableBusinessParams,
        body: accountPayableSchemas.updateAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableUpdated,
          400: accountPayableResponses.updateAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    updateAccountPayableController.handle,
  );

  app.delete(
    "/delete-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        summary: "Delete an account payable",
        description:
          "Permanently remove a financial obligation record from the accounts payable system",
        params: accountPayableSchemas.accountPayableBusinessParams,
        response: {
          200: accountPayableResponses.accountPayableDeleted,
          400: accountPayableResponses.deleteAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    deleteAccountPayableController.handle,
  );
}

export { accountPayableRoutes };

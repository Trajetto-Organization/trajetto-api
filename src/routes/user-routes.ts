import { FastifyInstance } from "fastify";

import { CreateUserController } from "@/modules/user/usecases/create-user/create-user-controller";
import { AuthenticateUserController } from "@/modules/user/usecases/authenticate-user/authenticate-user-controller";

import { ForgotPasswordVerificationController } from "@/modules/user/usecases/forgot-password-verification/forgot-password-verification-controller";
import { ResetUserPasswordController } from "@/modules/user/usecases/reset-user-password/reset-user-password-controller";

import { SendForgotPasswordMailController } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-controller";
import { RefreshTokenController } from "@/modules/user/usecases/refresh-token/refresh-token-controller";

import { LogoutController } from "@/modules/user/usecases/logout/logout-controller";
import { CreateSocketTicketController } from "@/modules/user/usecases/create-socket-ticket/create-socket-ticket-controller";

import { TwoFactorVerificationController } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-controller";
import { GetUserController } from "@/modules/user/usecases/get-user/get-user-controller";

import { UpdateUserNameController } from "@/modules/user/usecases/update-user-name/update-user-name-controller";
import { UpdateTwoFactorAuthenticationController } from "@/modules/user/usecases/update-two-factor-authentication/update-two-factor-authentication-controller";

import { UpdateUserPasswordController } from "@/modules/user/usecases/update-user-password/update-user-password-controller";
import { ListUsersController } from "@/modules/user/usecases/list-users/list-users-controller";

import { UpdateUserController } from "@/modules/user/usecases/update-user/update-user-controller";
import { DeleteUserController } from "@/modules/user/usecases/delete-user/delete-user-controller";

import { EmailVerificationController } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";
import { refreshSessionRateLimitKey } from "@/config/rate-limit";

import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { ResendTwoFactorCodeController } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-controller";
import { UserRevokeAccessController } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-controller";

import { UploadAvatarController } from "@/modules/user/usecases/upload-avatar/upload-avatar-controller";
import { DeleteAvatarController } from "@/modules/user/usecases/delete-avatar/delete-avatar-controller";

import { CreateMasterUserController } from "@/modules/user/usecases/create-master-user/create-master-user-controller";
import { ListMasterUsersController } from "@/modules/user/usecases/list-master-users/list-master-users-controller";

import { UpdateMasterUserController } from "@/modules/user/usecases/update-master-user/update-master-user-controller";
import { DeleteMasterUserController } from "@/modules/user/usecases/delete-master-user/delete-master-user-controller";

import { SearchUserCursorController } from "@/modules/user/usecases/search-user-cursor/search-user-cursor-controller";

import { userResponses, userSchemas } from "./documentation/user-documentation";
import {
  ndjsonCursor,
  ndjsonList,
  offsetMetaWith,
} from "./documentation/ndjson";
import { errorResponse } from "./documentation/common-responses";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

const createUserController = new CreateUserController();
const listUsersController = new ListUsersController();

const authenticateUserController = new AuthenticateUserController();

const forgotPasswordVerificationController =
  new ForgotPasswordVerificationController();
const resetUserPasswordController = new ResetUserPasswordController();

const sendForgotPasswordMailController = new SendForgotPasswordMailController();
const refreshTokenController = new RefreshTokenController();
const logoutController = new LogoutController();
const createSocketTicketController = new CreateSocketTicketController();

const twoFactorVerificationController = new TwoFactorVerificationController();
const resendTwoFactorCodeController = new ResendTwoFactorCodeController();

const emailVerificationController = new EmailVerificationController();

const getUserController = new GetUserController();
const deleteUserController = new DeleteUserController();

const updateUserPasswordController = new UpdateUserPasswordController();
const updateUserController = new UpdateUserController();

const updateUserNameController = new UpdateUserNameController();
const updateTwoFactorAuthenticationController =
  new UpdateTwoFactorAuthenticationController();

const userRevokeAccessController = new UserRevokeAccessController();

const uploadAvatarController = new UploadAvatarController();
const deleteAvatarController = new DeleteAvatarController();

const createMasterUserController = new CreateMasterUserController();
const listMasterUsersController = new ListMasterUsersController();

const updateMasterUserController = new UpdateMasterUserController();
const deleteMasterUserController = new DeleteMasterUserController();

const searchUserCursorController = new SearchUserCursorController();

async function userRoutes(app: FastifyInstance) {
  app.post(
    "/create-user",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Cria um usuário",
        description:
          "Cadastra um usuário na empresa informada, com nível de acesso e perfil de acesso ou motorista vinculado. Nenhuma senha é definida aqui nem enviada por e-mail: o usuário recebe um link de uso único (72 h) para definir a própria senha.",
        body: userSchemas.createUser,
        response: {
          201: userResponses.userCreated,
          400: userResponses.createUserErrors,
          403: userResponses.createUserForbiddenErrors,
          404: userResponses.createUserNotFoundErrors,
          409: userResponses.createUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    createUserController.handle,
  );

  app.get(
    "/list-user",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Lista os usuários de uma empresa",
        description:
          "Página de usuários com busca, ordenação e filtros no servidor. A linha de meta traz em `searchMeta` os cartões e as opções dos filtros, contados sobre a empresa inteira. O MASTER informa `businessId`; os demais listam sempre a própria empresa.",
        querystring: userSchemas.listUsers,
        response: {
          200: ndjsonList(
            userResponses.userListRow,
            offsetMetaWith(userResponses.userListSearchMeta),
          ),
          400: userResponses.listUsersErrors,
          404: userResponses.businessNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    listUsersController.handle,
  );

  app.get(
    "/search-user-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Busca usuários da empresa (cursor)",
        description:
          "Usuários da empresa em NDJSON paginado por cursor, para os seletores. " +
          "O termo em `search` é comparado com nome e e-mail no servidor. " +
          "A primeira linha traz {meta: {total: 0, searchMeta: {nextCursor, hasMore}}}; " +
          "use nextCursor como `cursor` da próxima página.",
        querystring: userSchemas.searchUserCursor,
        response: {
          200: ndjsonCursor(userResponses.userRow),
          400: userResponses.listUserBusinessErrors,
          404: userResponses.businessNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    searchUserCursorController.handle,
  );

  app.post(
    "/session",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 8 }),
      },
      schema: {
        tags: ["user"],
        summary: "Entra com e-mail e senha",
        description:
          "Confere as credenciais e abre uma sessão com os tokens de acesso (ou pede o código de dois fatores). Credenciais erradas: 401 AUTH_INVALID_CREDENTIALS, a mesma frase para e-mail inexistente e senha errada. Conta sem perfil, revogada, motorista inativo ou empresa inativa: 403 com o `code` de cada caso.",
        body: userSchemas.authenticateUser,
        response: {
          200: userResponses.authenticateUserSuccess,
          400: errorResponse,
          401: userResponses.authenticateUserUnauthorized,
          403: userResponses.authenticateUserForbiddenErrors,
          500: userResponses.internalServerError,
          // AUTH_BUSY with Retry-After: this replica's password checks are
          // saturated (src/shared/security/bcrypt-gate.ts).
          503: errorResponse,
        },
      },
    },
    authenticateUserController.handle,
  );

  app.get(
    "/forgot-verification",
    {
      schema: {
        tags: ["user"],
        summary: "Confere o link de redefinição de senha",
        description:
          "Confere o token recebido por e-mail antes de mostrar o formulário de nova senha. Token ausente, inválido ou expirado: 400 AUTH_TOKEN_MISSING, AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED.",
        querystring: userSchemas.forgotPasswordVerification,
        response: {
          200: userResponses.forgotPasswordVerificationSuccess,
          400: userResponses.forgotVerificationErrors,
          404: userResponses.tokenUserNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    forgotPasswordVerificationController.handle,
  );

  app.post(
    "/reset/password",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        summary: "Define a nova senha pelo link",
        description:
          "Grava a nova senha com o token do link de redefinição. Token inválido ou expirado: 400 AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED.",
        querystring: userSchemas.forgotPasswordVerification,
        body: userSchemas.forgotPassword,
        response: {
          200: userResponses.passwordResetSuccess,
          400: userResponses.resetPasswordErrors,
          404: userResponses.tokenUserNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    resetUserPasswordController.handle,
  );

  app.post(
    "/forgot/password",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        summary: "Pede o link de redefinição de senha",
        description:
          "Envia o link de redefinição para o e-mail cadastrado. A resposta é a mesma exista ou não a conta, para não confirmar quais e-mails existem.",
        body: userSchemas.sendForgotPassword,
        response: {
          200: userResponses.forgotPasswordEmailSent,
          400: userResponses.forgotPasswordErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    sendForgotPasswordMailController.handle,
  );

  app.post(
    "/refresh-token",
    {
      /**
       * Anonymous route, so it needs a cap of its own.
       *
       * There is no `ensureAuthenticated` here — by design, since the whole
       * point is to run when the access token has expired — which means the
       * only limit standing in front of it was the global 300/minute, and
       * `clientRateLimitKey` falls back to the client address for anyone
       * without a session. A client that is behaving refreshes a couple of
       * times a minute at most; 10 leaves room for several tabs and still
       * turns a refresh-token guessing loop into something measured in years.
       *
       * Counted per SESSION, not per address: see refreshSessionRateLimitKey.
       * Every web user reaches this route from the Next.js server, and an
       * office or a mobile carrier puts many people behind one address.
       */
      config: {
        rateLimit: getRateLimiterConfig({
          max: 10,
          keyGenerator: refreshSessionRateLimitKey,
          hook: "preHandler",
        }),
      },
      schema: {
        tags: ["user"],
        summary: "Renova os tokens da sessão",
        description:
          "Troca um refresh token válido por um novo par de tokens. Refresh inválido, expirado ou já usado: 401 AUTH_REFRESH_INVALID.",
        body: userSchemas.refreshToken,
        response: {
          200: userResponses.tokenRefreshed,
          400: userResponses.refreshTokenErrors,
          401: userResponses.refreshTokenUnauthorizedErrors,
          403: userResponses.refreshTokenForbiddenErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    refreshTokenController.handle,
  );

  app.post(
    "/logout",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary:
          "Encerra a sessão atual (revoga a família de refresh tokens desta sessão)",
        description:
          "As outras sessões do usuário (outros aparelhos e navegadores) continuam valendo. Um token de uma sessão já encerrada responde 401 AUTH_SESSION_INVALIDATED.",
        response: {
          200: userResponses.loggedOut,
          500: userResponses.internalServerError,
        },
      },
    },
    logoutController.handle,
  );

  app.post(
    "/socket-ticket",
    {
      config: {
        // One per socket attempt; the web reconnects with a back-off of 1 to
        // 10 s, so 30 a minute per user is room for several tabs.
        rateLimit: getRateLimiterConfig({ max: 30 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Emite um ticket de uso único para o tempo real",
        description:
          "Ticket ligado à sessão do token (usuário, empresa, sessão e versão), guardado só como hash por 30 segundos. O handshake do Socket.IO o recebe em `auth.ticket` e o consome: uma segunda conexão com o mesmo ticket, um ticket vencido, ou uma sessão encerrada, com outra versão ou de outra empresa desde a emissão é recusada (connect_error SOCKET_TICKET_INVALID ou AUTH_SESSION_INVALIDATED). Serve para a web não entregar o token de acesso ao JavaScript da página; o app continua usando `auth.token`.",
        response: {
          201: userResponses.socketTicketIssued,
          503: userResponses.socketTicketUnavailable,
          500: userResponses.internalServerError,
        },
      },
    },
    createSocketTicketController.handle,
  );

  app.post(
    "/two-factor-verification",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        summary: "Confere o código de dois fatores",
        description:
          "Conclui o login com o código enviado por e-mail. Código errado: 400 AUTH_2FA_CODE_INVALID; expirado: 400 AUTH_2FA_CODE_EXPIRED; de outro usuário: 400 AUTH_2FA_USER_MISMATCH.",
        body: userSchemas.twoFactorUser,
        response: {
          200: userResponses.twoFactorSuccess,
          400: userResponses.twoFactorVerificationErrors,
          403: userResponses.twoFactorVerificationForbiddenErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    twoFactorVerificationController.handle,
  );

  app.post(
    "/email-verification",
    {
      schema: {
        tags: ["user"],
        summary: "Confirma o e-mail do usuário",
        description:
          "Confirma o e-mail pelo link recebido, o que ativa a conta e os avisos por e-mail. Token ausente, inválido ou expirado: 400 AUTH_TOKEN_MISSING, AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED; conta que não existe mais: 404 USER_NOT_FOUND.",
        querystring: userSchemas.emailVerification,
        response: {
          200: userResponses.genericMessage,
          400: userResponses.emailVerificationErrors,
          404: userResponses.tokenUserNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    emailVerificationController.handle,
  );

  app.post(
    "/resend-two-factor-code",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 1, timeWindow: 10000 }),
      },
      schema: {
        tags: ["user"],
        summary: "Reenvia o código de dois fatores",
        description:
          "Manda outro código por e-mail quando o anterior expirou ou não chegou.",
        body: userSchemas.resendTwoFactorCode,
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resendTwoFactorCodeErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    resendTwoFactorCodeController.handle,
  );

  app.get(
    "/me",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Consulta o próprio perfil",
        description: "O cadastro do usuário autenticado.",
        response: {
          200: userResponses.userReturned,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    getUserController.handle,
  );

  app.delete(
    "/delete-user/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Exclui um usuário",
        description:
          "Exclui a conta de um usuário da empresa. Recusa (409) quem é responsável por ordens de serviço ou contas a pagar, ou é autor de registros que a plataforma preserva (USER_HAS_RECORDS: eventos de entrega, decisões da torre, importações, mensagens), apontando para revogar o acesso; recusa (403 PERMISSION_DENIED) um nível de acesso acima do de quem pede e um usuário Master (que sai por /user/delete-master-user, a rota que garante que sempre reste um). Encerra as sessões e, se for o login de um motorista, avisa as abas abertas (catalogChanged driver).",
        params: userSchemas.updateDeleteUser,
        response: {
          200: userResponses.userDeleted,
          400: userResponses.deleteUserErrors,
          403: userResponses.deleteUserForbiddenErrors,
          404: userResponses.deleteUserNotFoundErrors,
          409: userResponses.deleteUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteUserController.handle,
  );

  app.patch(
    "/update-user/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Atualiza um usuário",
        description:
          "Compara os valores enviados com os atuais e grava só o que mudou. Mudar o nível de acesso ou o motorista vinculado encerra as sessões do usuário e apaga as notificações dele (as atividades ficam). A empresa não muda pela edição, nem pelo MASTER (decisão 16.100): um `businessId` no corpo responde 400 VALIDATION_ERROR. Mudar só o nome, o e-mail ou o perfil não desloga ninguém. O MASTER pode pedir `sendPasswordSetupLink`: o usuário recebe um link de uso único para definir uma nova senha; se o link não puder ser gerado, nada é alterado (503 PASSWORD_LINK_UNAVAILABLE). Usuários Master são alterados em /user/update-master-user.",
        params: userSchemas.updateDeleteUser,
        body: userSchemas.updateUser,
        response: {
          200: userResponses.userUpdated,
          400: userResponses.updateUserErrors,
          403: userResponses.updateUserForbiddenErrors,
          404: userResponses.updateUserNotFoundErrors,
          409: userResponses.updateUserConflictErrors,
          500: userResponses.internalServerError,
          503: userResponses.passwordLinkUnavailable,
        },
      },
    },
    updateUserController.handle,
  );

  app.patch(
    "/password",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Troca a própria senha",
        description:
          "Troca a senha do usuário autenticado, com a senha atual. Senha atual errada: 400 PASSWORD_CURRENT_INCORRECT; nova igual à atual: 400 PASSWORD_SAME_AS_CURRENT.",
        body: userSchemas.updateUserPassword,
        response: {
          200: userResponses.passwordUpdated,
          400: userResponses.updatePasswordErrors,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateUserPasswordController.handle,
  );

  app.patch(
    "/username",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Troca o próprio nome",
        description:
          "Atualiza o nome do usuário autenticado. O mesmo nome de agora: 400 USER_NAME_UNCHANGED.",
        body: userSchemas.updateUserName,
        response: {
          200: userResponses.usernameUpdated,
          400: userResponses.updateUsernameErrors,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateUserNameController.handle,
  );

  app.patch(
    "/twofactor",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Liga ou desliga a verificação em dois fatores",
        description:
          "Liga ou desliga, na conta do usuário autenticado, o código enviado por e-mail a cada login.",
        response: {
          200: userResponses.twoFactorUpdated,
          400: userResponses.twoFactorUpdateErrors,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateTwoFactorAuthenticationController.handle,
  );


  app.patch(
    "/revoke-access/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Revoga ou restaura o acesso de um usuário",
        description:
          "Alterna o acesso da conta (revogado ↔ liberado). Só MASTER e administradores; um nível de acesso acima do de quem pede é recusado com 403 PERMISSION_DENIED. Se for o login de um motorista, avisa as abas abertas (catalogChanged driver).",
        params: userSchemas.revokeUserAccess,
        response: {
          200: userResponses.userAccessRevoked,
          400: userResponses.revokeUserAccessErrors,
          403: userResponses.revokeUserAccessForbiddenErrors,
          404: userResponses.revokeUserAccessNotFoundErrors,
          409: userResponses.revokeUserAccessConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    userRevokeAccessController.handle,
  );

  app.patch(
    "/avatar",
    {
      // Parsed by hand in the controller; documented through the transform.
      config: { openapi: { body: userSchemas.avatarBody } },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Envia ou troca o avatar",
        consumes: ["application/json"],
        description:
          "Grava ou troca a imagem do avatar do usuário autenticado. A imagem vai em `photo`, a chave já enviada ao armazenamento por POST /uploads/avatar/presign. Sem `photo` válido: 400 AVATAR_PHOTO_REQUIRED.",
        response: {
          200: userResponses.genericMessage,
          400: userResponses.avatarUploadErrors,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    uploadAvatarController.handle,
  );

  app.delete(
    "/avatar",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Remove o avatar",
        description:
          "Remove a imagem do avatar do usuário autenticado e volta ao padrão. Usuário sem avatar: 404 USER_AVATAR_NOT_FOUND.",
        response: {
          200: userResponses.genericMessage,
          404: userResponses.avatarNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteAvatarController.handle,
  );

  // Master User Routes
  app.post(
    "/create-master-user",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Cria um usuário master",
        description:
          "Cadastra um master. Só um master pode fazê-lo. Nenhuma senha é enviada por e-mail: o novo master recebe um link de uso único (72 h) para definir a própria senha.",
        body: userSchemas.createMasterUser,
        response: {
          201: userResponses.masterUserCreated,
          400: userResponses.createMasterUserErrors,
          403: userResponses.createMasterUserForbiddenErrors,
          404: userResponses.createMasterUserNotFoundErrors,
          409: userResponses.createMasterUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    createMasterUserController.handle,
  );

  app.get(
    "/list-master-users",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Lista os usuários master",
        description:
          "Página dos masters (exceto quem pede) com busca, ordenação e filtros de acesso e 2FA no servidor; `searchMeta` traz os cartões.",
        querystring: userSchemas.listMasterUsers,
        response: {
          200: ndjsonList(
            userResponses.userRow,
            offsetMetaWith(userResponses.userListSearchMeta),
          ),
          400: userResponses.listUsersErrors,
          404: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    listMasterUsersController.handle,
  );

  app.patch(
    "/update-master-user/:masterUserId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Atualiza um usuário master",
        description:
          "Altera o nome ou o e-mail de outro master, ou envia a ele um link de uso único para definir uma nova senha (`sendPasswordSetupLink`). Nenhuma senha é digitada por terceiros nem enviada por e-mail; se o link não puder ser gerado, nada é alterado (503 PASSWORD_LINK_UNAVAILABLE).",
        params: userSchemas.updateMasterUserParams,
        body: userSchemas.updateMasterUser,
        response: {
          200: userResponses.masterUserUpdated,
          400: userResponses.updateMasterUserErrors,
          403: userResponses.updateMasterUserForbiddenErrors,
          404: userResponses.updateMasterUserNotFoundErrors,
          409: userResponses.updateMasterUserConflictErrors,
          500: userResponses.internalServerError,
          503: userResponses.passwordLinkUnavailable,
        },
      },
    },
    updateMasterUserController.handle,
  );

  app.delete(
    "/delete-master-user/:masterUserId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Exclui um usuário master",
        description:
          "Remove a conta de outro master. Ninguém exclui a si mesmo, e o último master nunca é removido (a contagem e a exclusão acontecem juntas, então dois pedidos simultâneos não zeram os masters). Recusa (409) quem ainda é responsável por ordens de serviço ou contas a pagar.",
        params: userSchemas.updateMasterUserParams,
        response: {
          200: userResponses.masterUserDeleted,
          400: userResponses.deleteMasterUserErrors,
          403: userResponses.deleteMasterUserForbiddenErrors,
          404: userResponses.deleteMasterUserNotFoundErrors,
          409: userResponses.deleteMasterUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteMasterUserController.handle,
  );
}

export { userRoutes };

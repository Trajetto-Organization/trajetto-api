import { z } from "zod";

import { errorResponse } from "./common-responses";

import { EnumUserRole } from "@/modules/user/dtos/user-dto";
import { createUserSchema } from "@/schemas/create-user-schema";

import { createMasterUserSchema } from "@/schemas/create-master-user-schema";
import {
  updateMasterUserSchema,
  updateMasterUserParamsSchema,
} from "@/schemas/update-master-user-schema";

import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";
import { forgotPasswordVerificationSchema } from "@/schemas/forgot-password-verification-schema";

import { forgotPasswordSchema } from "@/schemas/forgot-password-schema";
import { sendForgotPasswordSchema } from "@/schemas/send-forgot-password-schema";

import { refreshTokenSchema } from "@/schemas/refresh-token-schema";
import { twoFactorUserSchema } from "@/schemas/two-factor-schema";

import { resendTwoFactorCodeSchema } from "@/schemas/resend-two-factor-code-schema";
import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

import { updateUserSchema } from "@/schemas/update-user-schema";
import { updateUserPasswordSchema } from "@/schemas/update-user-password-schema";

import { updateUserNameSchema } from "@/schemas/update-user-name-schema";

import {
  listMasterUserSchema,
  listUserSchema,
} from "@/schemas/list-user-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";
import { searchMetaDoc } from "@/shared/pagination/list-meta";

import { getUserSchema } from "@/schemas/get-user-schema";
import { revokeUserAccessSchema } from "@/schemas/revoke-user-access-schema";
import { emailVerificationVerificationSchema } from "@/schemas/email-verification-schema";
import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";

const codedError = z.object({ code: z.string().optional() });

/**
 * A refusal as the error handler sends it: always with a code (decision
 * 11.3). The description lists the codes the route can answer with.
 */
const refusal = (description: string) =>
  errorResponse.extend({ code: z.string() }).describe(description);

const isoDateTime = z.union([z.string(), z.date()]);

/**
 * A user as the listings stream it: the whole row except the password hash.
 *
 * The listings answer NDJSON, and a stream never passes through the response
 * serializer, so nothing applies this schema — whatever the query selects is
 * what leaves. tests/E2E/user-listing-no-password holds it to the real lines
 * in both directions, which makes it the allowlist these routes otherwise
 * lack: a column added to User fails there until it is listed here.
 */
const userRow = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  email_verified: isoDateTime
    .nullable()
    .describe("Quando o e-mail foi confirmado."),
  avatar: z.string().nullable(),
  role: z.nativeEnum(EnumUserRole),
  businessId: z.string().nullable(),
  profileAccessId: z.string().nullable(),
  driverId: z
    .string()
    .nullable()
    .describe("Preenchido quando o usuário é o login de um motorista."),
  two_factor_enabled: z.boolean(),
  access_revoked: z.boolean(),
  session_version: z
    .number()
    .int()
    .describe("Sobe a cada encerramento forçado de sessões."),
  failed_login_attempts: z
    .number()
    .int()
    .describe("Senhas erradas na janela atual."),
  failed_login_at: isoDateTime.nullable(),
  login_locked_until: isoDateTime
    .nullable()
    .describe(
      "Até quando o login está bloqueado por senhas erradas; null quando livre.",
    ),
  whatsapp_notifications_enabled: z.boolean(),
  whatsapp_phone: z.string().nullable(),
  email_notifications_enabled: z.boolean(),
  activity_notifications_enabled: z.boolean(),
  ops_alert_sound_enabled: z
    .boolean()
    .describe("Se o balão de alertas da operação toca som para este usuário."),
  last_seen_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

/** GET /user/list-user adds the names the table shows next to each user. */
const userListRow = userRow.extend({
  profileAccess: z.object({ name: z.string() }).nullable(),
  driver: z.object({ name: z.string() }).nullable(),
  business: z
    .object({ corporate_reason: z.string() })
    .nullable()
    .optional()
    .describe("Só na listagem feita por um MASTER: a empresa do usuário."),
});

const userSchemas = {
  createUser: createUserSchema,
  createMasterUser: createMasterUserSchema,
  updateMasterUser: updateMasterUserSchema,
  updateMasterUserParams: updateMasterUserParamsSchema,
  authenticateUser: authenticateUserSchema,
  forgotPasswordVerification: forgotPasswordVerificationSchema,
  forgotPassword: forgotPasswordSchema,
  sendForgotPassword: sendForgotPasswordSchema,
  refreshToken: refreshTokenSchema,
  twoFactorUser: twoFactorUserSchema,
  resendTwoFactorCode: resendTwoFactorCodeSchema,
  updateDeleteUser: updateDeleteUserSchema,
  updateUser: updateUserSchema,
  updateUserPassword: updateUserPasswordSchema,
  updateUserName: updateUserNameSchema,
  listUsers: listUserSchema,
  listMasterUsers: listMasterUserSchema,
  revokeUserAccess: revokeUserAccessSchema,
  // The link in the confirmation e-mail carries the token in the query, and
  // the controller parses exactly this schema out of it.
  emailVerification: emailVerificationVerificationSchema,
  // What PATCH /user/avatar reads by hand; documentation only.
  avatarBody: z.object({
    photo: presignedPhotoSchema.describe(
      "A imagem, já enviada ao storage: a `key` devolvida por POST /uploads/avatar/presign.",
    ),
  }),
  // The picker's search: the typed term is matched against name and e-mail.
  searchUserCursor: cursorPaginationByBusinessSchema,
};

/**
 * The cards and filter options of GET /user/list-user and
 * /user/list-master-users (decision 8.8): counted over the whole company (or
 * every master), never over the page on screen.
 */
const userListSearchMeta = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Usuários na busca e nos filtros, exceto o de acesso."),
    active: z.number().int().describe("Com acesso liberado."),
    revoked: z.number().int().describe("Com acesso revogado."),
    twoFactor: z
      .number()
      .int()
      .describe("Com verificação em duas etapas, sem o filtro de 2FA."),
    twoFactorTotal: z
      .number()
      .int()
      .describe(
        "Base do cartão de 2FA: a busca e os filtros, exceto o de 2FA.",
      ),
    emailVerified: z
      .number()
      .int()
      .describe("Com e-mail verificado, na busca e em todos os filtros."),
  },
  ["role", "access", "two_factor", "profileAccessId"],
);

const userResponses = {
  // The lines of the NDJSON listings; see userRow.
  userRow,
  userListRow,
  userListSearchMeta,
  userCreated: z.object({
    message: z.string().default("Usuário criado com sucesso!"),
  }),
  userDeleted: z.object({
    message: z.string().default("Usuário deletado com sucesso!"),
  }),
  userUpdated: z.object({
    message: z.string().default("Usuário atualizado com sucesso!"),
  }),
  userReturned: z.object({
    message: z.string().default("Usuário retornado com sucesso!"),
    user: getUserSchema,
  }),
  listUserBusinessErrors: refusal(
    "VALIDATION_ERROR: parâmetro de busca ou cursor recusado (issues diz qual).",
  ),
  passwordUpdated: z.object({
    message: z.string().default("Senha atualizada com sucesso"),
  }),
  usernameUpdated: z.object({
    message: z.string().default("Nome de usuário atualizado com sucesso"),
  }),
  twoFactorUpdated: z.object({
    message: z
      .string()
      .default("Autenticação de dois fatores atualizada com sucesso!"),
  }),
  userAccessRevoked: z.object({
    message: z.string().default("Revogação de acesso atualizada com sucesso!"),
  }),
  forgotPasswordVerificationSuccess: z.object({
    message: z
      .string()
      .default('Token "esqueci minha senha" confirmada com sucesso!'),
  }),
  passwordResetSuccess: z.object({
    message: z.string().default("Senha redefinida com sucesso!"),
  }),
  forgotPasswordEmailSent: z.object({
    message: z
      .string()
      .default(
        "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
      ),
  }),
  tokenRefreshed: z.object({
    refresh_token: z.string(),
    token: z.string(),
  }),
  twoFactorSuccess: z.object({
    message: z.string().default("Autenticação de dois fatores bem-sucedida!"),
    token: z.string(),
    refresh_token: z.string(),
    role: z.nativeEnum(EnumUserRole),
  }),
  genericMessage: z.object({
    message: z.string(),
  }),
  // What logout-controller answers. The code is stable; the sentence is not.
  loggedOut: z.object({
    code: z.string().describe("AUTH_LOGGED_OUT"),
    message: z.string(),
  }),
  socketTicketIssued: z.object({
    ticket: z
      .string()
      .describe(
        "Ticket de uso único para o handshake do Socket.IO (auth: { ticket }). Vale uma conexão, uma vez, por poucos segundos.",
      ),
    expiresIn: z.number().describe("Segundos até o ticket expirar (30)."),
  }),
  socketTicketUnavailable: refusal(
    "SOCKET_TICKET_UNAVAILABLE: o tempo real está indisponível (Redis fora); tente de novo após o Retry-After.",
  ),
  // Token missing, malformed (VALIDATION_ERROR, with `issues`), unknown or
  // expired. `code` and `issues` are listed so the serializer keeps them.
  emailVerificationErrors: refusal(
    "VALIDATION_ERROR (token malformado), AUTH_TOKEN_MISSING, AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED.",
  ),
  // Error responses
  internalServerError: z.object({
    code: z.string().optional(),
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: refusal(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  // Grouped errors by route
  createUserErrors: refusal(
    "VALIDATION_ERROR (corpo inválido), USER_PROFILE_AND_DRIVER (perfil e motorista ao mesmo tempo), PROFILE_ACCESS_NOT_FOUND ou DRIVER_NOT_FOUND (o perfil ou o motorista indicado no corpo não existe ou é de outra empresa — a mesma resposta) ou BUSINESS_NOT_FOUND (a empresa indicada no corpo não existe).",
  ),
  createUserNotFoundErrors: refusal(
    "USER_NOT_FOUND (o usuário da sessão não existe mais).",
  ),
  createUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (nível de acesso acima do seu) ou TENANT_ACCESS_DENIED.",
  ),

  createUserConflictErrors: refusal(
    "USER_ALREADY_EXISTS (e-mail em uso) ou DRIVER_ALREADY_LINKED (motorista já tem login).",
  ),

  authenticateUserSuccess: z.union([
    z.object({
      message: z
        .string()
        .default("Um token de verificação foi enviado para este e-mail!"),
      emailVerification: z.boolean(),
    }),
    z.object({
      message: z
        .string()
        .default("Um código de verificação foi enviado para este e-mail!"),
      twoFactorVerification: z.boolean(),
      // Declared, or the response serializer strips it.
      twoFactorChallenge: z
        .string()
        .optional()
        .describe(
          "Prova de que a senha foi verificada. Envie de volta em `challenge` na verificação do código e no reenvio. Vale 30 minutos.",
        ),
    }),
    z.object({
      message: z.string().default("Usuário autenticado com sucesso!"),
      token: z.string(),
      refresh_token: z.string(),
      role: z.nativeEnum(EnumUserRole),
    }),
  ]),

  // A wrong e-mail or password is a 401, not a 400: the controller answers
  // AUTH_INVALID_CREDENTIALS. The only 400 here is a body that fails the
  // schema, and "no profile" is the 403 below.
  authenticateUserUnauthorized: z
    .object({
      code: z.string().describe("AUTH_INVALID_CREDENTIALS"),
      message: z.string(),
    })
    .describe(
      "E-mail ou senha errados. Não é sessão expirada: não tente renovar o token.",
    ),

  authenticateUserForbiddenErrors: z
    .union([
      z.object({
        message: z
          .string()
          .default(
            "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
          ),
      }),
      z.object({
        message: z
          .string()
          .default(
            "Seu cadastro como motorista está inativo! Para acessar a plataforma novamente, por favor contate o administrador.",
          ),
      }),
    ])
    .and(codedError),

  forgotVerificationErrors: refusal(
    "VALIDATION_ERROR, AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED.",
  ),
  resetPasswordErrors: refusal(
    "VALIDATION_ERROR, AUTH_TOKEN_INVALID ou AUTH_TOKEN_EXPIRED.",
  ),
  refreshTokenErrors: z
    .union([
      z.object({
        message: z.string().default("Credenciais inválidas!"),
      }),
      z.object({
        message: z.string().default("O token de atualização não existe!"),
      }),
    ])
    .and(codedError),

  refreshTokenUnauthorizedErrors: z
    .object({
      message: z.string().default("Assinatura de token inválida!"),
    })
    .and(codedError),

  refreshTokenForbiddenErrors: z
    .union([
      z.object({
        message: z
          .string()
          .default(
            "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
          ),
      }),
      z.object({
        message: z
          .string()
          .default(
            "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
          ),
      }),
    ])
    .and(codedError),

  twoFactorVerificationErrors: refusal(
    "VALIDATION_ERROR, AUTH_2FA_CODE_INVALID, AUTH_2FA_CODE_EXPIRED, AUTH_2FA_USER_MISMATCH ou AUTH_2FA_NOT_FOUND (desafio sem conta ou conta que não existe mais — 400 de propósito: o fluxo é anterior ao login e não confirma quais contas existem).",
  ),
  twoFactorVerificationForbiddenErrors: z
    .object({
      message: z
        .string()
        .default(
          "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
        ),
    })
    .and(codedError),

  resendTwoFactorCodeErrors: refusal(
    "VALIDATION_ERROR: e-mail ausente ou inválido. A resposta de sucesso é a mesma exista a conta ou não.",
  ),
  updateUserErrors: refusal(
    "VALIDATION_ERROR, USER_PROFILE_AND_DRIVER (perfil e motorista ao mesmo tempo), USER_ASSIGNMENT_REQUIRED (nem perfil nem motorista), PROFILE_ACCESS_NOT_FOUND ou DRIVER_NOT_FOUND (o perfil ou o motorista indicado no corpo não existe ou é de outra empresa — a mesma resposta). Um businessId no corpo também é VALIDATION_ERROR: a empresa do usuário não muda pela edição.",
  ),
  updateUserNotFoundErrors: refusal(
    "USER_NOT_FOUND (o usuário do caminho, ou o da sessão, não existe ou é de outra empresa).",
  ),
  passwordLinkUnavailable: refusal(
    "PASSWORD_LINK_UNAVAILABLE: o link de redefinição não pôde ser gerado; nada foi alterado e o pedido pode ser repetido.",
  ),

  updateUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (editar a si mesmo, um nível de acesso acima do seu, um usuário Master — que é alterado em /user/update-master-user — ou pedir o link de senha sem ser MASTER) ou TENANT_ACCESS_DENIED.",
  ),

  updateUserConflictErrors: refusal(
    "USER_ALREADY_EXISTS (e-mail em uso) ou DRIVER_ALREADY_LINKED (motorista já tem login).",
  ),

  updatePasswordErrors: refusal(
    "VALIDATION_ERROR, PASSWORD_CURRENT_INCORRECT (senha atual incorreta) ou PASSWORD_SAME_AS_CURRENT.",
  ),
  updateUsernameErrors: refusal(
    "VALIDATION_ERROR ou USER_NAME_UNCHANGED (o novo nome é igual ao atual).",
  ),
  deleteUserErrors: refusal("VALIDATION_ERROR (id inválido)."),

  deleteUserNotFoundErrors: refusal(
    "USER_NOT_FOUND: o usuário não existe ou é de outra empresa — a mesma resposta.",
  ),

  deleteUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (excluir a si mesmo, um nível de acesso acima do seu ou um usuário Master — que sai por /user/delete-master-user).",
  ),

  deleteUserConflictErrors: refusal(
    "O usuário ainda é responsável por ordens de serviço (USER_HAS_SERVICE_ORDERS) ou por contas a pagar (USER_HAS_ACCOUNT_PAYABLES), com a quantidade na mensagem, ou é autor de registros que a plataforma preserva, como eventos de entrega, decisões da torre, importações ou mensagens (USER_HAS_RECORDS). Revogue o acesso em vez de excluir.",
  ),

  listUsersErrors: z
    .object({
      message: z
        .string()
        .default(
          "Empresa não identificada. Selecione uma empresa para continuar.",
        ),
    })
    .and(codedError)
    .describe(
      "Ordenação ou filtro inválido, ou MASTER sem `businessId` (code BUSINESS_NOT_IDENTIFIED).",
    ),

  businessNotFound: refusal(
    "USER_NOT_FOUND (o usuário da sessão não existe mais) ou BUSINESS_NOT_FOUND.",
  ),
  revokeUserAccessErrors: refusal("VALIDATION_ERROR (id inválido)."),

  revokeUserAccessNotFoundErrors: refusal(
    "USER_NOT_FOUND: o usuário não existe ou é de outra empresa — a mesma resposta.",
  ),

  revokeUserAccessConflictErrors: refusal(
    "O acesso mudou enquanto o pedido era decidido; nada foi gravado.",
  ),

  revokeUserAccessForbiddenErrors: refusal(
    "PERMISSION_DENIED (revogar a si mesmo ou um nível de acesso acima do seu).",
  ),

  twoFactorUpdateErrors: refusal("VALIDATION_ERROR: corpo inválido."),
  // Master user responses
  masterUserCreated: z.object({
    message: z.string().default("Usuário Master criado com sucesso!"),
  }),
  masterUserUpdated: z.object({
    message: z.string().default("Usuário Master atualizado com sucesso!"),
  }),
  masterUserDeleted: z.object({
    message: z.string().default("Usuário Master removido com sucesso!"),
  }),
  createMasterUserErrors: refusal("VALIDATION_ERROR (corpo inválido)."),
  createMasterUserNotFoundErrors: refusal("USER_NOT_FOUND."),
  createMasterUserForbiddenErrors: refusal(
    "PERMISSION_DENIED: só um MASTER cria outro.",
  ),
  createMasterUserConflictErrors: refusal(
    "USER_ALREADY_EXISTS (e-mail em uso).",
  ),

  updateMasterUserErrors: refusal("VALIDATION_ERROR (corpo inválido)."),
  updateMasterUserNotFoundErrors: refusal(
    "USER_NOT_FOUND ou MASTER_USER_NOT_FOUND (o id não é de um usuário Master).",
  ),
  updateMasterUserConflictErrors: refusal(
    "USER_ALREADY_EXISTS (e-mail em uso).",
  ),
  updateMasterUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (alterar a si mesmo, ou quem pede não é MASTER).",
  ),

  deleteMasterUserErrors: refusal("VALIDATION_ERROR (id inválido)."),
  deleteMasterUserNotFoundErrors: refusal(
    "USER_NOT_FOUND ou MASTER_USER_NOT_FOUND (o id não é de um usuário Master).",
  ),
  deleteMasterUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (excluir a si mesmo, ou quem pede não é MASTER).",
  ),
  deleteMasterUserConflictErrors: refusal(
    "LAST_MASTER_USER (deve restar pelo menos um), USER_HAS_SERVICE_ORDERS ou USER_HAS_ACCOUNT_PAYABLES.",
  ),
  tokenUserNotFound: refusal(
    "USER_NOT_FOUND: o token é válido, mas a conta dele não existe mais.",
  ),
  avatarUploadErrors: refusal(
    "VALIDATION_ERROR ou AVATAR_PHOTO_REQUIRED (sem `photo` válido).",
  ),
  avatarNotFound: refusal(
    "USER_AVATAR_NOT_FOUND (o usuário não tem avatar) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
  ),
  forgotPasswordErrors: refusal(
    "VALIDATION_ERROR: e-mail ausente ou inválido. A resposta de sucesso é a mesma exista a conta ou não.",
  ),
};

export { userSchemas, userResponses };

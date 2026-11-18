import { z } from "zod";
import { responseDateTime } from "./response-date";

import { codedRefusal, errorResponse } from "./common-responses";

import { EnumUserRole } from "@/modules/user/dtos/user-dto";
import { createUserSchema } from "@/schemas/create-user-schema";

import { createMasterUserSchema } from "@/schemas/create-master-user-schema";
import {
  updateMasterUserSchema,
  updateMasterUserParamsSchema,
} from "@/schemas/update-master-user-schema";

import { sessionLoginSchema } from "@/schemas/authenticate-user-schema";
import {
  driverDeviceParamsSchema,
  driverLoginParamsSchema,
  enrollSessionSchema,
  revokeSessionSchema,
} from "@/schemas/driver-access-schema";
import { resetDriverPasswordSchema } from "@/schemas/reset-driver-password-schema";
import { forgotPasswordVerificationSchema } from "@/schemas/forgot-password-verification-schema";

import { forgotPasswordSchema } from "@/schemas/forgot-password-schema";
import { sendForgotPasswordSchema } from "@/schemas/send-forgot-password-schema";

import { refreshTokenSchema } from "@/schemas/refresh-token-schema";
import { twoFactorUserSchema } from "@/schemas/two-factor-schema";

import { resendTwoFactorCodeSchema } from "@/schemas/resend-two-factor-code-schema";
import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

import { updateUserSchema } from "@/schemas/update-user-schema";
import {
  createOwnPasswordSchema,
  updateUserPasswordSchema,
} from "@/schemas/update-user-password-schema";
import { updateTwoFactorSchema } from "@/schemas/update-two-factor-schema";
import { ownSessionParamsSchema } from "@/schemas/own-session-schema";

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
  email: z
    .string()
    .nullable()
    .describe(
      "Nulo só no login de um motorista sem e-mail (entra por QR Code ou CPF e senha).",
    ),
  email_verified: responseDateTime()
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
  failed_login_at: responseDateTime().nullable(),
  login_locked_until: responseDateTime()
    .nullable()
    .describe(
      "Até quando o login está bloqueado por senhas erradas; null quando livre.",
    ),
  must_change_password: z
    .boolean()
    .describe(
      "A senha foi definida pelo gestor: a pessoa cria a própria no próximo login.",
    ),
  whatsapp_notifications_enabled: z.boolean(),
  whatsapp_phone: z.string().nullable(),
  email_notifications_enabled: z.boolean(),
  activity_notifications_enabled: z.boolean(),
  ops_alert_sound_enabled: z
    .boolean()
    .describe("Se o balão de alertas da operação toca som para este usuário."),
  last_seen_at: responseDateTime().nullable(),
  created_at: responseDateTime(),
  updated_at: responseDateTime(),
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
  // E-mail and password, or the driver's CPF and password (D8).
  authenticateUser: sessionLoginSchema,
  // The driver's own ways in, and what a manager does with them (plan of
  // 02/11/2026: A3, D2, D3, D7).
  revokeSession: revokeSessionSchema,
  enrollSession: enrollSessionSchema,
  driverLoginParams: driverLoginParamsSchema,
  driverDeviceParams: driverDeviceParamsSchema,
  resetDriverPassword: resetDriverPasswordSchema,
  forgotPasswordVerification: forgotPasswordVerificationSchema,
  forgotPassword: forgotPasswordSchema,
  sendForgotPassword: sendForgotPasswordSchema,
  refreshToken: refreshTokenSchema,
  twoFactorUser: twoFactorUserSchema,
  resendTwoFactorCode: resendTwoFactorCodeSchema,
  updateDeleteUser: updateDeleteUserSchema,
  updateUser: updateUserSchema,
  updateUserPassword: updateUserPasswordSchema,
  // Wave 2: the password created right after a QR code, the explicit
  // two-factor switch (documentation only: parsed by hand) and the person's
  // own sessions.
  createOwnPassword: createOwnPasswordSchema,
  updateTwoFactor: updateTwoFactorSchema,
  ownSessionParams: ownSessionParamsSchema,
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
    // Declared, or the response serializer strips them.
    token: z
      .string()
      .optional()
      .describe(
        "O novo token de acesso desta sessão. Ausente só quando a sessão já tinha terminado: aí todas as sessões terminam, como antes.",
      ),
    refresh_token: z
      .string()
      .optional()
      .describe(
        "O novo refresh token desta sessão, na mesma família e com a mesma política (preso ao mesmo aparelho, quando era). Guarde-o no lugar do anterior: o anterior não renova mais.",
      ),
    mustChangePassword: z
      .literal(false)
      .describe("A senha agora é da própria pessoa."),
  }),
  ownPasswordCreated: z.object({
    message: z.string().default("Senha criada com sucesso."),
    token: z.string().describe("O novo token de acesso desta sessão."),
    refresh_token: z
      .string()
      .describe(
        "O novo refresh token desta sessão, preso ao mesmo aparelho. Guarde-o no lugar do anterior.",
      ),
    mustChangePassword: z.literal(false),
  }),
  ownSessions: z.object({
    data: z.array(
      z.object({
        id: z
          .string()
          .describe(
            "O id opaco da sessão: envie-o em DELETE /user/me/sessions/:id.",
          ),
        kind: z
          .enum(["aparelho", "app", "navegador"])
          .describe(
            "aparelho: sessão presa a um celular (QR Code ou CPF e senha); app: o aplicativo aberto por e-mail; navegador: o painel web.",
          ),
        current: z.boolean().describe("A sessão desta requisição."),
        created_at: z.string().describe("Quando a sessão começou (ISO 8601)."),
        last_activity_at: z
          .string()
          .describe(
            "A última renovação (ISO 8601): o app renova a cada 15 minutos enquanto está em uso.",
          ),
        device_label: z
          .string()
          .nullable()
          .describe(
            "Este aparelho, na sessão desta requisição; null nas outras. O identificador do aparelho nunca é devolvido.",
          ),
      }),
    ),
  }),
  usernameUpdated: z.object({
    message: z.string().default("Nome de usuário atualizado com sucesso"),
  }),
  twoFactorUpdated: z.object({
    message: z
      .string()
      .default("Autenticação de dois fatores atualizada com sucesso!"),
    twoFactorEnabled: z
      .boolean()
      .describe(
        "O estado da conta depois do pedido (o mesmo de antes quando nada mudou).",
      ),
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
    mustChangePassword: z
      .boolean()
      .describe(
        "A senha foi definida pelo gestor: peça a da própria pessoa antes de seguir.",
      ),
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
  socketTicketUnavailable: codedRefusal(
    "SOCKET_TICKET_UNAVAILABLE: o tempo real está indisponível (Redis fora); tente de novo após o Retry-After.",
    ["SOCKET_TICKET_UNAVAILABLE"],
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
    "VALIDATION_ERROR (corpo inválido; `password` fora do login de um motorista, ou e-mail ausente fora dele, também), USER_PASSWORD_DRIVER_ONLY e USER_EMAIL_REQUIRED (as mesmas regras, fora do schema), USER_PROFILE_AND_DRIVER (perfil e motorista ao mesmo tempo), PROFILE_ACCESS_NOT_FOUND ou DRIVER_NOT_FOUND (o perfil ou o motorista indicado no corpo não existe ou é de outra empresa — a mesma resposta) ou BUSINESS_NOT_FOUND (a empresa indicada no corpo não existe).",
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
      mustChangePassword: z
        .boolean()
        .describe(
          "A senha foi definida pelo gestor (senha inicial ou redefinição): peça a da própria pessoa antes de seguir. A API não recusa nada por isso.",
        ),
    }),
    // Declared, or the response serializer strips the list.
    z
      .object({
        message: z.string().default("Escolha a empresa para entrar."),
        businessSelection: z.literal(true),
        businesses: z
          .array(
            z.object({
              id: z.string().describe("Envie de volta em `businessId`."),
              name: z
                .string()
                .describe(
                  "O nome fantasia da empresa (ou a razão social, sem ele).",
                ),
            }),
          )
          .describe(
            "Só as empresas em que o CPF e a senha conferiram, e onde o motorista pode entrar agora.",
          ),
      })
      .describe(
        "Login por CPF: o CPF e a senha valem em mais de uma empresa. Nenhuma sessão foi aberta; repita o mesmo corpo com `businessId`.",
      ),
  ]),

  // The driver's phone opening a session with the manager's QR code (D3).
  enrollSessionSuccess: z.object({
    message: z.string().default("Usuário autenticado com sucesso!"),
    token: z.string(),
    refresh_token: z
      .string()
      .describe(
        "Preso ao aparelho: renove sempre com o mesmo `deviceId` em /user/refresh-token.",
      ),
    role: z.nativeEnum(EnumUserRole),
    mustChangePassword: z
      .boolean()
      .describe(
        "A senha foi definida pelo gestor: o app pede a senha do motorista antes de seguir.",
      ),
  }),
  enrollSessionUnauthorized: codedRefusal(
    "QR Code ou código desconhecido, vencido, já usado ou gasto por tentativas recusadas: a mesma resposta para todos. Peça um novo ao gestor.",
    ["AUTH_ENROLLMENT_INVALID"],
  ),
  enrollSessionForbidden: codedRefusal(
    "O código é válido, mas o motorista não pode entrar agora (a mesma conferência de todo login). Cada recusa conta contra o código, que se gasta depois de 5.",
    [
      "AUTH_DRIVER_INACTIVE",
      "AUTH_ACCESS_REVOKED",
      "AUTH_BUSINESS_INACTIVE",
      "AUTH_BRANCH_INACTIVE",
      "AUTH_DRIVER_TENANT_MISMATCH",
    ],
  ),

  // The access QR code a manager issues for a driver's login (D3).
  enrollmentIssued: z.object({
    qrToken: z
      .string()
      .describe(
        "O token opaco (256 bits). Mostrado uma vez: o servidor guarda só o hash.",
      ),
    qrContent: z
      .string()
      .describe(
        "O texto do QR Code: `trajetto-enroll:1:<ambiente>:<qrToken>`. O app recusa o QR de outro ambiente.",
      ),
    accessCode: z
      .string()
      .describe(
        "O código de 8 caracteres para digitar em vez de ler o QR, como mostrar (`ABCD-EFGH`).",
      ),
    expiresAt: z.string().describe("Quando deixa de valer (ISO 8601)."),
    expiresIn: z
      .number()
      .int()
      .describe("Segundos até vencer (600): a contagem regressiva da tela."),
  }),
  driverLoginErrors: refusal("VALIDATION_ERROR (id ou corpo inválido)."),
  driverLoginNotFound: refusal(
    "USER_NOT_FOUND: o usuário não existe ou é de outra empresa — a mesma resposta.",
  ),
  driverLoginConflict: codedRefusal(
    "USER_NOT_DRIVER: não é o login de um motorista (usuários de escritório seguem com o link por e-mail).",
    ["USER_NOT_DRIVER"],
  ),
  enrollmentConflict: codedRefusal(
    "USER_NOT_DRIVER (não é o login de um motorista), DRIVER_INACTIVE (motorista inativo) ou USER_ACCESS_REVOKED (acesso revogado): o QR Code só sai para quem pode entrar agora.",
    ["USER_NOT_DRIVER", "DRIVER_INACTIVE", "USER_ACCESS_REVOKED"],
  ),
  driverPasswordReset: z.object({
    message: z.string().default("Senha do motorista redefinida com sucesso!"),
  }),

  // The phones a driver is signed in on (D7).
  driverDevices: z.object({
    data: z.array(
      z.object({
        deviceHash: z
          .string()
          .describe(
            "O aparelho, opaco: SHA-256 (hexadecimal) do identificador, a chave de DELETE /user/:userId/devices/:deviceId. O Android ID nunca é devolvido: no login por CPF ele é o que confere o aparelho.",
          ),
        deviceId: z
          .string()
          .describe(
            "O mesmo valor de `deviceHash`, com o nome anterior do campo. Não é mais o Android ID.",
          ),
        sessions: z
          .number()
          .int()
          .describe("Sessões abertas nele (quase sempre 1)."),
        lastActivityAt: z
          .string()
          .describe(
            "A última renovação da sessão (ISO 8601): o app renova a cada 15 minutos enquanto está em uso.",
          ),
        expiresAt: z
          .string()
          .describe(
            "Quando a sessão cai se o aparelho ficar sem uso (ISO 8601).",
          ),
      }),
    ),
  }),

  revokeSessionUnauthorized: codedRefusal(
    "O token não é um refresh token assinado por esta API.",
    ["AUTH_REFRESH_INVALID"],
  ),

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

  // AUTH_DEVICE_NOT_TRUSTED (wave 2) is one of these: the same object, with
  // the sentence in `message`.
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
    .and(codedError)
    .describe(
      "AUTH_REFRESH_INVALID, AUTH_SESSION_INVALIDATED, AUTH_REFRESH_REUSED ou AUTH_DEVICE_MISMATCH (sessão presa a um aparelho renovada sem o mesmo `deviceId`; nada é gasto e o aparelho certo continua renovando).",
    ),

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
    "USER_ALREADY_EXISTS (e-mail em uso) ou DRIVER_ALREADY_LINKED (motorista já tem login). Ao tirar o login do motorista atual (para outro motorista ou para nenhum): DRIVER_HAS_OPEN_ROUTES, quando esse motorista tem rota planejada, liberada ou em andamento (a mensagem traz as contagens e o que fazer com cada rota). Ao passar o login para OUTRO motorista: USER_DRIVER_LOCKED, quando o login já tem registros na operação (eventos de entrega, ocorrências, mensagens…, com a contagem na mensagem) — crie outro login para o novo motorista. Nos dois casos nada é gravado: o QR Code e os aparelhos continuam como estavam.",
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
    "Excluir é só para o login criado por engano; quem já trabalhou tem o acesso revogado. DRIVER_HAS_OPEN_ROUTES: o usuário é o login de um motorista com rota planejada, liberada ou em andamento (a mesma regra da revogação, com as contagens). USER_HAS_SERVICE_ORDERS ou USER_HAS_ACCOUNT_PAYABLES: o usuário ainda é responsável por ordens de serviço ou por contas a pagar, com a quantidade na mensagem (concluir a OS ou quitar a conta não muda isso: transfira a responsabilidade ou revogue o acesso). USER_HAS_RECORDS: o usuário é autor de registros que a plataforma preserva (eventos de entrega, decisões da torre, ocorrências, revisões de comprovante, mensagens do chat, importações), com a contagem de cada tipo na mensagem; revogue o acesso em vez de excluir.",
  ),

  userAnonymizeScheduled: z
    .object({
      message: z.string(),
      jobId: z.string().describe("O job USER_ANONYMIZE que remove os dados."),
    })
    .describe(
      "A remoção e a anonimização ficaram na fila: os dados pessoais saem em instantes.",
    ),

  anonymizeUserForbiddenErrors: refusal(
    "PERMISSION_DENIED (um nível de acesso acima do seu ou um usuário Master) ou USER_CANNOT_BE_DELETED_BY_HIMSELF (a si mesmo).",
  ),

  anonymizeUserConflictErrors: refusal(
    "USER_ALREADY_ANONYMIZED: o usuário já foi removido e anonimizado. USER_IS_DRIVER_LOGIN: é o login de um motorista; remova e anonimize o motorista, que leva o login junto.",
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
    "TOGGLE_CONFLICT: o acesso mudou enquanto o pedido era decidido; nada foi gravado. DRIVER_HAS_OPEN_ROUTES: o usuário é o login de um motorista com rota planejada, liberada ou em andamento — revogar o acesso deixaria a rota sem quem a execute; a mensagem traz as contagens e o que fazer com cada rota (a mesma regra da inativação do motorista). Restaurar o acesso nunca é recusado por isso.",
  ),

  revokeUserAccessForbiddenErrors: refusal(
    "PERMISSION_DENIED (revogar a si mesmo ou um nível de acesso acima do seu).",
  ),

  twoFactorUpdateErrors: refusal(
    "VALIDATION_ERROR (corpo inválido: `enabled` e `password` vão juntos) ou PASSWORD_CURRENT_INCORRECT (senha atual incorreta).",
  ),
  twoFactorUpdateConflict: codedRefusal(
    "Ligar sem e-mail: o código vai por e-mail, então a conta sem e-mail não liga a verificação.",
    ["TWO_FACTOR_REQUIRES_EMAIL"],
  ),
  createOwnPasswordErrors: refusal(
    "VALIDATION_ERROR: senha fora da regra (7 a 100 caracteres, sem espaços) ou `businessId` no corpo.",
  ),
  createOwnPasswordForbidden: codedRefusal(
    "Esta sessão não é a que o QR Code acabou de abrir neste aparelho (há até 15 minutos). Troque a senha com a senha atual (PATCH /user/password) ou peça um novo QR Code ao gestor.",
    ["PASSWORD_CREATE_NOT_ALLOWED"],
  ),
  ownSessionErrors: refusal("VALIDATION_ERROR (id inválido)."),
  ownSessionConflict: codedRefusal(
    "A sessão desta requisição: para sair dela, use POST /user/logout.",
    ["SESSION_IS_CURRENT"],
  ),
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
    "LAST_MASTER_USER (deve restar pelo menos um), USER_HAS_SERVICE_ORDERS, USER_HAS_ACCOUNT_PAYABLES ou USER_HAS_RECORDS (registros que a plataforma preserva, com a contagem na mensagem), como na exclusão de um usuário da empresa.",
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

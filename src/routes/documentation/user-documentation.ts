import { z } from "zod";

import { EnumUserRole } from "@/modules/user/dtos/user-dto";
import { createUserSchema } from "@/schemas/create-user-schema";

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

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

import { getUserSchema } from "@/schemas/get-user-schema";
import { revokeUserAccessSchema } from "@/schemas/revoke-user-access-schema";

const userSchemas = {
  createUser: createUserSchema,
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
  listUsers: listPagesSchema,
  listUserBusiness: listPagesByBusinessSchema,
  revokeUserAccess: revokeUserAccessSchema,
};

const userResponses = {
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
  usersList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        role: z.nativeEnum(EnumUserRole),
        email: z.string(),
        email_notifications_enabled: z.boolean().nullable(),
        activity_notifications_enabled: z.boolean().nullable(),
        two_factor_enabled: z.boolean().optional().nullable(),
        access_revoked: z.boolean(),
        name: z.string(),
        avatar: z.string().optional().nullable(),
        corporate_reason: z.string().optional().nullable(),
        businessId: z.string().optional().nullable(),
        profileAccessId: z.string().optional().nullable(),
        profileAccess: z.string().optional().nullable(),
      }),
    ),
    total: z.number(),
  }),
  listUserBusinessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),
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
  twoFactorVerificationSent: z.object({
    message: z
      .string()
      .default("Um código de verificação foi enviado para este e-mail!"),
    twoFactorVerification: z.boolean(),
  }),
  emailVerificationSent: z.object({
    message: z
      .string()
      .default("Um token de verificação foi enviado para este e-mail!"),
    emailVerification: z.boolean(),
  }),
  userAuthenticated: z.object({
    message: z.string().default("Usuário atutenticado com sucesso!"),
    token: z.string(),
    refresh_token: z.string(),
    role: z.nativeEnum(EnumUserRole),
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
  // Error responses
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  invalidCredentials: z.object({
    message: z.string().default("Credenciais inválidas!"),
  }),
  userWithoutProfile: z.object({
    message: z
      .string()
      .default(
        "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
      ),
  }),
  profileNotFromSameCompany: z.object({
    message: z
      .string()
      .default(
        "O perfil de acesso informado não pertence à mesma empresa do usuário.",
      ),
  }),
  companyNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  profileAccessNotFound: z.object({
    message: z
      .string()
      .default("Perfil de acesso não encontrado! Por favor tente novamente."),
  }),
  userAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este usuário não está disponível para cadastro. Os usuários devem ser únicos em todo o sistema.",
      ),
  }),
  driverInactive: z.object({
    message: z
      .string()
      .default(
        "Seu cadastro como motorista está inativo! Para acessar a plataforma novamente, por favor contate o administrador.",
      ),
  }),
  userRevokedAccess: z.object({
    message: z
      .string()
      .default(
        "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
      ),
  }),
  cannotDeleteSelf: z.object({
    message: z
      .string()
      .default("Usuário não tem permissão para deletar o seu próprio usuário."),
  }),
  cannotUpdateSelf: z.object({
    message: z
      .string()
      .default(
        "Usuário não tem permissão para atualizar o seu próprio usuário.",
      ),
  }),
  cannotRevokeOwnAccess: z.object({
    message: z
      .string()
      .default("Usuário não pode revogar o acesso de si mesmo."),
  }),
  invalidToken: z.object({
    message: z.string().default("Token inválido!"),
  }),
  expiredToken: z.object({
    message: z.string().default("Token expirado!"),
  }),
  refreshTokenNotExists: z.object({
    message: z.string().default("O token de atualização não existe!"),
  }),
  invalidTokenSignature: z.object({
    message: z.string().default("Assinatura de token inválida!"),
  }),
  invalidCode: z.object({
    message: z.string().default("Código inválido!"),
  }),
  expiredCode: z.object({
    message: z.string().default("Código expirado!"),
  }),
  invalidUserCode: z.object({
    message: z.string().default("Código inválido para o usuário!"),
  }),
  incorrectCurrentPassword: z.object({
    message: z.string().default("Senha atual incorreta"),
  }),
  newPasswordSameAsOld: z.object({
    message: z
      .string()
      .default("A nova senha não pode ser igual à senha atual"),
  }),
  newNameMustBeDifferent: z.object({
    message: z
      .string()
      .default("Para atualizar, o novo nome deve ser diferente do atual"),
  }),
  noActiveTwoFactor: z.object({
    message: z
      .string()
      .default(
        "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
      ),
  }),

  // Grouped errors by route
  createUserErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Perfil de acesso não encontrado! Por favor tente novamente."),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é permitido vincular um perfil de acesso e um motorista ao mesmo usuário.",
        ),
    }),
  ]),

  createUserForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "O perfil de acesso informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Apenas usuários com nível de acesso Master podem definir senhas personalizadas. A senha será gerada automaticamente.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence à mesma empresa do usuário."),
    }),
  ]),

  createUserConflictErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "Este usuário não está disponível para cadastro. Os usuários devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista já está vinculado a outro usuário."),
    }),
  ]),

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
    }),
    z.object({
      message: z.string().default("Usuário atutenticado com sucesso!"),
      token: z.string(),
      refresh_token: z.string(),
      role: z.nativeEnum(EnumUserRole),
    }),
  ]),

  authenticateUserErrors: z.union([
    z.object({
      message: z.string().default("Credenciais inválidas!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
        ),
    }),
  ]),

  authenticateUserForbiddenErrors: z.union([
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
  ]),

  forgotVerificationErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Token inválido!"),
    }),
    z.object({
      message: z.string().default("Token expirado!"),
    }),
  ]),

  resetPasswordErrors: z.union([
    z.object({
      message: z.string().default("Token inválido!"),
    }),
    z.object({
      message: z.string().default("Token expirado!"),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  refreshTokenErrors: z.union([
    z.object({
      message: z.string().default("Credenciais inválidas!"),
    }),
    z.object({
      message: z.string().default("O token de atualização não existe!"),
    }),
  ]),

  refreshTokenUnauthorizedErrors: z.object({
    message: z.string().default("Assinatura de token inválida!"),
  }),

  refreshTokenForbiddenErrors: z.union([
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
  ]),

  twoFactorVerificationErrors: z.union([
    z.object({
      message: z.string().default("Código inválido!"),
    }),
    z.object({
      message: z.string().default("Código expirado!"),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Código inválido para o usuário!"),
    }),
  ]),

  twoFactorVerificationForbiddenErrors: z.object({
    message: z
      .string()
      .default(
        "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
      ),
  }),

  resendTwoFactorCodeErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
        ),
    }),
  ]),

  updateUserErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Perfil de acesso não encontrado! Por favor tente novamente."),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é permitido vincular um perfil de acesso e um motorista ao mesmo usuário.",
        ),
    }),
  ]),

  updateUserForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "Usuário não tem permissão para atualizar o seu próprio usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O perfil de acesso informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Apenas usuários com nível de acesso Master podem definir senhas personalizadas. A senha será gerada automaticamente.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista não pertence à mesma empresa do usuário."),
    }),
  ]),

  updateUserConflictErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "Este usuário não está disponível para cadastro. Os usuários devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("Este motorista já está vinculado a outro usuário."),
    }),
  ]),

  updatePasswordErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Senha atual incorreta"),
    }),
    z.object({
      message: z
        .string()
        .default("A nova senha não pode ser igual à senha atual"),
    }),
  ]),

  updateUsernameErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Para atualizar, o novo nome deve ser diferente do atual"),
    }),
  ]),

  deleteUserErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  deleteUserForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default(
          "Usuário não tem permissão para deletar o seu próprio usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este usuário pois ele possui ordens de serviço associadas.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este usuário pois ele possui contas a pagar associadas.",
        ),
    }),
  ]),

  listUsersErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  revokeUserAccessErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  revokeUserAccessForbiddenErrors: z.object({
    message: z
      .string()
      .default("Usuário não pode revogar o acesso de si mesmo."),
  }),

  twoFactorUpdateErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
};

export { userSchemas, userResponses };

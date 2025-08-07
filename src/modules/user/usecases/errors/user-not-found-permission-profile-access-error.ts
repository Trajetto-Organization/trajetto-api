class UserNotFoundPermissionOrProfileAccess extends Error {
  constructor() {
    super(
      "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
    );
  }
}

export { UserNotFoundPermissionOrProfileAccess };

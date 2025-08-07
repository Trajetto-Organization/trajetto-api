class UserUpdateIsSamePasswordError extends Error {
  constructor() {
    super("A nova senha não pode ser igual à senha atual");
  }
}

export { UserUpdateIsSamePasswordError };

class UserNotBelongBusinessError extends Error {
  constructor() {
    super("Este usuário não pertence a esta empresa!");
  }
}

export { UserNotBelongBusinessError };

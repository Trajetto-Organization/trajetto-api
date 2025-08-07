class BranchNotBelongBusinessError extends Error {
  constructor() {
    super("Esta filial não pertence a esta empresa!");
  }
}

export { BranchNotBelongBusinessError };

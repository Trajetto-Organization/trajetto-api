class ResourceNotFoundError extends Error {
  constructor() {
    super("Recurso não encontrado!");
  }
}

export { ResourceNotFoundError };

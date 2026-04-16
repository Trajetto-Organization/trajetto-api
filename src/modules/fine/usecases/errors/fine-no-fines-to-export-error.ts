class FineNoFinesToExportError extends Error {
  constructor() {
    super("Não existem multas para exportar!");
  }
}

export { FineNoFinesToExportError };

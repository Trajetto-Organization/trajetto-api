class ServiceOrderNoServiceOrdersToExportError extends Error {
  constructor() {
    super("Não existem ordens de serviço para exportar!");
  }
}

export { ServiceOrderNoServiceOrdersToExportError };

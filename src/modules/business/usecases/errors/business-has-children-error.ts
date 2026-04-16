class BusinessHasChildrenError extends Error {
  constructor(details: string) {
    super(
      `Não é possível excluir esta empresa. ${details} Desative a empresa ou remova os registros vinculados antes de excluí-la.`,
    );
  }
}

export { BusinessHasChildrenError };

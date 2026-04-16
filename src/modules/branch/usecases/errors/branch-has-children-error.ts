class BranchHasChildrenError extends Error {
  constructor(details: string) {
    super(
      `Não é possível excluir esta filial. ${details} Desative a filial ou remova os registros vinculados antes de excluí-la.`,
    );
  }
}

export { BranchHasChildrenError };

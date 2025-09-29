class DriverHasAssociatedChecklistsError extends Error {
  constructor(checklistCount: number) {
    super(
      `Não é possível deletar este motorista pois existem ${checklistCount} checklist(s) associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir checklists para outro motorista (recomendado)\n` +
        `• Deletar checklists pendentes antes de deletar`,
    );
  }
}

export { DriverHasAssociatedChecklistsError };

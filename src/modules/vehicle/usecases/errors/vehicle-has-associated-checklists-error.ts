class VehicleHasAssociatedChecklistsError extends Error {
  constructor(checklistCount: number) {
    super(
      `Não é possível deletar este veículo pois existem ${checklistCount} checklist(s) associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir checklists para outro veículo (recomendado)\n` +
        `• Deletar checklists pendentes antes de deletar`,
    );
  }
}

export { VehicleHasAssociatedChecklistsError };

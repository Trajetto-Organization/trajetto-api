class ChecklistNotFoundError extends Error {
  constructor() {
    super("Checklist não encontrado ou não pertence a esta empresa.");
  }
}

export { ChecklistNotFoundError };

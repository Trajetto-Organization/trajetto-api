class ServiceOrderCompletionDateCannotBeEarlierOrderError extends Error {
  constructor() {
    super(
      "A data de conclusão não pode ser anterior à data da ordem de serviço",
    );
  }
}

export { ServiceOrderCompletionDateCannotBeEarlierOrderError };

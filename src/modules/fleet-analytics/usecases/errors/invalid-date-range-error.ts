class InvalidDateRangeError extends Error {
  constructor() {
    super(
      "Intervalo de datas inválido! A data final deve ser maior que a data inicial.",
    );
  }
}

export { InvalidDateRangeError };

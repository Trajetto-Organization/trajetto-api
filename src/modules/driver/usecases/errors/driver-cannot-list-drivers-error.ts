class DriverCannotListDriversError extends Error {
  constructor() {
    super(
      "Motoristas não possuem permissão para visualizar a lista de motoristas.",
    );
  }
}

export { DriverCannotListDriversError };

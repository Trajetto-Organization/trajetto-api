class VehicleModelYearError extends Error {
  constructor() {
    super(
      "O ano do modelo deve ser igual ao ano de fabricação ou no máximo um ano posterior",
    );
  }
}

export { VehicleModelYearError };

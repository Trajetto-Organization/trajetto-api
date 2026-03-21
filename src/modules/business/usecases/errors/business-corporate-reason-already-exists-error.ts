class BusinessCorporateReasonAlreadyExistsError extends Error {
  constructor() {
    super("Esta razão social já foi cadastrada em uma empresa!");
  }
}

export { BusinessCorporateReasonAlreadyExistsError };

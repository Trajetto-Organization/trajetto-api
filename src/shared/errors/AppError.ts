class AppError extends Error {
  readonly message: string;
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "BAD_REQUEST") {
    super(message);

    this.message = message;
    this.statusCode = statusCode;
    this.code = code;
    this.name = "AppError";
  }
}

export { AppError };

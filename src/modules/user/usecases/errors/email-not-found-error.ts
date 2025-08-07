class EmailNotFoundError extends Error {
  constructor() {
    super(
      "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
    );
  }
}

export { EmailNotFoundError };

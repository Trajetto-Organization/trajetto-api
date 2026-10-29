import { AppError } from "@/shared/errors/AppError";

/**
 * A refusal whose body carries more than code and message (who closed, the
 * current assignee). The global handler sends only code and message, so the
 * ticket controllers spread `details` themselves (like the decision does).
 */
class SupportTicketDetailedError extends AppError {
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details: Record<string, unknown>,
  ) {
    super(message, statusCode, code);
    this.details = details;
  }
}

/**
 * The support ticket refusals (design §4.11). "Of another company" and "of
 * another driver" answer exactly like "does not exist" (decision 11.3).
 */
class SupportTicketNotFoundError extends AppError {
  constructor() {
    super("Atendimento não encontrado.", 404, "SUPPORT_TICKET_NOT_FOUND");
    this.name = "SupportTicketNotFoundError";
  }
}

class SupportTicketAssigneeNotFoundError extends AppError {
  constructor() {
    super(
      "Atendente não encontrado nesta empresa.",
      404,
      "SUPPORT_TICKET_ASSIGNEE_NOT_FOUND",
    );
    this.name = "SupportTicketAssigneeNotFoundError";
  }
}

class SupportTicketClosedError extends SupportTicketDetailedError {
  constructor(details: {
    ticketId: string;
    number: number;
    closed_at: Date | null;
  }) {
    super(
      `O atendimento #${details.number} já foi encerrado.`,
      409,
      "SUPPORT_TICKET_CLOSED",
      {
        ticketId: details.ticketId,
        number: details.number,
        closed_at: details.closed_at?.toISOString() ?? null,
      },
    );
    this.name = "SupportTicketClosedError";
  }
}

class SupportTicketAlreadyClosedError extends SupportTicketDetailedError {
  constructor(details: {
    closedBy: { id: string; name: string } | null;
    closed_at: Date | null;
    outcome: string | null;
  }) {
    super(
      details.closedBy
        ? `Este atendimento já foi encerrado por ${details.closedBy.name}.`
        : "Este atendimento já foi encerrado.",
      409,
      "SUPPORT_TICKET_ALREADY_CLOSED",
      {
        closedBy: details.closedBy,
        closed_at: details.closed_at?.toISOString() ?? null,
        outcome: details.outcome,
      },
    );
    this.name = "SupportTicketAlreadyClosedError";
  }
}

class SupportTicketAuthorizationPendingError extends AppError {
  constructor() {
    super(
      "Esta ocorrência aguarda autorização: encerre autorizando ou negando.",
      409,
      "SUPPORT_TICKET_AUTHORIZATION_PENDING",
    );
    this.name = "SupportTicketAuthorizationPendingError";
  }
}

class SupportTicketNotAuthorizationError extends AppError {
  constructor() {
    super(
      "Este atendimento não tem autorização pendente: encerre como resolvido.",
      409,
      "SUPPORT_TICKET_NOT_AUTHORIZATION",
    );
    this.name = "SupportTicketNotAuthorizationError";
  }
}

class SupportTicketAssigneeChangedError extends SupportTicketDetailedError {
  constructor(current: { id: string; name: string } | null) {
    super(
      current
        ? `Este atendimento já está com ${current.name}.`
        : "O atendente deste atendimento mudou. Atualize e tente de novo.",
      409,
      "SUPPORT_TICKET_ASSIGNEE_CHANGED",
      { assignee: current },
    );
    this.name = "SupportTicketAssigneeChangedError";
  }
}

class SupportTicketLegacyReadOnlyError extends AppError {
  constructor() {
    super(
      "A conversa anterior aos atendimentos não pode ser reaberta. Abra um novo atendimento com o motorista.",
      409,
      "SUPPORT_TICKET_LEGACY_READ_ONLY",
    );
    this.name = "SupportTicketLegacyReadOnlyError";
  }
}

class SupportTicketContextConflictError extends AppError {
  constructor() {
    super(
      "Escolha uma entrega ou uma rota, não as duas.",
      400,
      "SUPPORT_TICKET_CONTEXT_CONFLICT",
    );
    this.name = "SupportTicketContextConflictError";
  }
}

class SupportTicketSubjectRequiredError extends AppError {
  constructor() {
    super(
      "Informe o assunto do atendimento.",
      400,
      "SUPPORT_TICKET_SUBJECT_REQUIRED",
    );
    this.name = "SupportTicketSubjectRequiredError";
  }
}

class IdempotencyKeyRequiredError extends AppError {
  constructor() {
    super(
      "O header Idempotency-Key é obrigatório para abrir um atendimento.",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    this.name = "IdempotencyKeyRequiredError";
  }
}

/** The vendor's seat reads every company and writes in none. */
class MasterChatReadOnlyError extends AppError {
  constructor() {
    super(
      "O chat é a voz da operação da empresa. O acesso master é somente de leitura.",
      403,
      "MASTER_CHAT_READ_ONLY",
    );
    this.name = "MasterChatReadOnlyError";
  }
}

class DriverChatOwnThreadError extends AppError {
  constructor() {
    super(
      "Motoristas conversam apenas com a operação da própria empresa.",
      403,
      "DRIVER_CHAT_OWN_THREAD",
    );
    this.name = "DriverChatOwnThreadError";
  }
}

export {
  SupportTicketDetailedError,
  SupportTicketNotFoundError,
  SupportTicketAssigneeNotFoundError,
  SupportTicketClosedError,
  SupportTicketAlreadyClosedError,
  SupportTicketAuthorizationPendingError,
  SupportTicketNotAuthorizationError,
  SupportTicketAssigneeChangedError,
  SupportTicketLegacyReadOnlyError,
  SupportTicketContextConflictError,
  SupportTicketSubjectRequiredError,
  IdempotencyKeyRequiredError,
  MasterChatReadOnlyError,
  DriverChatOwnThreadError,
};

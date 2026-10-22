import { AppError } from "@/shared/errors/AppError";

import type { OccurrenceFormField } from "@/modules/occurrence-type/form/occurrence-form-rules";

/**
 * The answers do not satisfy the type's form (decision 6.2). The body adds
 * `field_errors` by field key, which the controller sends along: the app and
 * the panel point at the field instead of showing one sentence.
 */
class OccurrenceFormInvalidError extends AppError {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super(
      Object.values(fieldErrors)[0] ??
        "As respostas do formulário da ocorrência não são válidas.",
      400,
      "OCCURRENCE_FORM_INVALID",
    );

    this.fieldErrors = fieldErrors;
  }
}

/**
 * The form changed after the phone rendered it (the app caches the types for
 * days) and the answers no longer satisfy the current one. 409, not 400: the
 * driver's work is not wrong, it is stale — the body carries the current
 * form so the app can reopen it with the answers already typed.
 */
class OccurrenceFormOutdatedError extends AppError {
  readonly fieldErrors: Record<string, string>;
  readonly formFields: OccurrenceFormField[] | null;
  readonly formVersion: number;

  constructor(input: {
    fieldErrors: Record<string, string>;
    formFields: OccurrenceFormField[] | null;
    formVersion: number;
  }) {
    super(
      "O formulário deste tipo de ocorrência mudou desde que foi aberto. Revise as respostas e envie de novo.",
      409,
      "OCCURRENCE_FORM_OUTDATED",
    );

    this.fieldErrors = input.fieldErrors;
    this.formFields = input.formFields;
    this.formVersion = input.formVersion;
  }
}

/**
 * A driver's app built before forms (it sends no `form_version`) reporting a
 * type whose form it cannot show, with answers that do not satisfy it.
 *
 * CLIENT_OUTDATED on purpose: the code every build's outbox files as a
 * CONTRACT failure — kept on the phone, visible, and sent again by itself
 * once the app is updated — instead of a refusal on the merits the driver
 * would have to discard. The body carries the current form, so a build that
 * renders forms can reopen the frozen item and have it answered.
 */
class OccurrenceFormNeedsAppUpdateError extends AppError {
  readonly fieldErrors: Record<string, string>;
  readonly formFields: OccurrenceFormField[] | null;
  readonly formVersion: number;

  constructor(input: {
    fieldErrors: Record<string, string>;
    formFields: OccurrenceFormField[] | null;
    formVersion: number;
  }) {
    super(
      "Este tipo de ocorrência agora tem perguntas que esta versão do aplicativo não mostra. " +
        "Atualize o aplicativo Trajetto para responder e enviar — o registro continua salvo no celular.",
      400,
      "CLIENT_OUTDATED",
    );

    this.fieldErrors = input.fieldErrors;
    this.formFields = input.formFields;
    this.formVersion = input.formVersion;
  }
}

/** "Comprovante rejeitado" is written by the proof audit, never reported. */
class OccurrenceTypeNotReportableError extends AppError {
  constructor() {
    super(
      "Este tipo de ocorrência é registrado pelo sistema e não pode ser usado num relato.",
      400,
      "OCCURRENCE_TYPE_NOT_REPORTABLE",
    );
  }
}

class OccurrenceTypeInactiveError extends AppError {
  constructor() {
    super(
      "Este tipo de ocorrência está desativado e não pode ser usado em novos registros.",
      400,
      "OCCURRENCE_TYPE_INACTIVE",
    );
  }
}

/** A PAUSE type sent to the delivery report (decision 14.4). */
class OccurrenceTypeWrongCategoryError extends AppError {
  constructor(message = "Pausas são registradas pelo botão de pausa.") {
    super(message, 400, "OCCURRENCE_TYPE_WRONG_CATEGORY");
  }
}

/**
 * The installed app (contract <= 2) proving a delivery whose default type
 * now asks for what that build cannot send (design §4.7). CLIENT_OUTDATED is
 * the code its outbox files as a contract failure: the proof stays on the
 * phone and is sent again by itself after the update.
 */
class LegacyProofNeedsAppUpdateError extends AppError {
  readonly missing: Array<"signature" | "photos" | "form">;

  constructor(missing: Array<"signature" | "photos" | "form">) {
    const what = missing.map((item) =>
      item === "signature"
        ? "a assinatura"
        : item === "photos"
          ? "fotos"
          : "um formulário",
    );
    const list =
      what.length > 1
        ? `${what.slice(0, -1).join(", ")} e ${what[what.length - 1]}`
        : what[0];

    super(
      `Atualize o aplicativo Trajetto para registrar esta entrega: a empresa passou a exigir ${list}.`,
      400,
      "CLIENT_OUTDATED",
    );

    this.missing = missing;
  }
}

export {
  LegacyProofNeedsAppUpdateError,
  OccurrenceTypeWrongCategoryError,
  OccurrenceFormInvalidError,
  OccurrenceFormNeedsAppUpdateError,
  OccurrenceFormOutdatedError,
  OccurrenceTypeInactiveError,
  OccurrenceTypeNotReportableError,
};

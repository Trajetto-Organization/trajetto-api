import { describe, expect, it } from "vitest";

import {
  PAUSE_NOTE_MAX,
  PAUSE_NOTE_MIN_LENGTH,
  PAUSE_NOTE_RULE_CONTRACT,
  enforcesPauseNote,
  normalizePauseNote,
  pauseNoteTooShort,
} from "@/modules/driver-pause/rules/pause-rules";
import { PauseNoteRequiredError } from "@/modules/driver-pause/usecases/errors/driver-pause-errors";
import {
  DEFAULT_OCCURRENCE_TYPES,
  DEFAULT_PAUSE_TYPE_KEY,
  pauseTypeRequiresNote,
} from "@/shared/delivery/default-occurrence-types";
import { AppError } from "@/shared/errors/AppError";

/**
 * The reason the generic pause asks for (owner, 09/11/2026): only the seeded
 * "Outra pausa" — whatever the company renamed it to, and the legacy
 * `kind: OTHER` that lands on it — needs a note of at least 3 non-space
 * characters, and only a build whose form asks for it (contract 7 on)
 * sending at the tap is refused without one. The queue's resends carry the
 * body the driver tapped, so they are recorded as before.
 */

describe("the reason's numbers", () => {
  it("is 3 non-space characters, up to the note's 200, from contract 7", () => {
    expect(PAUSE_NOTE_MIN_LENGTH).toBe(3);
    expect(PAUSE_NOTE_MAX).toBe(200);
    expect(PAUSE_NOTE_RULE_CONTRACT).toBe(7);
  });
});

describe("pauseNoteTooShort", () => {
  it("counts the characters that are not spaces, of the cleaned note", () => {
    expect(pauseNoteTooShort(null)).toBe(true);
    expect(pauseNoteTooShort("")).toBe(true);
    expect(pauseNoteTooShort("ab")).toBe(true);
    expect(pauseNoteTooShort("a b")).toBe(true);
    expect(pauseNoteTooShort(normalizePauseNote("  a \n b  "))).toBe(true);
    expect(pauseNoteTooShort("WC")).toBe(true);

    expect(pauseNoteTooShort("WC.")).toBe(false);
    expect(pauseNoteTooShort("pneu")).toBe(false);
    expect(pauseNoteTooShort("a b c")).toBe(false);
  });
});

describe("enforcesPauseNote", () => {
  it("refuses only a direct send from contract 7 on", () => {
    expect(enforcesPauseNote({ clientContract: 7, queued: false })).toBe(true);
    expect(enforcesPauseNote({ clientContract: 8, queued: false })).toBe(true);
  });

  it("records what the offline queue sends, and every build whose form never asked", () => {
    expect(enforcesPauseNote({ clientContract: 7, queued: true })).toBe(false);
    expect(enforcesPauseNote({ clientContract: 6, queued: false })).toBe(false);
    expect(enforcesPauseNote({ clientContract: 6, queued: true })).toBe(false);
    expect(enforcesPauseNote({ clientContract: null, queued: false })).toBe(
      false,
    );
    expect(
      enforcesPauseNote({ clientContract: undefined, queued: false }),
    ).toBe(false);
    expect(enforcesPauseNote({ clientContract: null, queued: true })).toBe(
      false,
    );
  });
});

describe("pauseTypeRequiresNote", () => {
  it("asks only the seeded generic pause, the one the legacy kind OTHER lands on", () => {
    expect(DEFAULT_PAUSE_TYPE_KEY.OTHER).toBe("pause_other");
    expect(pauseTypeRequiresNote({ system_key: "pause_other" })).toBe(true);

    expect(pauseTypeRequiresNote({ system_key: "pause_meal" })).toBe(false);
    expect(pauseTypeRequiresNote({ system_key: "pause_rest" })).toBe(false);
    expect(pauseTypeRequiresNote({ system_key: "delivered_default" })).toBe(
      false,
    );
    // A company type ("Banheiro", nature OTHER) already names its reason.
    expect(pauseTypeRequiresNote({ system_key: null })).toBe(false);
  });

  it("is one seeded type, of the OTHER nature", () => {
    expect(
      DEFAULT_OCCURRENCE_TYPES.filter(pauseTypeRequiresNote).map((type) => [
        type.name,
        type.category,
        type.pause_kind,
      ]),
    ).toEqual([["Outra pausa", "PAUSE", "OTHER"]]);
  });
});

describe("PauseNoteRequiredError", () => {
  it("is a 400 with its own code and the reason's rule in the driver's words", () => {
    const error = new PauseNoteRequiredError();

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: "PAUSE_NOTE_REQUIRED",
      message:
        "Para uma pausa por outro motivo, escreva o motivo na observação, com pelo menos 3 letras.",
    });
  });
});

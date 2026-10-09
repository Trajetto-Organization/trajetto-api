import { describe, expect, it } from "vitest";

import { createQuoteSchema } from "@/schemas/create-quote-schema";

/**
 * The public quote form's message (decision 5.5).
 *
 * A browser's form post turns every line break into CRLF. The web action
 * normalises it before sending, but the endpoint is public and any other
 * client posts the raw text: "\r\n" matched the consecutive-spaces rule and a
 * two-line message came back as "espaços consecutivos". The API reads the
 * text as the web does — one line break is "\n" — and applies the multiline
 * rule: a blank line between paragraphs passes, doubled spaces and a space at
 * the end of a line do not, so both keep deciding the same (trajetto-ui
 * tests/unitaires/quote-schema-api-parity.test.ts).
 */
const lead = {
  name: "Ana Souza",
  company: "Transportes Souza",
  email: "ana@example.com",
  telephone: "(11) 91234-5678",
  fleet_size: "6-15",
};

const parse = (message: string) =>
  createQuoteSchema.safeParse({ ...lead, message });

describe("createQuoteSchema — message", () => {
  it("accepts a line break as a browser posts it (CRLF) or a lone CR", () => {
    const crlf = parse("Linha 1\r\nLinha 2");
    const cr = parse("Linha 1\rLinha 2");

    expect(crlf.success).toBe(true);
    expect(cr.success).toBe(true);
    // Stored as the web sends it: one "\n" per break.
    expect(crlf.success && crlf.data.message).toBe("Linha 1\nLinha 2");
    expect(cr.success && cr.data.message).toBe("Linha 1\nLinha 2");
  });

  it("counts the limit after the normalisation, as the web does", () => {
    // 129 + CRLF + 100 = 231 characters as posted, 230 as read.
    expect(parse(`${"a".repeat(129)}\r\n${"b".repeat(100)}`).success).toBe(true);
    expect(parse(`${"a".repeat(130)}\r\n${"b".repeat(100)}`).success).toBe(false);
  });

  it("accepts a blank line between paragraphs (decision 5.5)", () => {
    // `\s{2,}` read "\n\n" as two spaces and refused it.
    for (const [posted, stored] of [
      ["Parágrafo 1\r\n\r\nParágrafo 2", "Parágrafo 1\n\nParágrafo 2"],
      ["Parágrafo 1\n\nParágrafo 2", "Parágrafo 1\n\nParágrafo 2"],
      ["P1\n\n\nP2", "P1\n\n\nP2"],
    ]) {
      const parsed = parse(posted);

      expect(parsed.success, JSON.stringify(posted)).toBe(true);
      expect(parsed.success && parsed.data.message).toBe(stored);
    }
  });

  it("keeps refusing what the web refuses", () => {
    for (const refused of [
      "duas  palavras",
      "a\t\tb",
      "Linha 1\nLinha  2",
      " começa com espaço",
      "termina com quebra\r\n",
    ]) {
      expect(parse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });

  it("refuses a space at either end of a line, in the web's words", () => {
    for (const refused of ["Linha 1 \r\nLinha 2", "Itens:\n - um", "Linha 1\n \nLinha 2", "Linha 1\t\nLinha 2"]) {
      const parsed = parse(refused);

      expect(parsed.success, JSON.stringify(refused)).toBe(false);
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
        "As linhas da mensagem não podem começar ou terminar com espaço.",
      ]);
    }
  });

  it("treats an empty message as none", () => {
    const empty = parse("");

    expect(empty.success).toBe(true);
    expect(empty.success && empty.data.message).toBeNull();
  });
});

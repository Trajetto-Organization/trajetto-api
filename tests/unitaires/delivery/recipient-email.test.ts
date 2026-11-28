import { describe, expect, it } from "vitest";

import {
  createDeliveryBodySchema,
  createDeliverySchema,
} from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";
import {
  MAX_ENTRIES_READ,
  MAX_RECIPIENT_EMAILS,
  canonicalRecipientEmail,
  readRecipientEmails,
  recipientEmailNotice,
  storedRecipientEmail,
} from "@/shared/delivery/recipient-email";

/**
 * The recipient's e-mail as the NF-e and the spreadsheet bring it, and as
 * the customer notice reads it back.
 *
 * Both imports stored the field unchecked, and the send handed it to
 * nodemailer's address parser inside the API process: a crafted list
 * stalled it for seconds per send, a malformed one could be read as a
 * mailbox at another domain. Now the field is a list separated by ";" (the
 * NF-e's) or "," (a mail client's, which nodemailer 6 sent to as well),
 * every entry checked by the manual create's own rule, and what is left out
 * is quoted on the import row for the dispatcher to fix.
 */
function read(raw: string | null) {
  const emails = readRecipientEmails(raw);

  return {
    stored: storedRecipientEmail(emails),
    notice: recipientEmailNotice(emails),
  };
}

const notUsed = (quoted: string) =>
  `O e-mail ${quoted} do destinatário não é válido e não será usado nos avisos ao cliente.`;
const manyNotUsed = (quoted: string) =>
  `Os e-mails ${quoted} do destinatário não são válidos e não serão usados nos avisos ao cliente.`;
const OVERFLOW = `Só os ${MAX_RECIPIENT_EMAILS} primeiros e-mails válidos do destinatário serão usados nos avisos ao cliente.`;
const TRUNCATED = `O campo de e-mail do destinatário tem itens demais: só os ${MAX_ENTRIES_READ} primeiros foram lidos.`;

describe("a recipient e-mail field", () => {
  it("is one address, kept as written", () => {
    expect(read("  Compras@Mercado.com.br ")).toEqual({
      stored: "Compras@Mercado.com.br",
      notice: null,
    });
  });

  it("is several, separated by ';' as an NF-e writes them", () => {
    expect(
      read("compras@mercado.com.br; financeiro@mercado.com.br ;;"),
    ).toEqual({
      stored: "compras@mercado.com.br;financeiro@mercado.com.br",
      notice: null,
    });
  });

  it("is several, separated by ',' as a mail client writes them, stored with ';'", () => {
    // nodemailer 6 sent to both: a release that silenced these lists would
    // stop customer notices nobody asked to stop.
    expect(read("compras@mercado.com.br, financeiro@mercado.com.br,")).toEqual({
      stored: "compras@mercado.com.br;financeiro@mercado.com.br",
      notice: null,
    });
    expect(read("a@mercado.com.br;b@mercado.com.br,c@mercado.com.br")).toEqual({
      stored: "a@mercado.com.br;b@mercado.com.br;c@mercado.com.br",
      notice: null,
    });
  });

  it("keeps an address typed twice once (mailbox providers ignore the case)", () => {
    expect(read("compras@mercado.com.br;COMPRAS@mercado.com.br")).toEqual({
      stored: "compras@mercado.com.br",
      notice: null,
    });
  });

  it("leaves out what is not an address, and quotes it", () => {
    expect(read("compras@mercado.com.br;mercado.com.br")).toEqual({
      stored: "compras@mercado.com.br",
      notice: notUsed('"mercado.com.br"'),
    });
  });

  it("stores nothing when nothing in it is an address, and quotes what it was", () => {
    expect(read("não informado")).toEqual({
      stored: null,
      notice: notUsed('"não informado"'),
    });
  });

  it("quotes two left-out entries, then counts the others, the same mistake once", () => {
    expect(read("x@;y;X@;bom@mercado.com.br").notice).toBe(
      manyNotUsed('"x@" e "y"'),
    );
    expect(read("a@;b@;c@;d@;bom@mercado.com.br").notice).toBe(
      manyNotUsed('"a@", "b@" e outros 2'),
    );
  });

  it("quotes a long entry cut, on one line", () => {
    const entry = `Comprador\nda loja ${"x".repeat(60)}`;
    const quoted = readRecipientEmails(entry).rejected[0];

    expect(quoted).toBe(`Comprador da loja ${"x".repeat(22)}…`);
    expect(Array.from(quoted)).toHaveLength(41);
    // Whole code points: an emoji is never split in half.
    expect(readRecipientEmails(`${"😀".repeat(50)}`).rejected[0]).toBe(
      `${"😀".repeat(40)}…`,
    );
  });

  it("is nothing, quietly, when empty or only separators", () => {
    for (const raw of [null, "", "  ", ";", " ; ;", ",, ;"]) {
      expect(read(raw), JSON.stringify(raw)).toEqual({
        stored: null,
        notice: null,
      });
    }
  });

  it(`uses the first ${MAX_RECIPIENT_EMAILS} valid addresses, and says the rest was left out`, () => {
    const many = Array.from(
      { length: MAX_RECIPIENT_EMAILS + 2 },
      (_, index) => `pessoa${index}@mercado.com.br`,
    );

    const emails = readRecipientEmails(many.join(";"));

    expect(emails.addresses).toEqual(many.slice(0, MAX_RECIPIENT_EMAILS));
    expect(recipientEmailNotice(emails)).toBe(OVERFLOW);
  });

  it("says both when it lost an invalid entry and the ones past the limit", () => {
    const raw = [
      "x@",
      ...Array.from(
        { length: MAX_RECIPIENT_EMAILS + 1 },
        (_, index) => `pessoa${index}@mercado.com.br`,
      ),
    ].join(";");

    expect(read(raw).notice).toBe(`${notUsed('"x@"')} ${OVERFLOW}`);
  });

  it(`says the field was cut when it has more than ${MAX_ENTRIES_READ} entries, never that there were more than ${MAX_RECIPIENT_EMAILS} addresses`, () => {
    // One address repeated: one recipient, nothing past the limit.
    expect(read("x@mercado.com.br;".repeat(25))).toEqual({
      stored: "x@mercado.com.br",
      notice: TRUNCATED,
    });

    // Three addresses behind a run of mistakes: the field was cut, that is all.
    const raw = [
      "a@mercado.com.br",
      "b@mercado.com.br",
      "c@mercado.com.br",
      ...Array.from({ length: 30 }, (_, index) => `erro${index}@`),
    ].join(";");

    expect(read(raw)).toEqual({
      stored: "a@mercado.com.br;b@mercado.com.br;c@mercado.com.br",
      notice: `${manyNotUsed('"erro0@", "erro1@" e outros 15')} ${TRUNCATED}`,
    });
  });

  it("does not count blanks between separators as entries", () => {
    // Twenty-odd separators before the address: it is still read.
    expect(read(`${";".repeat(30)} , ;pessoa@mercado.com.br`)).toEqual({
      stored: "pessoa@mercado.com.br",
      notice: null,
    });
  });
});

describe("each entry is checked like the manual create", () => {
  // The same field, not a copy of it: whatever the panel refuses for one
  // address, the imports leave out of a list.
  const manual = createDeliverySchema.shape.recipient_email;

  const samples = [
    "pessoa@mercado.com.br",
    "pessoa.nome+tag@sub.mercado.com.br",
    "pessoa@mercado",
    "pessoa@@mercado.com.br",
    "pessoa @mercado.com.br",
    "pessoa@mercado..com.br",
    "Nome <pessoa@mercado.com.br>",
    '"pessoa"@mercado.com.br',
    `${"a".repeat(85)}@mercado.com.br`,
    `${"a".repeat(86)}@mercado.com.br`,
  ];

  it.each(samples)("%s", (sample) => {
    expect(readRecipientEmails(sample).addresses.length === 1).toBe(
      manual.safeParse(sample).success,
    );
  });

  it("never holds a separator, so splitting on one never cuts an address", () => {
    for (const sample of [
      "pessoa,outra@mercado.com.br",
      "a;b@mercado.com.br",
    ]) {
      expect(manual.safeParse(sample).success, sample).toBe(false);
    }
  });
});

describe("the panel's create and edit of the field", () => {
  // The same field on both bodies: the web's one form sends the whole value.
  const doors = [
    // zod 4 keeps the refinement on the object: no wrapper to unwrap.
    ["create", createDeliveryBodySchema.shape.recipient_email],
    ["edit", updateDeliverySchema.shape.recipient_email],
  ] as const;

  const messageOf = (field: (typeof doors)[number][1], value: string) => {
    const parsed = field.safeParse(value);

    return parsed.success ? null : parsed.error.issues[0]?.message;
  };

  it.each(doors)(
    "%s: takes one address, or the list an import stored, as stored",
    (_door, field) => {
      for (const value of [
        "compras@mercado.com.br;financeiro@mercado.com.br",
        "compras@mercado.com.br",
      ]) {
        expect(field.safeParse(value), value).toMatchObject({
          success: true,
          data: value,
        });
      }

      // Cleared, as before.
      expect(field.parse("")).toBeNull();
      expect(field.parse(null)).toBeNull();
    },
  );

  it.each(doors)(
    "%s: stores a typed list as the imports do: joined by ';', once each",
    (_door, field) => {
      expect(
        field.parse(" compras@mercado.com.br, financeiro@mercado.com.br ; "),
      ).toBe("compras@mercado.com.br;financeiro@mercado.com.br");
      expect(field.parse("Compras@Mercado.com.br;compras@mercado.com.br")).toBe(
        "Compras@Mercado.com.br",
      );
    },
  );

  it.each(doors)(
    "%s: refuses the whole value, with the one-address sentence, when an entry is not an address",
    (_door, field) => {
      expect(
        messageOf(field, "compras@mercado.com.br;financeiro@mercado"),
      ).toBe("O e-mail do destinatário não é válido.");
      expect(
        messageOf(field, `compras@mercado.com.br;${"a".repeat(95)}@x.com`),
      ).toBe("O e-mail deve ter no máximo 100 caracteres.");
      expect(messageOf(field, " ; ")).toBe(
        "O e-mail do destinatário não é válido.",
      );
      // The display name a mail client pastes is not an address here either.
      expect(messageOf(field, "Compras <compras@mercado.com.br>")).toBe(
        "O e-mail do destinatário não é válido.",
      );
    },
  );

  it.each(doors)(
    `%s: refuses more than ${MAX_RECIPIENT_EMAILS} addresses`,
    (_door, field) => {
      const many = Array.from(
        { length: MAX_RECIPIENT_EMAILS + 1 },
        (_, index) => `pessoa${index}@mercado.com.br`,
      ).join(";");

      expect(messageOf(field, many)).toBe(
        `Informe no máximo ${MAX_RECIPIENT_EMAILS} e-mails do destinatário.`,
      );
      expect(messageOf(field, "a".repeat(100_000))).toBe(
        `Informe no máximo ${MAX_RECIPIENT_EMAILS} e-mails do destinatário, de até 100 caracteres cada.`,
      );
    },
  );

  it.each(doors)(
    "%s: measures the value in UTF-16 units, so emoji never slip past the entries",
    (_door, field) => {
      // zod 4's max() counts code points: 260 emoji are 520 units. They
      // passed it and were stored as "", or let an entry that is not an
      // address go silently.
      const emoji = "\u{1F600}";

      for (const value of [
        emoji.repeat(260),
        `compras@mercado.com.br;${emoji.repeat(300)}`,
      ]) {
        expect(messageOf(field, value)).toBe(
          `Informe no máximo ${MAX_RECIPIENT_EMAILS} e-mails do destinatário, de até 100 caracteres cada.`,
        );
      }
    },
  );

  it("parses what it stored back to the same value (the route validates, the controller parses again)", () => {
    const [, field] = doors[0];
    const stored = field.parse("a@mercado.com.br, b@mercado.com.br");

    expect(field.parse(stored)).toBe(stored);
  });

  it("leaves the integration API at one address: its body derives from the field object", () => {
    expect(
      createDeliverySchema.shape.recipient_email.safeParse(
        "compras@mercado.com.br;financeiro@mercado.com.br",
      ).success,
    ).toBe(false);
  });
});

describe("two values compared as recipients", () => {
  it("are the same when the send would write to the same addresses", () => {
    expect(canonicalRecipientEmail("a@mercado.com.br, b@mercado.com.br")).toBe(
      canonicalRecipientEmail("a@mercado.com.br;b@mercado.com.br"),
    );
    expect(canonicalRecipientEmail("a@mercado.com.br;lixo")).toBe(
      "a@mercado.com.br",
    );
    expect(canonicalRecipientEmail("lixo")).toBeNull();
    expect(canonicalRecipientEmail(null)).toBeNull();
  });
});

describe("the work a field can make the import or the send do", () => {
  // GHSA-2x7j-588g-ccc2 and GHSA-rcmh-qjqh-p98v: the shapes that stalled or
  // crashed the address parser, each as one field.
  const hostile = [
    "a,".repeat(40_000),
    "g:".repeat(5_000),
    `${"a".repeat(1_000_000)}@x.com`,
    ";".repeat(1_000_000),
    " ;,".repeat(500_000),
    "pessoa@mercado.com.br;".repeat(100_000),
    "x@;".repeat(100_000),
  ];

  it.each(hostile.map((raw) => [raw.slice(0, 12), raw]))(
    "stays bounded for %s…",
    (_label, raw) => {
      const startedAt = performance.now();
      const emails = readRecipientEmails(raw);
      const notice = recipientEmailNotice(emails);
      const elapsed = performance.now() - startedAt;

      expect(emails.addresses.length).toBeLessThanOrEqual(1);
      // The note quotes at most two short entries, however long the field.
      expect((notice ?? "").length).toBeLessThan(400);
      // Microseconds of work; the bound only catches a return of the
      // quadratic or recursive parse.
      expect(elapsed).toBeLessThan(500);
    },
  );
});

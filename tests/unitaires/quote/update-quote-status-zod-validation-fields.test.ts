import { describe, it, expect } from "vitest";
import { updateQuoteStatusSchema } from "@/schemas/update-quote-status-schema";

describe("Update Quote Status Zod Validation Fields", () => {
  describe("status field validation", () => {
    it("should accept all valid status values", () => {
      const validStatuses = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"];

      validStatuses.forEach((status) => {
        const data = { status };
        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.status).toBe(status);
        }
      });
    });

    it("should reject invalid status values", () => {
      const invalidStatuses = [
        "INVALID",
        "pending", // lowercase
        "contacted", // lowercase
        "COMPLETE",
        "ACTIVE",
        "INACTIVE",
        "OPEN",
        "FINISHED",
        "",
        123,
        true,
        null,
        undefined,
      ];

      invalidStatuses.forEach((status) => {
        const data = { status };
        const result = updateQuoteStatusSchema.safeParse(data);

        expect(result.success).toBe(false);
      });
    });

    it("should be case sensitive for status", () => {
      const caseVariations = [
        "pending",
        "Pending",
        "PENDING ", // with trailing space
        " PENDING", // with leading space
        "contacted",
        "Contacted",
        "closed",
        "Closed",
        "converted",
        "Converted",
      ];

      caseVariations.forEach((status) => {
        const data = { status };
        const result = updateQuoteStatusSchema.safeParse(data);

        // Only exact uppercase matches should pass
        if (["PENDING", "CONTACTED", "CLOSED", "CONVERTED"].includes(status)) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      });
    });

    it("should require status field", () => {
      const data = { notes: "Test note" };
      const result = updateQuoteStatusSchema.safeParse(data);

      expect(result.success).toBe(false);
    });
  });

  describe("notes field validation", () => {
    it("should accept valid notes", () => {
      const validNotes = [
        "Customer contacted by phone",
        "Email sent to customer",
        "Quote converted to sale",
        "Customer decided not to proceed",
        "Follow up scheduled for next week",
        "Sent detailed proposal with pricing",
      ];

      validNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.notes).toBe(notes);
        }
      });
    });

    it("should accept empty notes", () => {
      const data = {
        status: "CONTACTED",
        notes: "",
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.notes).toBe("");
      }
    });

    it("should make notes field optional", () => {
      const data = {
        status: "CONTACTED",
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.notes).toBeUndefined();
      }
    });

    it("should accept notes with maximum 500 characters", () => {
      const maxLengthNotes = "A".repeat(500);
      const data = {
        status: "CONTACTED",
        notes: maxLengthNotes,
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.notes).toBe(maxLengthNotes);
        expect(result.data.notes?.length).toBe(500);
      }
    });

    it("should reject notes with more than 500 characters", () => {
      const tooLongNotes = "A".repeat(501);
      const data = {
        status: "CONTACTED",
        notes: tooLongNotes,
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "As notas devem ter no máximo 500 caracteres",
        );
      }
    });

    it("should reject notes with consecutive spaces", () => {
      const invalidNotes = [
        "Customer  contacted by phone",
        "Email   sent to customer",
        "Quote    converted to sale",
        "Customer     decided not to proceed",
        "Multiple  spaces  everywhere",
      ];

      invalidNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(false);

        if (!result.success) {
          expect(result.error.issues[0].message).toBe(
            "O nome da nota não deve conter espaços consecutivos.",
          );
        }
      });
    });

    it("should reject notes with spaces at edges", () => {
      const invalidNotes = [
        " Customer contacted",
        "Email sent ",
        " Quote converted ",
        "  Customer decided",
        "Follow up scheduled  ",
      ];

      invalidNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(false);

        if (!result.success) {
          // The schema might trigger different validation errors first
          const errorMessage = result.error.issues[0].message;
          expect([
            "O nome da nota não pode começar ou terminar com espaço em branco.",
            "O nome da nota não deve conter espaços consecutivos.",
          ]).toContain(errorMessage);
        }
      });
    });

    it("should accept notes with special characters", () => {
      const validNotes = [
        "Customer contacted via email (success@company.com)",
        "Quote #12345 sent with 15% discount",
        "Meeting scheduled for 2024-01-15 @ 10:00 AM",
        "Customer needs 30-50 vehicles by Q2/2024",
        "Price: $50,000 - $75,000 range discussed",
        "Follow-up: call back in 2-3 weeks",
      ];

      validNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.notes).toBe(notes);
        }
      });
    });

    it("should accept notes with accented characters", () => {
      const accentedNotes = [
        "Cliente contatado por telefone",
        "E-mail enviado para o cliente",
        "Orçamento convertido em venda",
        "Cliente decidiu não prosseguir",
        "Reunião agendada para próxima semana",
      ];

      accentedNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.notes).toBe(notes);
        }
      });
    });

    it("should accept notes with line breaks", () => {
      const notesWithLineBreaks = `Customer contacted via phone.
Discussion about fleet management needs.
Proposal to be sent by Friday.`;

      const data = {
        status: "CONTACTED",
        notes: notesWithLineBreaks,
      };
      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notes).toBe(notesWithLineBreaks);
      }
    });

    it("should reject non-string notes", () => {
      const invalidNotes = [123, true, [], {}, null];

      invalidNotes.forEach((notes) => {
        const data = {
          status: "CONTACTED",
          notes,
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });
  });

  describe("combined field validation", () => {
    it("should accept valid status and notes combination", () => {
      const validCombinations = [
        {
          status: "PENDING",
          notes: "Reverted to pending status for review",
        },
        {
          status: "CONTACTED",
          notes: "Customer contacted by phone and email",
        },
        {
          status: "CLOSED",
          notes: "Customer decided not to proceed at this time",
        },
        {
          status: "CONVERTED",
          notes: "Quote successfully converted to active customer",
        },
      ];

      validCombinations.forEach((data) => {
        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.status).toBe(data.status);
          expect(result.data.notes).toBe(data.notes);
        }
      });
    });

    it("should accept status without notes", () => {
      const statuses = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"];

      statuses.forEach((status) => {
        const data = { status };
        const result = updateQuoteStatusSchema.safeParse(data);

        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.status).toBe(status);
          expect(result.data.notes).toBeUndefined();
        }
      });
    });

    it("should accept status with empty notes", () => {
      const data = {
        status: "CONTACTED",
        notes: "",
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.status).toBe("CONTACTED");
        expect(result.data.notes).toBe("");
      }
    });

    it("should handle all status transitions with appropriate notes", () => {
      const transitions = [
        {
          status: "PENDING",
          notes: "New quote request received and needs initial review",
        },
        {
          status: "CONTACTED",
          notes: "Initial contact made with potential customer via phone",
        },
        {
          status: "CLOSED",
          notes: "Customer declined the quote after price discussion",
        },
        {
          status: "CONVERTED",
          notes: "Customer accepted proposal and signed the contract",
        },
      ];

      transitions.forEach((data) => {
        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.status).toBe(data.status);
          expect(result.data.notes).toBe(data.notes);
        }
      });
    });

    it("should reject invalid status even with valid notes", () => {
      const data = {
        status: "INVALID_STATUS",
        notes: "This is a valid note but status is invalid",
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("should reject valid status with invalid notes", () => {
      const invalidNotesData = [
        {
          status: "CONTACTED",
          notes: " Leading space note",
        },
        {
          status: "CLOSED",
          notes: "Trailing space note ",
        },
        {
          status: "CONVERTED",
          notes: "Double  space note",
        },
        {
          status: "PENDING",
          notes: "A".repeat(501), // Too long
        },
      ];

      invalidNotesData.forEach((data) => {
        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });

    it("should maintain type safety", () => {
      const data = {
        status: "CONTACTED",
        notes: "Test note",
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        // TypeScript should infer correct types
        const status: "PENDING" | "CONTACTED" | "CLOSED" | "CONVERTED" =
          result.data.status;
        const notes: string | undefined = result.data.notes;

        expect(typeof status).toBe("string");
        expect(typeof notes).toBe("string");
        expect(["PENDING", "CONTACTED", "CLOSED", "CONVERTED"]).toContain(
          status,
        );
      }
    });
  });

  describe("edge cases", () => {
    it("should handle object with only status", () => {
      const data = { status: "CONTACTED" };
      const result = updateQuoteStatusSchema.safeParse(data);

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.status).toBe("CONTACTED");
        expect(result.data).not.toHaveProperty("notes");
      }
    });

    it("should reject empty object", () => {
      const data = {};
      const result = updateQuoteStatusSchema.safeParse(data);

      expect(result.success).toBe(false);
    });

    it("should handle extra properties", () => {
      const data = {
        status: "CONTACTED",
        notes: "Valid note",
        extraField: "should be ignored",
        anotherField: 123,
      };

      const result = updateQuoteStatusSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data).not.toHaveProperty("extraField");
        expect(result.data).not.toHaveProperty("anotherField");

        expect(result.data.status).toBe("CONTACTED");
        expect(result.data.notes).toBe("Valid note");
      }
    });

    it("should handle null and undefined values", () => {
      const invalidData = [
        { status: null, notes: "Valid note" },
        { status: undefined, notes: "Valid note" },
        { status: "CONTACTED", notes: null },
      ];

      invalidData.forEach((data) => {
        const result = updateQuoteStatusSchema.safeParse(data);
        if (data.status === null || data.status === undefined) {
          expect(result.success).toBe(false);
        } else if (data.notes === null) {
          expect(result.success).toBe(false);
        }
      });
    });

    it("should handle extreme note lengths", () => {
      const testCases = [
        { length: 499, shouldPass: true },
        { length: 500, shouldPass: true },
        { length: 501, shouldPass: false },
        { length: 1000, shouldPass: false },
      ];

      testCases.forEach(({ length, shouldPass }) => {
        const data = {
          status: "CONTACTED",
          notes: "A".repeat(length),
        };

        const result = updateQuoteStatusSchema.safeParse(data);
        expect(result.success).toBe(shouldPass);
      });
    });
  });
});

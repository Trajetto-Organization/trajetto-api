import { z } from "zod";

const CHAT_MESSAGE_MAX_LENGTH = 2000;

/** 15 minutes of voice note — far beyond any real one, cheap to allow. */
/**
 * The ceiling for a voice note.
 *
 * It was fifteen minutes, which is not an operational message — it is a
 * meeting. Nobody at the SAC listens to it, and the driver would only find
 * out about the limit by being refused after speaking. Two minutes is long
 * enough to explain a wrong address, an absent customer or damaged cargo,
 * and short enough that the note gets played.
 *
 * Enforced here because a client-side limit is a courtesy, not a control:
 * duration arrives from the client and this is the only place that can
 * refuse it.
 */
const CHAT_AUDIO_MAX_DURATION_MS = 2 * 60 * 1000;

const sendChatMessageSchema = z
  .object({
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe(
        "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
      ),

    // One driver = a conversation; several = a mass notice fanned out as an
    // individual message per thread (same broadcast id).
    driverIds: z
      .array(z.string().uuid("ID de motorista inválido."))
      .min(1, "Informe ao menos um motorista.")
      .max(50, "No máximo 50 motoristas por aviso em massa."),

    kind: z.enum(["TEXT", "IMAGE", "AUDIO"], {
      errorMap: () => ({ message: "Tipo de mensagem inválido." }),
    }),

    body: z
      .string()
      .trim()
      .max(
        CHAT_MESSAGE_MAX_LENGTH,
        `A mensagem deve ter no máximo ${CHAT_MESSAGE_MAX_LENGTH} caracteres.`,
      )
      .optional()
      .describe("O texto — ou a legenda, quando há anexo."),

    attachmentKey: z
      .string()
      .max(512)
      .optional()
      .describe("Chave devolvida pelo upload presigned (chatAttachments)."),

    durationMs: z
      .number({ invalid_type_error: "Duração do áudio inválida." })
      .int()
      .positive()
      .max(CHAT_AUDIO_MAX_DURATION_MS, "O áudio pode ter no máximo 2 minutos.")
      .optional(),

    deliveryId: z
      .string()
      .uuid("ID da entrega é inválido.")
      .optional()
      .describe("Chip de contexto: sobre qual entrega é a mensagem."),

    clientSubmissionId: z
      .string()
      .uuid("Identificador de envio inválido.")
      .optional()
      .describe("Âncora de idempotência: o retry nunca duplica a mensagem."),
  })
  .superRefine((message, ctx) => {
    if (message.kind === "TEXT" && !message.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "Uma mensagem de texto precisa de texto.",
      });
    }

    if (message.kind !== "TEXT" && !message.attachmentKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachmentKey"],
        message: "Mensagens com mídia precisam do anexo enviado antes.",
      });
    }

    if (message.kind === "AUDIO" && !message.durationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "Áudio precisa da duração para o player.",
      });
    }

    if (message.driverIds.length > 1) {
      // A mass notice is N independent messages: a shared idempotency key
      // would collide across them, and "about this delivery" only makes
      // sense inside one driver's conversation.
      if (message.clientSubmissionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clientSubmissionId"],
          message: "Idempotência por envio vale só para conversa individual.",
        });
      }

      if (message.deliveryId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliveryId"],
          message: "Aviso em massa não referencia uma entrega específica.",
        });
      }
    }
  });

export {
  sendChatMessageSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_AUDIO_MAX_DURATION_MS,
};

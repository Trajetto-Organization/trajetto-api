import { z } from "zod";

const CHAT_MESSAGE_MAX_LENGTH = 2000;

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

/** Hand-picked recipients of one notice; "everyone" has its own audience. */
const CHAT_BROADCAST_MAX_SELECTED = 50;

/**
 * The resolved audience "todos os motoristas ativos com o app" (decision
 * 6.8), sent as one notice. Above it the notice is refused rather than
 * holding one HTTP request for minutes: each driver is a transaction of its
 * own, with its own push.
 */
const CHAT_BROADCAST_MAX_AUDIENCE = 500;

const CHAT_AUDIENCES = ["ALL_ACTIVE_WITH_APP"] as const;

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
    // individual message per thread (same broadcast id). Repeated ids are
    // one recipient: without the dedupe the same driver got the notice twice.
    driverIds: z
      .array(z.string().uuid("ID de motorista inválido."))
      // A loose bound on the raw list only caps the work; the rule is the
      // count of DISTINCT drivers below. Counted before the dedupe, 50
      // drivers plus one repeat was refused although it names only 50.
      .max(
        CHAT_BROADCAST_MAX_SELECTED * 2,
        `No máximo ${CHAT_BROADCAST_MAX_SELECTED} motoristas por aviso em massa.`,
      )
      .transform((ids) => [...new Set(ids)])
      .refine((ids) => ids.length <= CHAT_BROADCAST_MAX_SELECTED, {
        message: `No máximo ${CHAT_BROADCAST_MAX_SELECTED} motoristas por aviso em massa.`,
      })
      .optional()
      .describe(
        "Os motoristas escolhidos. Ids repetidos contam uma vez. Omitido quando `audience` é enviado.",
      ),

    audience: z
      .enum(CHAT_AUDIENCES, {
        errorMap: () => ({ message: "Público do aviso inválido." }),
      })
      .optional()
      .describe(
        `ALL_ACTIVE_WITH_APP: todos os motoristas ativos com conta no aplicativo, resolvidos no servidor (até ${CHAT_BROADCAST_MAX_AUDIENCE}). Exige o header Idempotency-Key.`,
      ),

    routeId: z
      .string()
      .uuid("ID da rota é inválido.")
      .optional()
      .describe(
        "A rota sobre a qual é a mensagem. Ausente, a API usa a rota da entrega citada ou a rota em andamento do motorista.",
      ),

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

    // Decision 14.5. Without it, a one-driver message goes through the
    // legacy routing (clients that predate the tickets).
    ticketId: z
      .string()
      .uuid("ID do atendimento é inválido.")
      .optional()
      .describe(
        "O atendimento (ticket) da mensagem. Ausente numa mensagem para um motorista, a API escolhe o atendimento pelo roteamento legado (resposta recente da central, entrega, rota, conversa geral).",
      ),
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

    const selected = message.driverIds?.length ?? 0;

    // Exactly one way of naming the recipients.
    if (message.audience && selected > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audience"],
        message: "Escolha os motoristas ou o público do aviso, não os dois.",
      });
    }

    if (!message.audience && selected === 0 && !message.ticketId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["driverIds"],
        message: "Informe ao menos um motorista.",
      });
    }

    if (message.audience || selected > 1) {
      // A mass notice is N independent messages: a shared idempotency key
      // would collide across them, and "about this delivery" or "about this
      // route" only makes sense inside one driver's conversation.
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

      if (message.routeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routeId"],
          message: "Aviso em massa não referencia uma rota específica.",
        });
      }

      if (message.ticketId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ticketId"],
          message: "Aviso em massa não pertence a um atendimento.",
        });
      }
    }
  });

export {
  sendChatMessageSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_AUDIO_MAX_DURATION_MS,
  CHAT_BROADCAST_MAX_SELECTED,
  CHAT_BROADCAST_MAX_AUDIENCE,
  CHAT_AUDIENCES,
};

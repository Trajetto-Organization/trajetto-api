import { SERVICE_BUSY_RETRY_AFTER_SECONDS } from "@/shared/errors/database-error-map";

/**
 * The 503 SERVICE_BUSY in the published words (plano-escala U-13): a lock
 * wait or a statement that ran past its ceiling. Every 503 that lists
 * SERVICE_UNAVAILABLE lists this one too, because any route that reaches
 * the database can meet either (shared/errors/database-error-map.ts).
 */
const SERVICE_BUSY_DESCRIPTION = `SERVICE_BUSY: o banco de dados está ocupado e a espera passou do limite (um registro disputado por outro pedido, ou uma consulta longa). Transitório: espere o \`retry-after\` (${SERVICE_BUSY_RETRY_AFTER_SECONDS} s) e repita; traz \`requestId\`.`;

export { SERVICE_BUSY_DESCRIPTION };

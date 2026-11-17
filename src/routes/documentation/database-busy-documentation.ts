import { SERVICE_BUSY_RETRY_AFTER_SECONDS } from "@/shared/errors/database-error-map";
import {
  POSITIONS_SHED_RETRY_AFTER_SECONDS,
  SHED_RETRY_AFTER_SECONDS,
} from "@/shared/http/load-shedding";

/**
 * The 503 SERVICE_BUSY in the published words (plano-escala U-13): a lock
 * wait or a statement that ran past its ceiling. Every 503 that lists
 * SERVICE_UNAVAILABLE lists this one too, because any route that reaches
 * the database can meet either (shared/errors/database-error-map.ts).
 */
const SERVICE_BUSY_DESCRIPTION = `SERVICE_BUSY: o banco de dados está ocupado e a espera passou do limite (um registro disputado por outro pedido, ou uma consulta longa). Transitório: espere o \`retry-after\` (${SERVICE_BUSY_RETRY_AFTER_SECONDS} s) e repita; traz \`requestId\`.`;

/**
 * The same code from load shedding (plano-escala F2-24): with
 * SHED_MODE=enforce, a pressed replica answers a route that is not critical
 * before anything runs. Merged last into each such route's 503
 * (openapi-transform.ts), so a route that already explains SERVICE_BUSY
 * keeps its own words; the session's 503 adds the sentence below.
 */
const LOAD_SHED_DESCRIPTION = `SERVICE_BUSY: o servidor está sobrecarregado e recusou o pedido antes de fazer qualquer coisa (descarte de carga). Transitório: espere o \`retry-after\` (${SHED_RETRY_AFTER_SECONDS} s; ${POSITIONS_SHED_RETRY_AFTER_SECONDS} s no envio de posições) e repita.`;

const LOAD_SHED_NOTE = `Com o servidor sobrecarregado, SERVICE_BUSY também chega antes de qualquer coisa ser feita (descarte de carga), com \`retry-after\` de ${SHED_RETRY_AFTER_SECONDS} s (${POSITIONS_SHED_RETRY_AFTER_SECONDS} s no envio de posições).`;

export { LOAD_SHED_DESCRIPTION, LOAD_SHED_NOTE, SERVICE_BUSY_DESCRIPTION };

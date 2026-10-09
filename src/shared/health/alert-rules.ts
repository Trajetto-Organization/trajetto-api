import { isCredentialFailure } from "@/shared/notifications/delivery-diagnostics";

/**
 * When the operation must be woken up (OBS-03). Pure: the ops heartbeat job
 * gathers an OperationalSnapshot, these rules turn it into reasons, and an
 * empty list is the only "all is well".
 *
 * Every lag here is ELIGIBLE lag — how long something already due has waited
 * to be taken — never age from creation. A delivery legitimately waits up to
 * three hours between attempts and a webhook up to six (backoff); measured
 * from created_at those are "stuck" on every provider hiccup and every
 * customer endpoint that is down, and an alert that cries wolf is switched
 * off. What eligible lag cannot see — a retry storm, where everything is in
 * backoff and failing — is covered by the terminal-failure rules instead.
 */

interface CronJobState {
  job: string;
  lastStatus: "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  lastSucceededAt: Date | null;

  /** RUNNING rows whose lease ran out: a run whose replica died mid-way. */
  staleRunning: number;
}

interface OperationalSnapshot {
  now: Date;

  /** Oldest PENDING outbox event already due; null when nothing is due. */
  outboxEligibleLagSec: number | null;

  /** Oldest PENDING delivery already due, per lane. */
  deliveryEligibleLagSec: { internal: number | null; external: number | null };

  /** Oldest due webhook not yet sent (held/backoff rows are not due). */
  webhookDueLagSec: number | null;

  /** Oldest PENDING AI analysis already due. */
  aiEligibleLagSec: number | null;

  /** Deliveries that gave up recently (the collector's window), newest first. */
  deliveryFailures: Array<{ channel: string; lastError: string | null }>;

  /** AI analyses that gave up recently because the provider refused our key. */
  aiCredentialFailures: number;

  /**
   * Due AI analyses waiting because the provider refused service to everybody
   * (spend or usage limit): the pipeline paused instead of failing them.
   */
  aiProviderPausedRequests?: number;

  cronJobs: CronJobState[];

  /** False when driver_position has fewer days of partitions than it needs. */
  partitionRunwayOk: boolean;
  partitionRunwayDays: number | null;

  /** Workers with no sign of progress for too long, on live replicas. */
  stuckWorkers: Array<{ replica: string; worker: string }>;

  connectionUsagePercent: number;

  redisOk: boolean;

  /**
   * The A1 certificate that signs proof documents (decision 14.8): its state
   * and end date only, never the serial or the CNPJ. Absent when the
   * collector did not read it.
   */
  proofSigning?: {
    state: "READY" | "EXPIRED" | "INVALID" | "ABSENT" | "DISABLED";
    reason: string | null;
    notAfter: Date | null;
  };

  /** Parts of the snapshot that could not be read; each one is a reason. */
  collectionErrors: string[];
}

const DEFAULT_ALERT_THRESHOLDS = {
  /** Expansion is wake-driven with a 30 s sweep: five minutes is a stopped worker. */
  outboxLagSec: 5 * 60,

  /** In-app, activity and push: our database and Expo. */
  deliveryInternalLagSec: 5 * 60,

  /** E-mail and WhatsApp wait on third parties with 10 s timeouts each. */
  deliveryExternalLagSec: 15 * 60,

  /** A tenant's burst can queue thousands; half an hour is no burst. */
  webhookLagSec: 30 * 60,

  aiLagSec: 15 * 60,

  /**
   * Terminal failures of ONE channel inside the collector's window. A few
   * are customer data (a number without WhatsApp, a mailbox that is gone);
   * this many at once is the channel itself.
   */
  terminalFailuresPerChannel: 50,

  /** Every job is at least daily: one missed night plus slack. */
  cronStaleMs: 26 * 60 * 60 * 1000,

  connectionUsagePercent: 80,

  /** The A1 certificate is renewed by hand: a month to buy and install it. */
  proofSigningWarningDays: 30,

  /** From here on, receipts are days away from going out unsigned. */
  proofSigningCriticalDays: 7,
} as const;

type AlertThresholds = { [K in keyof typeof DEFAULT_ALERT_THRESHOLDS]: number };

function seconds(value: number): string {
  return `${Math.round(value)}s`;
}

function lagReason(
  what: string,
  lag: number | null,
  limit: number,
): string | null {
  return lag !== null && lag > limit
    ? `${what}: item devido há ${seconds(lag)} sem ser processado (limite ${seconds(limit)})`
    : null;
}

/** Enough of the provider's text to act on, not a wall of it. */
function excerpt(text: string | null): string {
  return (text ?? "").slice(0, 200);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The proof signing certificate (design §6.3/§7.4). No certificate, or
 * signing switched off, is a choice and never pages; a configured one that
 * expired or cannot be opened does, and so does one close to its end date.
 */
function proofSigningReason(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds,
): string | null {
  const signing = snapshot.proofSigning;

  if (!signing) return null;

  if (signing.state === "EXPIRED") {
    return "Certificado ICP do comprovante vencido: os comprovantes saem sem assinatura digital até a troca";
  }

  if (signing.state === "INVALID") {
    return `Certificado ICP do comprovante inválido (${signing.reason ?? "motivo desconhecido"}): os comprovantes saem sem assinatura digital`;
  }

  if (signing.state !== "READY" || !signing.notAfter) return null;

  const daysLeft = Math.floor((signing.notAfter.getTime() - snapshot.now.getTime()) / DAY_MS);
  // The instant, not a day: the certificate ends at a UTC moment.
  const endDate = signing.notAfter.toISOString();

  if (daysLeft <= thresholds.proofSigningCriticalDays) {
    return `Crítico: o certificado ICP do comprovante vence em ${daysLeft} dia(s) (${endDate})`;
  }

  if (daysLeft <= thresholds.proofSigningWarningDays) {
    return `Certificado ICP do comprovante vence em ${daysLeft} dia(s) (${endDate}): renove antes que os comprovantes saiam sem assinatura`;
  }

  return null;
}

function evaluateAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): string[] {
  const reasons: Array<string | null> = [];

  reasons.push(
    lagReason("Outbox (expansão de eventos)", snapshot.outboxEligibleLagSec, thresholds.outboxLagSec),
    lagReason(
      "Entregas internas (in-app, push, atividade)",
      snapshot.deliveryEligibleLagSec.internal,
      thresholds.deliveryInternalLagSec,
    ),
    lagReason(
      "Entregas externas (e-mail, WhatsApp)",
      snapshot.deliveryEligibleLagSec.external,
      thresholds.deliveryExternalLagSec,
    ),
    lagReason("Webhooks de integração", snapshot.webhookDueLagSec, thresholds.webhookLagSec),
    lagReason("Análises de IA", snapshot.aiEligibleLagSec, thresholds.aiLagSec),
  );

  // Credentials first, and on the FIRST occurrence: every later send of the
  // channel fails the same way until somebody changes the secret.
  const byChannel = new Map<string, Array<string | null>>();

  for (const failure of snapshot.deliveryFailures) {
    const list = byChannel.get(failure.channel) ?? [];
    list.push(failure.lastError);
    byChannel.set(failure.channel, list);
  }

  for (const [channel, errors] of byChannel) {
    const credential = errors.find((error) => isCredentialFailure(error));

    if (credential) {
      reasons.push(
        `Canal ${channel}: falha de credencial ou configuração do provedor — ${excerpt(credential)}`,
      );
    } else if (errors.length >= thresholds.terminalFailuresPerChannel) {
      reasons.push(
        `Canal ${channel}: ${errors.length} entregas falharam de vez na janela — a mais recente: ${excerpt(errors[0])}`,
      );
    }
  }

  if ((snapshot.aiProviderPausedRequests ?? 0) > 0) {
    reasons.push(
      `Análises de IA pausadas: ${snapshot.aiProviderPausedRequests} aguardando porque o provedor recusou o serviço (limite de gasto ou de uso da conta)`,
    );
  }

  if (snapshot.aiCredentialFailures > 0) {
    reasons.push(
      `Análises de IA: ${snapshot.aiCredentialFailures} recusada(s) pelo provedor por credencial (401/403)`,
    );
  }

  for (const job of snapshot.cronJobs) {
    if (job.staleRunning > 0) {
      reasons.push(
        `Cron ${job.job}: execução interrompida (lease vencido) — a réplica caiu no meio do job`,
      );
      continue;
    }

    const age =
      job.lastSucceededAt === null
        ? null
        : snapshot.now.getTime() - job.lastSucceededAt.getTime();

    // A job that never fired yet (registered minutes ago) is not overdue;
    // one that ran and never succeeded is.
    const neverSucceeded = age === null && job.lastStatus === "FAILED";
    const overdue = age !== null && age > thresholds.cronStaleMs;

    // Worded apart: a job whose only run failed a minute ago has not been
    // failing "for 26 h", and the operator should not go looking for that.
    if (neverSucceeded) {
      reasons.push(
        `Cron ${job.job}: nenhuma execução bem-sucedida registrada (último status: FAILED)`,
      );
    } else if (overdue) {
      reasons.push(
        `Cron ${job.job}: sem execução bem-sucedida há mais de ${Math.round(
          thresholds.cronStaleMs / 3_600_000,
        )}h (último status: ${job.lastStatus ?? "nenhum"})`,
      );
    }
  }

  if (!snapshot.partitionRunwayOk) {
    reasons.push(
      `driver_position: restam ${snapshot.partitionRunwayDays ?? 0} dia(s) de partições — sem elas o INSERT de posição é recusado`,
    );
  }

  for (const worker of snapshot.stuckWorkers) {
    reasons.push(
      `Worker ${worker.worker} travado na réplica ${worker.replica} (sem sinal de progresso)`,
    );
  }

  if (snapshot.connectionUsagePercent >= thresholds.connectionUsagePercent) {
    reasons.push(
      `Postgres: ${snapshot.connectionUsagePercent}% de max_connections em uso (limite ${thresholds.connectionUsagePercent}%)`,
    );
  }

  if (!snapshot.redisOk) {
    reasons.push(
      "Redis sem resposta: rate limit em modo local e Socket.IO sem adapter entre réplicas",
    );
  }

  reasons.push(proofSigningReason(snapshot, thresholds));

  for (const error of snapshot.collectionErrors) {
    reasons.push(`Verificação incompleta: ${excerpt(error)}`);
  }

  return reasons.filter((reason): reason is string => reason !== null);
}

export { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts };
export type { AlertThresholds, CronJobState, OperationalSnapshot };

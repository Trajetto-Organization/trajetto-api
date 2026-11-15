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

  /**
   * The latest run stopped with work left (FAILED "[partial]", F1-17), and
   * since when the job has done nothing but partials. Absent on a snapshot
   * that did not read them, which judges the job as before.
   */
  lastPartial?: boolean;
  partialSince?: Date | null;
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

  /**
   * The database's own numbers the scale plan's alerts read (F1-11), from
   * the heartbeat's cluster readings. Absent when the collector did not
   * read them, which judges nothing of it.
   */
  database?: ClusterDatabaseState;

  /** Redis' memory, ceiling and evictions (F1-11); absent likewise. */
  redis?: ClusterRedisState;

  /** Parts of the snapshot that could not be read; each one is a reason. */
  collectionErrors: string[];
}

interface ClusterDatabaseState {
  /** SHOW archive_mode: "on", "always" (a standby) or "off". */
  archiveMode: string | null;

  /** pg_stat_archiver: the last segment archived, and the last failure. */
  lastArchivedAgeSec: number | null;
  lastArchivedAt: Date | null;
  lastArchiveFailedAt: Date | null;
  archiveFailedCount: number | null;

  /** The cluster's age(datfrozenxid), its largest database. */
  xidAge: number | null;

  /** The oldest transaction with an xid, anywhere in the cluster. */
  oldestWriteXactSec: number | null;

  /** pg_wal's size; null when this user may not list it. */
  pgWalBytes: number | null;
}

interface ClusterRedisState {
  up: boolean;

  /** null with Redis up is "no ceiling" (maxmemory 0). */
  maxmemoryMb: number | null;
  maxmemoryPolicy: string | null;

  /**
   * Keys evicted since the 'cluster' row of about 15 minutes ago, and how
   * long ago that was; null without such a row (the first minutes after a
   * deploy, or the series switched off).
   */
  evictedKeys: { delta: number; windowSec: number } | null;
}

/** What the environment says should be there (F1-11). */
interface AlertExpectations {
  /**
   * PITR_EXPECTED: WAL archiving is meant to be on. False until the
   * pgBackRest setup of each environment is done (F1a staging, F1b
   * production), so a database that never archived pages nobody.
   */
  pitrExpected: boolean;
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

  /**
   * archive_timeout is 60 s (plano-escala), so a segment leaves at least a
   * minute apart while anything writes, and the ops_sample rows write every
   * minute: five minutes without one is an archiver that stopped.
   */
  archiveLagSec: 300,

  /**
   * Wraparound is at 2^31 (~2.1 billion) and the anti-wraparound vacuum
   * starts at 200 million: a billion is the freeze falling far behind, with
   * time still to act.
   */
  xidAge: 1_000_000_000,

  /**
   * LONG_WRITE_XACT_ALERT_SECONDS (120 by default): an open write holds the
   * vacuum's horizon and, with the integration feed (F2-05), the feed's.
   * The import reversal runs a 60 s transaction inside HTTP today; the
   * limit drops to 60 by env once that becomes a job (wave 14).
   */
  longWriteXactSec: 120,

  /**
   * PG_WAL_ALERT_GIB (12 by default, 8 on the single VPS): normal use is
   * 1-2 GB, plus the archive queue when R2 is away, and pg_wal lives on the
   * disk both productions share.
   */
  pgWalBytes: 12 * 1024 ** 3,
} as const;

type AlertThresholds = { [K in keyof typeof DEFAULT_ALERT_THRESHOLDS]: number };

const GIB = 1024 ** 3;

/** The thresholds the environment tunes (F1-11); the rest are the code's. */
function alertThresholdsFromEnv(values: {
  LONG_WRITE_XACT_ALERT_SECONDS: number;
  PG_WAL_ALERT_GIB: number;
}): AlertThresholds {
  return {
    ...DEFAULT_ALERT_THRESHOLDS,
    longWriteXactSec: values.LONG_WRITE_XACT_ALERT_SECONDS,
    pgWalBytes: values.PG_WAL_ALERT_GIB * GIB,
  };
}

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

  const daysLeft = Math.floor(
    (signing.notAfter.getTime() - snapshot.now.getTime()) / DAY_MS,
  );
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

/** "on" and "always" (a standby archiving what it replays) both archive. */
function archives(mode: string | null): boolean {
  return mode === "on" || mode === "always";
}

function gib(bytes: number): string {
  return `${(Math.round((bytes / GIB) * 10) / 10).toLocaleString("pt-BR")} GiB`;
}

/**
 * The database's own rules (F1-11). The archiver is judged only while it
 * archives: with archive_mode off there is nothing to judge, and
 * pg_stat_archiver keeps whatever an old setup left. Whether it SHOULD be
 * on is PITR_EXPECTED's question. pg_wal is judged either way: it fills the
 * disk whatever the cause.
 */
function databaseReasons(
  database: ClusterDatabaseState,
  thresholds: AlertThresholds,
  expectations: AlertExpectations,
): Array<string | null> {
  const reasons: Array<string | null> = [];
  const archiving = archives(database.archiveMode);

  if (
    expectations.pitrExpected &&
    database.archiveMode !== null &&
    !archiving
  ) {
    reasons.push(
      `PITR esperado (PITR_EXPECTED=true), mas archive_mode está "${database.archiveMode}": o WAL não sai do servidor e não há restauração até o minuto`,
    );
  }

  if (archiving) {
    const lastFailed = database.lastArchiveFailedAt;
    const lastArchived = database.lastArchivedAt;

    // The latest attempt failed: a failure newer than the last success.
    // failed_count alone is cumulative since the stats reset, and an
    // archiver that recovered keeps it.
    if (
      lastFailed !== null &&
      (lastArchived === null || lastFailed.getTime() > lastArchived.getTime())
    ) {
      reasons.push(
        `Arquivamento do WAL falhando: a última tentativa falhou em ${lastFailed.toISOString()} (${database.archiveFailedCount ?? "?"} falha(s) desde o último reset); o pg_wal cresce até o arquivamento voltar`,
      );
    } else if (
      database.lastArchivedAgeSec !== null &&
      database.lastArchivedAgeSec > thresholds.archiveLagSec
    ) {
      reasons.push(
        `Arquivamento do WAL parado: o último segmento foi arquivado há ${seconds(database.lastArchivedAgeSec)} (limite ${seconds(thresholds.archiveLagSec)}); o pg_wal cresce até o arquivamento voltar`,
      );
    }
  }

  if (database.xidAge !== null && database.xidAge > thresholds.xidAge) {
    reasons.push(
      `Postgres: idade do xid em ${Math.round(database.xidAge)} (limite ${thresholds.xidAge}); o congelamento do vacuum está atrasado`,
    );
  }

  if (
    database.oldestWriteXactSec !== null &&
    database.oldestWriteXactSec > thresholds.longWriteXactSec
  ) {
    reasons.push(
      `Postgres: transação de escrita aberta há ${seconds(database.oldestWriteXactSec)} (limite ${seconds(thresholds.longWriteXactSec)}); segura o vacuum e o feed da integração`,
    );
  }

  if (
    database.pgWalBytes !== null &&
    database.pgWalBytes > thresholds.pgWalBytes
  ) {
    reasons.push(
      `Postgres: pg_wal com ${gib(database.pgWalBytes)} (limite ${gib(thresholds.pgWalBytes)}); o disco compartilhado enche se continuar`,
    );
  }

  return reasons;
}

/**
 * Redis' memory rules (F1-11). With Redis down they say nothing: the
 * "Redis sem resposta" rule speaks, and its numbers are not there.
 */
function redisReasons(redis: ClusterRedisState): Array<string | null> {
  if (!redis.up) return [];

  const reasons: Array<string | null> = [];

  if (redis.evictedKeys && redis.evictedKeys.delta > 0) {
    reasons.push(
      `Redis despejou ${redis.evictedKeys.delta} chave(s) em ${Math.round(redis.evictedKeys.windowSec / 60)} min: memória no teto; contadores do rate limit e estado do Socket.IO foram descartados`,
    );
  }

  const noCeiling = redis.maxmemoryMb === null;
  const noEviction = redis.maxmemoryPolicy === "noeviction";

  if (noCeiling || noEviction) {
    const what: string[] = [];

    if (noCeiling) what.push("sem teto de memória (maxmemory 0)");
    if (noEviction) what.push("com maxmemory-policy noeviction");

    reasons.push(
      `Redis ${what.join(" e ")}: cheio, recusa escritas e desliga o rate limit de uma vez (o esperado é --maxmemory 256mb --maxmemory-policy allkeys-lru)`,
    );
  }

  return reasons;
}

function evaluateAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  expectations: AlertExpectations = { pitrExpected: false },
): string[] {
  const reasons: Array<string | null> = [];

  reasons.push(
    lagReason(
      "Outbox (expansão de eventos)",
      snapshot.outboxEligibleLagSec,
      thresholds.outboxLagSec,
    ),
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
    lagReason(
      "Webhooks de integração",
      snapshot.webhookDueLagSec,
      thresholds.webhookLagSec,
    ),
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

    // A partial run did work and left some (F1-17): the catch-up sweep takes
    // it again in the partial window, and the next night after that. The
    // first one is not an alert; 26 h of nothing but partials is, because
    // then the purge is losing to the inflow.
    if (job.lastPartial) {
      const partialAge =
        job.partialSince === null || job.partialSince === undefined
          ? null
          : snapshot.now.getTime() - job.partialSince.getTime();

      if (partialAge !== null && partialAge > thresholds.cronStaleMs) {
        reasons.push(
          `Cron ${job.job}: só execuções parciais há mais de ${Math.round(
            thresholds.cronStaleMs / 3_600_000,
          )}h (o expurgo não dá conta do que entra)`,
        );
      }

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

  if (snapshot.database) {
    reasons.push(
      ...databaseReasons(snapshot.database, thresholds, expectations),
    );
  }

  if (snapshot.redis) reasons.push(...redisReasons(snapshot.redis));

  reasons.push(proofSigningReason(snapshot, thresholds));

  for (const error of snapshot.collectionErrors) {
    reasons.push(`Verificação incompleta: ${excerpt(error)}`);
  }

  return reasons.filter((reason): reason is string => reason !== null);
}

export { DEFAULT_ALERT_THRESHOLDS, alertThresholdsFromEnv, evaluateAlerts };
export type {
  AlertExpectations,
  AlertThresholds,
  ClusterDatabaseState,
  ClusterRedisState,
  CronJobState,
  OperationalSnapshot,
};

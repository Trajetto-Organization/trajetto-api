import { isCredentialFailure } from "@/shared/notifications/delivery-diagnostics";

import {
  clusterEpochStaleReason,
  type ClusterEpochState,
} from "./cluster-epoch";
import { feedTxidRegressed, type FeedTxidState } from "./feed-txid";

/**
 * When the operation must be woken up (OBS-03). Pure: the ops heartbeat job
 * gathers an OperationalSnapshot, these rules turn it into alerts, each with
 * a stable code and a pt-BR message that ends with the path of its runbook
 * (docs/runbooks/<code>.md, plano-escala F1-20), and an empty list is the
 * only "all is well".
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
   * since when the job has done nothing but partials — null when a run that
   * really failed came after the last success (readCronJobs). Absent on a
   * snapshot that did not read them, which judges the job as before.
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

  /**
   * Every registered partitioned table (plano-escala F2-09), as
   * operational-state.ts judged it. When present, it replaces the two
   * driver_position fields above for the alerts; absent on a snapshot that
   * did not read it, which judges driver_position by them as before.
   */
  partitions?: PartitionAlertState[];

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

  /**
   * Deliveries created in the last 24 h and 7 days (plano-escala U-12),
   * from the cluster rows' counter; absent without a reading (no recent
   * quarter-hour row, or the series switched off), which judges nothing.
   */
  volume?: VolumeState;

  /**
   * The geocoder's account today (plano-escala F2-32): the lookups the
   * day's rows count across its scopes, and the plan's daily quota
   * (LOCATIONIQ_DAILY_QUOTA). Absent without a quota written down, or
   * when the rows could not be read, which judges nothing.
   */
  geocodingQuota?: GeocodingQuotaState;

  /**
   * The integration feed's stamp against the cluster (plano-escala F2-03):
   * the largest delivery_event.txid stored and the next xid. Absent until
   * the feed's index is valid, or when it could not be read, which judges
   * nothing.
   */
  feedTxid?: FeedTxidState;

  /**
   * The cluster's epoch row against the cluster (plano-escala U-14): the
   * stored system_identifier and timeline, and the cluster's own. Absent
   * before the table exists, or when it could not be read, which judges
   * nothing.
   */
  clusterEpoch?: ClusterEpochState;

  /**
   * Each replica's sockets against its real ceiling (plano-escala F5-31),
   * from its newest ops_sample row of the last minutes. Absent when the
   * rows could not be read, which judges nothing; a replica with no
   * ceiling (cap 0) is never judged.
   */
  sockets?: SocketUsageState[];

  /**
   * Cursors of another cluster epoch the integration feed converted in the
   * last minutes (plano-escala F2-05), summed from the processes' ops_sample
   * rows. Absent when the rows could not be read, which judges nothing.
   */
  feedEpochConversions?: number;

  /** Parts of the snapshot that could not be read; each one is a reason. */
  collectionErrors: string[];
}

interface SocketUsageState {
  replica: string;
  connections: number;
  cap: number;
}

interface PartitionAlertState {
  table: string;

  /** Whole days until the last partition ends; null when there is none. */
  lookaheadDays: number | null;

  /** Under 3 days ahead: a few nights from refused inserts. */
  runwayOk: boolean;

  /** Under 5 days ahead: the job has missed two nights. */
  lookaheadOk: boolean;

  /** Partitions past the retention by more than 3 days, still there. */
  stuck: string[];

  /** The days of grace before `stuck` (the registry's); 3 when absent. */
  stuckGraceDays?: number;

  /**
   * Who drops the table's partitions past the retention, when a gate
   * settles them first (F5-11): the message says why a day is kept.
   */
  dropGate?: string;
}

interface GeocodingQuotaState {
  usedToday: number;
  dailyQuota: number;
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

interface VolumeState {
  last24h: number;
  last7d: number;
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

  /**
   * A replica's sockets against its ceiling (F5-31): past 80%, the next
   * deploy's reconnections no longer fit on the replicas left over, and
   * the handshakes start being refused with the wait.
   */
  socketCapUsagePercent: 80,

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

  /**
   * APPROVED_GATE_MONTHLY_DELIVERIES (10 000 by default, today's step): the
   * monthly volume the newest approved load report in docs/desempenho
   * proved this hardware takes (plano-escala U-12). Raised only with a
   * new report.
   */
  approvedGateMonthlyDeliveries: 10_000,

  /**
   * The share of the gate that pages: at 70% the next cohort of the ramp
   * waits for the next step (V-07), with room left for the peak.
   */
  volumeGateRatio: 0.7,

  /**
   * PLATFORM_DAILY_DELIVERY_SOFT_CAP: deliveries in the last 24 h past it
   * page. Unset is no cap (infinite). Only an alert: nothing is refused.
   */
  dailyDeliverySoftCap: Number.POSITIVE_INFINITY,

  /**
   * The share of the provider's day that pages (decision D40): at 70% the
   * owner still has the day's rest to raise the plan or lower a budget
   * before the 429 holds every path until midnight UTC.
   */
  geocodingQuotaRatio: 0.7,
} as const;

type AlertThresholds = { [K in keyof typeof DEFAULT_ALERT_THRESHOLDS]: number };

const GIB = 1024 ** 3;

/**
 * The thresholds the environment tunes (F1-11, U-12); the rest are the
 * code's. The volume ones are optional here: absent is the default.
 */
function alertThresholdsFromEnv(values: {
  LONG_WRITE_XACT_ALERT_SECONDS: number;
  PG_WAL_ALERT_GIB: number;
  APPROVED_GATE_MONTHLY_DELIVERIES?: number;
  PLATFORM_DAILY_DELIVERY_SOFT_CAP?: number;
}): AlertThresholds {
  return {
    ...DEFAULT_ALERT_THRESHOLDS,
    longWriteXactSec: values.LONG_WRITE_XACT_ALERT_SECONDS,
    pgWalBytes: values.PG_WAL_ALERT_GIB * GIB,
    approvedGateMonthlyDeliveries:
      values.APPROVED_GATE_MONTHLY_DELIVERIES ??
      DEFAULT_ALERT_THRESHOLDS.approvedGateMonthlyDeliveries,
    dailyDeliverySoftCap:
      values.PLATFORM_DAILY_DELIVERY_SOFT_CAP ??
      DEFAULT_ALERT_THRESHOLDS.dailyDeliverySoftCap,
  };
}

/** How many names of stuck partitions a message carries. */
const STUCK_NAMES_SHOWN = 3;

/**
 * The partitions of each registered table (F2-09): runway-low (under 3
 * days, inserts about to be refused) or, before it, lookahead-low (under
 * 5, the job missed two nights), never both for one table; and stuck, a
 * partition past the retention the job keeps failing to drop. A snapshot
 * without the per-table states judges driver_position's runway alone, as
 * before.
 */
function partitionAlerts(snapshot: OperationalSnapshot): Alert[] {
  if (!snapshot.partitions) {
    return snapshot.partitionRunwayOk
      ? []
      : [
          {
            code: "partition-runway-low",
            message: `driver_position: restam ${snapshot.partitionRunwayDays ?? 0} dia(s) de partições — sem elas o INSERT de posição é recusado`,
          },
        ];
  }

  const alerts: Alert[] = [];

  for (const table of snapshot.partitions) {
    const days = table.lookaheadDays ?? 0;

    if (!table.runwayOk) {
      alerts.push({
        code: "partition-runway-low",
        message: `${table.table}: restam ${days} dia(s) de partições — sem elas o INSERT é recusado`,
      });
    } else if (!table.lookaheadOk) {
      alerts.push({
        code: "partition-lookahead-low",
        message: `${table.table}: só ${days} dia(s) de partições à frente (o mínimo é 5) — o job partition-maintenance não as criou em noites seguidas`,
      });
    }

    if (table.stuck.length > 0) {
      const shown = table.stuck.slice(0, STUCK_NAMES_SHOWN).join(", ");
      const more =
        table.stuck.length > STUCK_NAMES_SHOWN
          ? ` e mais ${table.stuck.length - STUCK_NAMES_SHOWN}`
          : "";

      alerts.push({
        code: "partition-stuck",
        message: `${table.table}: ${table.stuck.length} partição(ões) passaram da retenção há mais de ${table.stuckGraceDays ?? 3} dias e continuam no banco (${shown}${more}) — o job partition-maintenance não consegue destacá-las ou apagá-las${
          table.dropGate
            ? " (numa fila, o dia só sai sem linha em voo, com as falhas nos dead letters e a família toda particionada)"
            : ""
        }`,
      });
    }
  }

  return alerts;
}

/**
 * Every alert's stable code (plano-escala F1-20): the name of its runbook,
 * docs/runbooks/<code>.md, and what a reader of the log or of the check
 * greps for. A code is never renamed (an operator's notes and the
 * runbook's links point to it); a new rule brings its code AND its
 * runbook, and tests/unitaires/lifecycle/runbooks.test.ts refuses one
 * without the other.
 */
const ALERT_KINDS = [
  "outbox-lag",
  "delivery-lag",
  "webhook-lag",
  "ai-lag",
  "channel-credential",
  "channel-failure-burst",
  "ai-provider-paused",
  "ai-credential",
  "cron-lease-expired",
  "cron-partial-stuck",
  "cron-overdue",
  "partition-runway-low",
  "partition-lookahead-low",
  "partition-stuck",
  "worker-stuck",
  "connection-usage-high",
  "socket-cap-high",
  "redis-down",
  "pitr-archive-off",
  "wal-archive-stalled",
  "xid-age-high",
  "long-write-xact",
  "pg-wal-high",
  "redis-evictions",
  "redis-memory-policy",
  "proof-signing",
  "volume-near-gate",
  "geocoding-quota-high",
  "feed-txid-regressed",
  "cluster-epoch-stale",
  "feed-epoch-conversion",
  "collection-incomplete",
] as const;

type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Runbooks of incidents no rule names yet (F1-20): a provider down, a
 * reconnect storm, a migration stuck on a lock, a full disk, a PITR
 * restore and the restore drill; and the planned moves between servers
 * (F1-24): the staging to a Remote Server, production to its own servers.
 * They live beside the alerts' runbooks.
 */
const OPERATION_RUNBOOKS = [
  "provider-down",
  "reconnect-storm",
  "migration-lock",
  "disk-full",
  "pitr-restore",
  "restore-drill",
  "staging-remote-server",
  "producao-servidores-proprios",
  "delivery-event-writer-bound",
] as const;

/** One reason to wake the operation: its code and its pt-BR message. */
interface Alert {
  code: AlertKind;
  message: string;
}

/** Where the code's runbook is, from the repository's root. */
function runbookPath(code: AlertKind): string {
  return `docs/runbooks/${code}.md`;
}

/** The reason as the check and the log show it: the message, then the link. */
function formatAlert(alert: Alert): string {
  return `${alert.message} (runbook: ${runbookPath(alert.code)})`;
}

function seconds(value: number): string {
  return `${Math.round(value)}s`;
}

function lagAlert(
  code: AlertKind,
  what: string,
  lag: number | null,
  limit: number,
): Alert | null {
  if (lag === null || lag <= limit) return null;

  return {
    code,
    message: `${what}: item devido há ${seconds(lag)} sem ser processado (limite ${seconds(limit)})`,
  };
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
function databaseAlerts(
  database: ClusterDatabaseState,
  thresholds: AlertThresholds,
  expectations: AlertExpectations,
): Alert[] {
  const alerts: Alert[] = [];
  const archiving = archives(database.archiveMode);

  if (
    expectations.pitrExpected &&
    database.archiveMode !== null &&
    !archiving
  ) {
    alerts.push({
      code: "pitr-archive-off",
      message: `PITR esperado (PITR_EXPECTED=true), mas archive_mode está "${database.archiveMode}": o WAL não sai do servidor e não há restauração até o minuto`,
    });
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
      alerts.push({
        code: "wal-archive-stalled",
        message: `Arquivamento do WAL falhando: a última tentativa falhou em ${lastFailed.toISOString()} (${database.archiveFailedCount ?? "?"} falha(s) desde o último reset); o pg_wal cresce até o arquivamento voltar`,
      });
    } else if (
      database.lastArchivedAgeSec !== null &&
      database.lastArchivedAgeSec > thresholds.archiveLagSec
    ) {
      alerts.push({
        code: "wal-archive-stalled",
        message: `Arquivamento do WAL parado: o último segmento foi arquivado há ${seconds(database.lastArchivedAgeSec)} (limite ${seconds(thresholds.archiveLagSec)}); o pg_wal cresce até o arquivamento voltar`,
      });
    }
  }

  if (database.xidAge !== null && database.xidAge > thresholds.xidAge) {
    alerts.push({
      code: "xid-age-high",
      message: `Postgres: idade do xid em ${Math.round(database.xidAge)} (limite ${thresholds.xidAge}); o congelamento do vacuum está atrasado`,
    });
  }

  if (
    database.oldestWriteXactSec !== null &&
    database.oldestWriteXactSec > thresholds.longWriteXactSec
  ) {
    alerts.push({
      code: "long-write-xact",
      message: `Postgres: transação de escrita aberta há ${seconds(database.oldestWriteXactSec)} (limite ${seconds(thresholds.longWriteXactSec)}); segura o vacuum e o feed da integração`,
    });
  }

  if (
    database.pgWalBytes !== null &&
    database.pgWalBytes > thresholds.pgWalBytes
  ) {
    alerts.push({
      code: "pg-wal-high",
      message: `Postgres: pg_wal com ${gib(database.pgWalBytes)} (limite ${gib(thresholds.pgWalBytes)}); o disco compartilhado enche se continuar`,
    });
  }

  return alerts;
}

/**
 * Redis' memory rules (F1-11). With Redis down they say nothing: the
 * "Redis sem resposta" rule speaks, and its numbers are not there.
 */
function redisAlerts(redis: ClusterRedisState): Alert[] {
  if (!redis.up) return [];

  const alerts: Alert[] = [];

  if (redis.evictedKeys && redis.evictedKeys.delta > 0) {
    alerts.push({
      code: "redis-evictions",
      message: `Redis despejou ${redis.evictedKeys.delta} chave(s) em ${Math.round(redis.evictedKeys.windowSec / 60)} min: memória no teto; contadores do rate limit e estado do Socket.IO foram descartados`,
    });
  }

  const noCeiling = redis.maxmemoryMb === null;
  const noEviction = redis.maxmemoryPolicy === "noeviction";

  if (noCeiling || noEviction) {
    const what: string[] = [];

    if (noCeiling) what.push("sem teto de memória (maxmemory 0)");
    if (noEviction) what.push("com maxmemory-policy noeviction");

    alerts.push({
      code: "redis-memory-policy",
      message: `Redis ${what.join(" e ")}: cheio, recusa escritas e desliga o rate limit de uma vez (o esperado é --maxmemory 256mb --maxmemory-policy allkeys-lru)`,
    });
  }

  return alerts;
}

/** A whole number in pt-BR, with the thousands' dot. */
function count(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

/**
 * The ramp's rules (plano-escala U-12). The 7 days' deliveries, projected
 * to a month (× 30/7), past 70% of the approved gate; and the last 24 h
 * past the platform's soft cap, when one is set. Neither refuses anything:
 * they say the ramp has to wait for the next step.
 */
function volumeAlerts(
  volume: VolumeState,
  thresholds: AlertThresholds,
): Alert[] {
  const alerts: Alert[] = [];
  const gate = thresholds.approvedGateMonthlyDeliveries;
  const projected = (volume.last7d * 30) / 7;

  if (projected > gate * thresholds.volumeGateRatio) {
    alerts.push({
      code: "volume-near-gate",
      message: `Volume de entregas perto do portão aprovado: ${count(volume.last7d)} nos últimos 7 dias, cerca de ${count(projected)} por mês (${Math.round((projected / gate) * 100)}% de ${count(gate)}, APPROVED_GATE_MONTHLY_DELIVERIES); a próxima coorte espera o degrau seguinte`,
    });
  }

  if (volume.last24h > thresholds.dailyDeliverySoftCap) {
    alerts.push({
      code: "volume-near-gate",
      message: `Volume de entregas acima do teto diário: ${count(volume.last24h)} nas últimas 24 h (PLATFORM_DAILY_DELIVERY_SOFT_CAP ${count(thresholds.dailyDeliverySoftCap)}); nada é recusado`,
    });
  }

  return alerts;
}

/** The cron rules: a dead run, partials that never end, no success. */
function cronAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds,
): Alert[] {
  const alerts: Alert[] = [];
  const staleHours = Math.round(thresholds.cronStaleMs / 3_600_000);

  for (const job of snapshot.cronJobs) {
    if (job.staleRunning > 0) {
      alerts.push({
        code: "cron-lease-expired",
        message: `Cron ${job.job}: execução interrompida (lease vencido) — a réplica caiu no meio do job`,
      });
      continue;
    }

    // A partial run did work and left some (F1-17): the catch-up sweep takes
    // it again in the partial window, and the next night after that. The
    // first one is not an alert; 26 h of nothing but partials is, because
    // then the purge is losing to the inflow.
    //
    // The grace needs the streak's start. Without it (partialSince null: a
    // run that really failed came after the last success) the job is judged
    // like any failure, by its last success below. Skipping it here let one
    // partial after two nights of a statement timeout silence an overdue
    // job for another 26 h.
    if (job.lastPartial && job.partialSince) {
      const partialAge = snapshot.now.getTime() - job.partialSince.getTime();

      if (partialAge > thresholds.cronStaleMs) {
        alerts.push({
          code: "cron-partial-stuck",
          message: `Cron ${job.job}: só execuções parciais há mais de ${staleHours}h (o expurgo não dá conta do que entra)`,
        });
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
      alerts.push({
        code: "cron-overdue",
        message: `Cron ${job.job}: nenhuma execução bem-sucedida registrada (último status: FAILED)`,
      });
    } else if (overdue) {
      alerts.push({
        code: "cron-overdue",
        message: `Cron ${job.job}: sem execução bem-sucedida há mais de ${staleHours}h (último status: ${job.lastStatus ?? "nenhum"})`,
      });
    }
  }

  return alerts;
}

/** Every reason to wake the operation, with its code (F1-20). */
function collectAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  expectations: AlertExpectations = { pitrExpected: false },
): Alert[] {
  const alerts: Array<Alert | null> = [];

  alerts.push(
    lagAlert(
      "outbox-lag",
      "Outbox (expansão de eventos)",
      snapshot.outboxEligibleLagSec,
      thresholds.outboxLagSec,
    ),
    lagAlert(
      "delivery-lag",
      "Entregas internas (in-app, push, atividade)",
      snapshot.deliveryEligibleLagSec.internal,
      thresholds.deliveryInternalLagSec,
    ),
    lagAlert(
      "delivery-lag",
      "Entregas externas (e-mail, WhatsApp)",
      snapshot.deliveryEligibleLagSec.external,
      thresholds.deliveryExternalLagSec,
    ),
    lagAlert(
      "webhook-lag",
      "Webhooks de integração",
      snapshot.webhookDueLagSec,
      thresholds.webhookLagSec,
    ),
    lagAlert(
      "ai-lag",
      "Análises de IA",
      snapshot.aiEligibleLagSec,
      thresholds.aiLagSec,
    ),
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
      alerts.push({
        code: "channel-credential",
        message: `Canal ${channel}: falha de credencial ou configuração do provedor — ${excerpt(credential)}`,
      });
    } else if (errors.length >= thresholds.terminalFailuresPerChannel) {
      alerts.push({
        code: "channel-failure-burst",
        message: `Canal ${channel}: ${errors.length} entregas falharam de vez na janela — a mais recente: ${excerpt(errors[0])}`,
      });
    }
  }

  if ((snapshot.aiProviderPausedRequests ?? 0) > 0) {
    alerts.push({
      code: "ai-provider-paused",
      message: `Análises de IA pausadas: ${snapshot.aiProviderPausedRequests} aguardando porque o provedor recusou o serviço (limite de gasto ou de uso da conta)`,
    });
  }

  if (snapshot.aiCredentialFailures > 0) {
    alerts.push({
      code: "ai-credential",
      message: `Análises de IA: ${snapshot.aiCredentialFailures} recusada(s) pelo provedor por credencial (401/403)`,
    });
  }

  alerts.push(...cronAlerts(snapshot, thresholds));

  alerts.push(...partitionAlerts(snapshot));

  for (const worker of snapshot.stuckWorkers) {
    alerts.push({
      code: "worker-stuck",
      message: `Worker ${worker.worker} travado na réplica ${worker.replica} (sem sinal de progresso)`,
    });
  }

  if (snapshot.connectionUsagePercent >= thresholds.connectionUsagePercent) {
    alerts.push({
      code: "connection-usage-high",
      message: `Postgres: ${snapshot.connectionUsagePercent}% de max_connections em uso (limite ${thresholds.connectionUsagePercent}%)`,
    });
  }

  for (const replica of snapshot.sockets ?? []) {
    if (replica.cap <= 0) continue;

    const percent = Math.round((replica.connections / replica.cap) * 100);

    if (percent >= thresholds.socketCapUsagePercent) {
      alerts.push({
        code: "socket-cap-high",
        message: `Sockets na réplica ${replica.replica}: ${replica.connections} de ${replica.cap} (${percent}% do teto, limite ${thresholds.socketCapUsagePercent}%)`,
      });
    }
  }

  if (!snapshot.redisOk) {
    alerts.push({
      code: "redis-down",
      message:
        "Redis sem resposta: rate limit em modo local e Socket.IO sem adapter entre réplicas",
    });
  }

  if (snapshot.database) {
    alerts.push(...databaseAlerts(snapshot.database, thresholds, expectations));
  }

  if (snapshot.redis) alerts.push(...redisAlerts(snapshot.redis));

  if (snapshot.volume) {
    alerts.push(...volumeAlerts(snapshot.volume, thresholds));
  }

  const quota = snapshot.geocodingQuota;

  if (
    quota &&
    quota.dailyQuota > 0 &&
    quota.usedToday > quota.dailyQuota * thresholds.geocodingQuotaRatio
  ) {
    alerts.push({
      code: "geocoding-quota-high",
      message: `Geocodificação: ${count(quota.usedToday)} consultas hoje (UTC), ${Math.round((quota.usedToday / quota.dailyQuota) * 100)}% de ${count(quota.dailyQuota)} do plano (LOCATIONIQ_DAILY_QUOTA); acima de ${Math.round(thresholds.geocodingQuotaRatio * 100)}%, o resto do dia pode acabar em 429`,
    });
  }

  // A logical restore into a new cluster without `pg_resetwal -e`
  // (F2-03): from here on every new event sorts behind the integrators'
  // cursors, silently.
  if (snapshot.feedTxid && feedTxidRegressed(snapshot.feedTxid)) {
    alerts.push({
      code: "feed-txid-regressed",
      message: `Feed da integração: o maior txid gravado em delivery_event (${snapshot.feedTxid.newest}) não está abaixo do próximo xid do cluster (${snapshot.feedTxid.next}); veio de outro cluster (um restore lógico sem o pg_resetwal -e) e os eventos novos ficariam para trás do cursor dos integradores`,
    });
  }

  // A PITR, a promote or a new cluster (U-14) the release step has not
  // seen yet: transaction ids are being reused under the old epoch.
  const epochStale = snapshot.clusterEpoch
    ? clusterEpochStaleReason(snapshot.clusterEpoch)
    : null;

  if (epochStale) {
    alerts.push({
      code: "cluster-epoch-stale",
      message: `Época do cluster: ${epochStale}; rode a etapa de release (Deploy na trajetto-api-migrate) para o cursor do feed da integração não confundir os xids reaproveitados`,
    });
  }

  // A cursor emitted before a PITR, a promote or a logical restore (F2-05):
  // the feed sent that integrator a stretch of events again, by design,
  // and the customer should hear it from us before their ERP shows it.
  if ((snapshot.feedEpochConversions ?? 0) > 0) {
    alerts.push({
      code: "feed-epoch-conversion",
      message: `Feed da integração: ${snapshot.feedEpochConversions} cursor(es) de outra época do cluster convertido(s) nos últimos minutos; os eventos desde o piso de cada um foram enviados de novo (a integração deduplica pelo id)`,
    });
  }

  const proofSigning = proofSigningReason(snapshot, thresholds);

  if (proofSigning) {
    alerts.push({ code: "proof-signing", message: proofSigning });
  }

  for (const error of snapshot.collectionErrors) {
    alerts.push({
      code: "collection-incomplete",
      message: `Verificação incompleta: ${excerpt(error)}`,
    });
  }

  return alerts.filter((alert): alert is Alert => alert !== null);
}

/**
 * The reasons the ops heartbeat sends and logs: each alert's pt-BR message,
 * ending with the path of its runbook. Empty is the only "all is well".
 */
function evaluateAlerts(
  snapshot: OperationalSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  expectations: AlertExpectations = { pitrExpected: false },
): string[] {
  return collectAlerts(snapshot, thresholds, expectations).map(formatAlert);
}

export {
  ALERT_KINDS,
  DEFAULT_ALERT_THRESHOLDS,
  OPERATION_RUNBOOKS,
  alertThresholdsFromEnv,
  collectAlerts,
  evaluateAlerts,
  formatAlert,
  runbookPath,
};
export type {
  Alert,
  AlertExpectations,
  AlertKind,
  AlertThresholds,
  ClusterDatabaseState,
  ClusterRedisState,
  CronJobState,
  GeocodingQuotaState,
  OperationalSnapshot,
  PartitionAlertState,
  SocketUsageState,
  VolumeState,
};

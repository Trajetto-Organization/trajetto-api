import cron, { ScheduledTask } from "node-cron";
import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

interface CronJobDefinition {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  runOnInit?: boolean;
}

/** Generous ceiling on a single run; an expired lease allows takeover. */
const EXECUTION_LEASE_MS = 10 * 60 * 1000;

class CronSchedulerService {
  private static instance: CronSchedulerService;

  private tasks: Map<string, ScheduledTask> = new Map();
  private jobDefinitions: CronJobDefinition[] = [];

  private constructor() {}

  public static getInstance(): CronSchedulerService {
    if (!CronSchedulerService.instance) {
      CronSchedulerService.instance = new CronSchedulerService();
    }

    return CronSchedulerService.instance;
  }

  public registerJob(definition: CronJobDefinition): void {
    if (this.tasks.has(definition.name)) {
      console.warn(
        `[CronScheduler] Job "${definition.name}" já registrado. Ignorando duplicata.`,
      );

      return;
    }

    if (!cron.validate(definition.schedule)) {
      console.error(
        `[CronScheduler] Expressão cron inválida para "${definition.name}": ${definition.schedule}`,
      );

      return;
    }

    this.jobDefinitions.push(definition);
  }

  /**
   * Runs the handler only on the replica that wins the leader election for
   * this firing. Every replica's node-cron fires on schedule; the unique
   * (jobName, scheduledFor) insert decides which one actually executes, and
   * the lease lets another replica take over if the winner dies mid-run.
   */
  private async runExclusively(definition: CronJobDefinition): Promise<void> {
    // Truncated to the minute so replicas firing microseconds apart agree on
    // which execution they are competing for.
    const scheduledFor = new Date();
    scheduledFor.setSeconds(0, 0);

    const claimed = await this.claimExecution(definition.name, scheduledFor);

    if (!claimed) {
      return;
    }

    console.log(
      `[CronScheduler] Executando "${definition.name}" em ${new Date().toISOString()}`,
    );

    try {
      await definition.handler();

      await this.finishExecution(definition.name, scheduledFor, null);
      console.log(
        `[CronScheduler] "${definition.name}" finalizado com sucesso`,
      );
    } catch (error) {
      await this.finishExecution(
        definition.name,
        scheduledFor,
        error instanceof Error ? error.message : String(error),
      );

      console.error(
        `[CronScheduler] Erro ao executar "${definition.name}":`,
        error,
      );
    }
  }

  private async claimExecution(
    jobName: string,
    scheduledFor: Date,
  ): Promise<boolean> {
    try {
      await database.scheduledJobExecution.create({
        data: {
          jobName,
          scheduledFor,
          leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
        },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Someone else claimed this firing. Take over only if their lease
        // expired without a finish — i.e. the winner died mid-run.
        const takeover = await database.scheduledJobExecution.updateMany({
          where: {
            jobName,
            scheduledFor,
            status: "RUNNING",
            leaseExpiresAt: { lt: new Date() },
          },
          data: {
            leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
            attempts: { increment: 1 },
          },
        });

        return takeover.count > 0;
      }

      throw error;
    }
  }

  private async finishExecution(
    jobName: string,
    scheduledFor: Date,
    errorMessage: string | null,
  ): Promise<void> {
    await database.scheduledJobExecution
      .updateMany({
        where: { jobName, scheduledFor },
        data: {
          status: errorMessage === null ? "SUCCEEDED" : "FAILED",
          finishedAt: new Date(),
          lastError: errorMessage,
        },
      })
      .catch((error) => {
        // The row stays RUNNING and the lease expiry allows a retry.
        console.error(
          `[CronScheduler] Falha ao registrar término de "${jobName}":`,
          error,
        );
      });
  }

  public async initialize(): Promise<void> {
    console.log(
      `[CronScheduler] Inicializando ${this.jobDefinitions.length} job(s)...`,
    );

    for (const definition of this.jobDefinitions) {
      const task = cron.schedule(
        definition.schedule,
        async () => {
          try {
            await this.runExclusively(definition);
          } catch (error) {
            console.error(
              `[CronScheduler] Erro ao coordenar "${definition.name}":`,
              error,
            );
          }
        },
        { name: definition.name },
      );

      this.tasks.set(definition.name, task);

      console.log(
        `[CronScheduler] Job "${definition.name}" agendado: ${definition.schedule}`,
      );

      if (definition.runOnInit) {
        console.log(
          `[CronScheduler] Executando "${definition.name}" no init...`,
        );

        // Init runs go through the same election: replicas booting within the
        // same minute dedupe instead of all running the job.
        this.runExclusively(definition).catch((error) => {
          console.error(
            `[CronScheduler] Erro ao executar "${definition.name}" no init:`,
            error,
          );
        });
      }
    }

    console.log("[CronScheduler] Todos os jobs inicializados");
  }

  public async shutdown(): Promise<void> {
    console.log("[CronScheduler] Encerrando scheduler...");

    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[CronScheduler] Job "${name}" parado`);
    }

    this.tasks.clear();
    console.log("[CronScheduler] Scheduler encerrado");
  }
}

export { CronSchedulerService, CronJobDefinition };

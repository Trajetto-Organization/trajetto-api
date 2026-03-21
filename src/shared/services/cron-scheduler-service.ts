import cron, { ScheduledTask } from "node-cron";

interface CronJobDefinition {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  runOnInit?: boolean;
}

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

  public async initialize(): Promise<void> {
    console.log(
      `[CronScheduler] Inicializando ${this.jobDefinitions.length} job(s)...`,
    );

    for (const definition of this.jobDefinitions) {
      const task = cron.schedule(
        definition.schedule,
        async () => {
          const startedAt = new Date().toISOString();
          console.log(
            `[CronScheduler] Executando "${definition.name}" em ${startedAt}`,
          );

          try {
            await definition.handler();
            console.log(
              `[CronScheduler] "${definition.name}" finalizado com sucesso`,
            );
          } catch (error) {
            console.error(
              `[CronScheduler] Erro ao executar "${definition.name}":`,
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

        definition.handler().catch((error) => {
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

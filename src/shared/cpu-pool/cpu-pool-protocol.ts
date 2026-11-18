/**
 * The messages between the CPU pool and its threads (plano-escala F3-29).
 * Types only: both sides import them, and nothing of either bundle comes
 * with them.
 */

type CpuTask = "nfe-parse";

interface CpuPoolColumn {
  header: string;
  key: string;
  width?: number;
}

interface CpuPoolRequest {
  id: number;
  type: "task" | "xlsx-start" | "xlsx-rows" | "xlsx-end";

  /** A task's name and input. */
  task?: CpuTask;
  input?: unknown;

  /** A workbook's columns (xlsx-start) and a batch of its rows. */
  columns?: CpuPoolColumn[];
  rows?: Array<Record<string, unknown>>;
}

type CpuPoolReply =
  /** A task's answer, or the refusal it threw (an NF-e that is not one). */
  | {
      type: "result";
      id: number;
      value?: unknown;
      error?: { name: string; message: string };
    }
  /** A workbook's batch is in; send the next one. */
  | { type: "ack"; id: number }
  /** A piece of the workbook's file, in order. */
  | { type: "chunk"; id: number; bytes: Uint8Array }
  /** The workbook's last byte went out. */
  | { type: "done"; id: number }
  /** The work failed on the thread. */
  | { type: "failed"; id: number; error: { name: string; message: string } };

export type { CpuPoolColumn, CpuPoolReply, CpuPoolRequest, CpuTask };

import type {
  PushBatchOutcome,
  PushRequest,
  PushSendResult,
} from "./push-provider";

/**
 * Where the push rows of one group meet before their single call to Expo
 * (plano-escala U-06).
 *
 * Each row of the group runs its own delivery, start to finish, as every
 * row of the pipeline does: its own checks, its own render, its own device
 * lookup, its own fenced settling. Only the send is shared. A row that
 * reaches the send hands its request here and waits; when every member
 * has either handed its request or left (it failed or was stopped before
 * the send), the requests go out together and each row gets back its own
 * outcome, by position, never another row's.
 *
 * A member that is slow to get there must not hold the others: the first
 * request starts a clock, and at `maxWaitMs` the requests already here go
 * out without the missing ones. A request that arrives after the group
 * went is sent on its own, as it would have been before the batch.
 */
type PushBatchSender = (requests: PushRequest[]) => Promise<PushBatchOutcome[]>;

interface WaitingRequest {
  request: PushRequest;
  resolve: (result: PushSendResult) => void;
  reject: (error: unknown) => void;
}

class PushBatchGate {
  /** Members that neither handed a request nor left yet. */
  private readonly expected: Set<string>;

  private readonly waiting: WaitingRequest[] = [];
  private fired = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    members: Iterable<string>,
    private readonly send: PushBatchSender,
    private readonly maxWaitMs: number,
  ) {
    this.expected = new Set(members);
  }

  /** The member's request; resolves with its own result or rejects. */
  submit(member: string, request: PushRequest): Promise<PushSendResult> {
    if (this.fired || !this.expected.has(member)) {
      return this.sendAlone(request);
    }

    const result = new Promise<PushSendResult>((resolve, reject) => {
      this.waiting.push({ request, resolve, reject });
    });

    this.expected.delete(member);
    this.timer ??= setTimeout(() => this.fire(), this.maxWaitMs);

    if (this.expected.size === 0) this.fire();

    return result;
  }

  /** The member will not send (it failed or ended before the send). */
  leave(member: string): void {
    if (this.fired || !this.expected.delete(member)) return;

    if (this.expected.size === 0) this.fire();
  }

  private fire(): void {
    if (this.fired) return;

    this.fired = true;

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const entries = this.waiting.splice(0);

    if (entries.length > 0) void this.dispatch(entries);
  }

  private async dispatch(entries: WaitingRequest[]): Promise<void> {
    let outcomes: PushBatchOutcome[];

    try {
      outcomes = await this.send(entries.map((entry) => entry.request));
    } catch (error) {
      for (const entry of entries) entry.reject(error);

      return;
    }

    entries.forEach((entry, index) => {
      settle(outcomes[index], entry.resolve, entry.reject);
    });
  }

  private async sendAlone(request: PushRequest): Promise<PushSendResult> {
    const [outcome] = await this.send([request]);

    return new Promise<PushSendResult>((resolve, reject) =>
      settle(outcome, resolve, reject),
    );
  }
}

function settle(
  outcome: PushBatchOutcome | undefined,
  resolve: (result: PushSendResult) => void,
  reject: (error: unknown) => void,
): void {
  if (!outcome) {
    reject(new Error("O lote de push não devolveu o resultado desta entrega"));
  } else if (outcome.ok) {
    resolve(outcome.result);
  } else {
    reject(outcome.error);
  }
}

export { PushBatchGate };
export type { PushBatchSender };

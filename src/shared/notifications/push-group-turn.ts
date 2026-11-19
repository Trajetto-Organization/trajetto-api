/**
 * One database turn per push group (plano-escala U-06).
 *
 * A push group is the rows one slot of the internal lane gathers for one
 * call to Expo (notification-pipeline-service.ts, runPushGroup). Each row
 * still does its own reads before the send (the recipient, its devices,
 * the policy's checks) and its own fenced writes after it, and the rows
 * used to do them all at once: with PUSH_BATCH_SIZE=20 and the lane's 5
 * slots, up to 100 deliveries hit the pool of 10 together, and the HTTP
 * requests and the other lanes of the same process waited behind them.
 * The pool's headroom check (queue-config.ts) and the lease reasoning
 * count the lane's slots, so a group must cost what its slot costs.
 *
 * So the rows of a group take turns at the database, one at a time, in
 * the order they asked: a row holds the turn from its start until it
 * hands its message to the group's call, waits for the call without it,
 * and takes it again to settle. Only the send is shared and concurrent.
 * A row never holds the turn while it waits on the call, so the call
 * always gathers every row (or its own timer fires): no row can wait on
 * one that waits on it.
 *
 * `close` is the row's end, however it ended (its backstop included): its
 * turn goes on, its place in line is given up, and a later `enter` of the
 * same row returns at once, so a row the backstop already left (its work
 * still settling late) never takes the turn back from the others.
 */
class PushGroupTurn {
  private holder: string | null = null;

  private readonly line: Array<{ member: string; go: () => void }> = [];

  private readonly closed = new Set<string>();

  /** Waits for the turn; at once for a closed member or the holder. */
  enter(member: string): Promise<void> {
    if (this.closed.has(member) || this.holder === member) {
      return Promise.resolve();
    }

    if (this.holder === null) {
      this.holder = member;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.line.push({ member, go: resolve });
    });
  }

  /** Hands the turn to the next in line, when this member holds it. */
  exit(member: string): void {
    if (this.holder !== member) return;

    this.holder = null;
    this.handOn();
  }

  /** The member ended: never waits again, and holds nothing. */
  close(member: string): void {
    this.closed.add(member);

    const index = this.line.findIndex((waiting) => waiting.member === member);

    if (index >= 0) {
      const [waiting] = this.line.splice(index, 1);

      // It goes on without the turn: its row already ended.
      waiting.go();
    }

    this.exit(member);
  }

  /** Who holds the turn now; for the tests. */
  get current(): string | null {
    return this.holder;
  }

  private handOn(): void {
    while (this.holder === null && this.line.length > 0) {
      const next = this.line.shift()!;

      if (!this.closed.has(next.member)) this.holder = next.member;

      next.go();
    }
  }
}

export { PushGroupTurn };

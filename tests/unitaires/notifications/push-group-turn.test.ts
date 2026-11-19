import { describe, expect, it } from "vitest";

import { PushGroupTurn } from "@/shared/notifications/push-group-turn";

/**
 * The database turn of a push group (plano-escala U-06).
 *
 * The rows of a group used to do their reads and writes all at once, so a
 * group of 20 in each of the internal lane's 5 slots was 100 deliveries on
 * a pool of 10. The turn lets one row of a group at the database at a time,
 * in the order they asked; the pipeline's E2E (push-expo-batch) proves the
 * lane's peak, this the turn's own rules: the order, the hand-on, and that
 * a row its backstop already ended never takes the turn back.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("PushGroupTurn", () => {
  it("lets one member in at a time, in the order they asked", async () => {
    const turn = new PushGroupTurn();
    const order: string[] = [];

    await turn.enter("a");

    const b = turn.enter("b").then(() => order.push("b"));
    const c = turn.enter("c").then(() => order.push("c"));

    await flush();
    expect(order).toEqual([]);
    expect(turn.current).toBe("a");

    turn.exit("a");
    await b;
    expect(turn.current).toBe("b");
    expect(order).toEqual(["b"]);

    turn.close("b");
    await c;
    expect(turn.current).toBe("c");
    expect(order).toEqual(["b", "c"]);
  });

  it("takes the turn back after the call, behind those already in line", async () => {
    const turn = new PushGroupTurn();

    await turn.enter("a");
    const b = turn.enter("b");

    // `a` hands its message to the call and lets the turn go.
    turn.exit("a");
    await b;

    const back = turn.enter("a");
    let a = false;

    void back.then(() => {
      a = true;
    });

    await flush();
    expect(a).toBe(false);

    turn.close("b");
    await back;
    expect(turn.current).toBe("a");
  });

  it("ignores an exit of a member that does not hold the turn", async () => {
    const turn = new PushGroupTurn();

    await turn.enter("a");
    turn.exit("b");

    expect(turn.current).toBe("a");
  });

  it("lets a closed member go at once, holding nothing, and never again in line", async () => {
    const turn = new PushGroupTurn();

    await turn.enter("a");

    // `b` waits for its settling turn when its backstop ends it.
    const b = turn.enter("b");

    turn.close("b");
    await b;
    expect(turn.current).toBe("a");

    // Its late settling asks again: at once, and the holder keeps it.
    await turn.enter("b");
    expect(turn.current).toBe("a");

    turn.close("a");
    expect(turn.current).toBeNull();

    // Nobody is left in line, and a new member gets the turn at once.
    await turn.enter("c");
    expect(turn.current).toBe("c");
  });

  it("hands the turn on when its holder is closed", async () => {
    const turn = new PushGroupTurn();

    await turn.enter("a");
    const b = turn.enter("b");

    turn.close("a");
    await b;

    expect(turn.current).toBe("b");
  });
});

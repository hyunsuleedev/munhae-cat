import { describe, expect, it, vi } from "vitest";

import {
  runProjectTransition,
  type ProjectTransitionKind,
} from "../src/renderer/scripts/project-transition";

const KINDS: ProjectTransitionKind[] = ["create", "open", "seed", "close", "organize"];

describe("renderer project transition boundary", () => {
  it.each(KINDS)("does not start %s when the editor vetoes leaving", async (kind) => {
    const action = vi.fn(async () => ({ ok: true }));
    const committed = vi.fn();

    const outcome = await runProjectTransition(
      kind,
      { before: () => false, committed },
      action,
      (result) => result.ok,
    );

    expect(outcome).toEqual({ started: false });
    expect(action).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it.each(KINDS)("runs and commits %s only after leave approval", async (kind) => {
    const order: string[] = [];

    const outcome = await runProjectTransition(
      kind,
      {
        before: () => {
          order.push("before");
          return true;
        },
        committed: (committedKind) => order.push(`committed:${committedKind}`),
      },
      async () => {
        order.push("action");
        return { ok: true };
      },
      (result) => result.ok,
    );

    expect(outcome).toEqual({ started: true, result: { ok: true } });
    expect(order).toEqual(["before", "action", `committed:${kind}`]);
  });

  it("does not clear dirty state when the main action is cancelled or fails", async () => {
    const committed = vi.fn();
    const cancelled = await runProjectTransition(
      "open",
      { before: () => true, committed },
      async () => ({ ok: true, data: null }),
      (result) => result.ok && result.data !== null,
    );
    const failed = await runProjectTransition(
      "create",
      { before: () => true, committed },
      async () => ({ ok: false }),
      (result) => result.ok,
    );

    expect(cancelled.started).toBe(true);
    expect(failed.started).toBe(true);
    expect(committed).not.toHaveBeenCalled();
  });
});

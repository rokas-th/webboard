import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildAction } from "../actions/build";
import { projectPlan } from "../plan/project";
import { choices } from "../plan/choices";
import { planRules } from "../plan/rules";
import { PlanDoc } from "../store/doc";
import { bigLog } from "../test/fixtures/bigLog";
import { ctxOf, FIXTURE_DEVICES, PLAN_ID } from "../test/planCtx";
import { newId } from "./ids";
import { replay, type LogState } from "./state";
import type { Action } from "./types";

const N = 20_000;
const SIZE_LIMIT = 5_000_000;
const TODAY = "2026-11-09";
const SLOW = { timeout: 120_000 };
const platform = (globalThis as { process?: { platform?: string } }).process?.platform;

let actions: Action[] = [];
let doc: PlanDoc = new PlanDoc(new Y.Doc());

beforeAll(() => {
  const big = bigLog(N, 1);
  expect(big.actions).toHaveLength(N);
  expect(big.items).toBe(1000);
  expect(big.links).toBe(2000);
  expect(new Set(big.actions.map((a) => a.ses)).size).toBe(200);
  actions = big.actions;
  doc = new PlanDoc(new Y.Doc());
  actions.forEach((a) => doc.append(a, []));
}, 120_000);

const fiveRuns = <T>(setup: () => T, fn: (t: T) => void): number[] => {
  fn(setup());
  return Array.from({ length: 5 }, () => {
    const t = setup();
    const t0 = performance.now();
    fn(t);
    return performance.now() - t0;
  }).sort((a, b) => a - b);
};

const shown = (times: readonly number[]): string => times.map((x) => x.toFixed(2)).join(", ");

const median = <T>(label: string, setup: () => T, fn: (t: T) => void): number => {
  const times = fiveRuns(setup, fn);
  console.info(`${label}: median ${times[2].toFixed(2)} ms of [${shown(times)}]`);
  return times[2];
};

const best = <T>(label: string, setup: () => T, fn: (t: T) => void): number => {
  const times = fiveRuns(setup, fn);
  console.info(`${label}: best ${times[0].toFixed(2)} ms of [${shown(times)}]`);
  return times[0];
};

describe("size budget", () => {
  it("reads the platform the timing cases depend on", () => {
    expect(typeof platform).toBe("string");
  });

  it(
    "bigLog(20000, 1) encodes to at most 5,000,000 B",
    SLOW,
    () => {
      const bytes = Y.encodeStateAsUpdate(doc.ydoc).byteLength;
      console.info(`plan document of ${N} actions: ${bytes} B (${(bytes / N).toFixed(1)} B per action)`);
      expect(bytes).toBeLessThanOrEqual(SIZE_LIMIT);
    },
  );
});

describe.runIf(platform === "darwin")("replay budgets on the Mac", () => {
  let log: LogState;

  beforeAll(() => {
    log = replay(actions, planRules);
    expect(log.pending).toEqual([]);
  }, 120_000);

  it(
    "applyUpdate into a fresh doc plus actions() takes at most 150 ms",
    SLOW,
    () => {
      const update = Y.encodeStateAsUpdate(doc.ydoc);
      const ms = median(
        "applyUpdate + actions()",
        () => new Y.Doc(),
        (ydoc) => {
          Y.applyUpdate(ydoc, update);
          expect([...new PlanDoc(ydoc).actions()]).toHaveLength(N);
        },
      );
      expect(ms).toBeLessThanOrEqual(150);
    },
  );

  it(
    "replay(actions, planRules) takes at most 400 ms",
    SLOW,
    () => {
      const ms = best(
        "replay",
        () => null,
        () => {
          expect(replay(actions, planRules).order()).toHaveLength(N);
        },
      );
      expect(ms).toBeLessThanOrEqual(400);
    },
  );

  it(
    "projectPlan plus choices takes at most 60 ms",
    SLOW,
    () => {
      const ms = median(
        "projectPlan + choices",
        () => null,
        () => {
          const plan = projectPlan(PLAN_ID, log);
          expect(plan.items.size).toBe(1000);
          choices(log, plan, FIXTURE_DEVICES);
        },
      );
      expect(ms).toBeLessThanOrEqual(60);
    },
  );

  it(
    "buildAction of a move with pushes, append, add and projectPlan take at most 25 ms",
    SLOW,
    () => {
      const plan = projectPlan(PLAN_ID, log);
      const outgoing = [...plan.links.values()].reduce((m, l) => m.set(l.from, (m.get(l.from) ?? 0) + 1), new Map<string, number>());
      const [mover] = [...outgoing].sort((a, b) => b[1] - a[1])[0];
      const own = new PlanDoc(new Y.Doc());
      Y.applyUpdate(own.ydoc, Y.encodeStateAsUpdate(doc.ydoc));
      const ms = median(
        "buildAction (move with pushes) + append + add + projectPlan",
        () => {
          const fork = log.fork();
          return { fork, ctx: ctxOf(fork, "d1", TODAY) };
        },
        ({ fork, ctx }) => {
          const built = buildAction(ctx, { t: "move", items: [mover], days: 40 });
          expect(built.action.w.some((x) => x.c === "push")).toBe(true);
          own.append(built.action, built.newNotes);
          expect(fork.add([built.action]).refused).toEqual([]);
          projectPlan(PLAN_ID, fork);
        },
      );
      expect(ms).toBeLessThanOrEqual(25);
    },
  );

  it(
    "add of one head action takes at most 2 ms",
    SLOW,
    () => {
      const item = [...projectPlan(PLAN_ID, log).items.keys()][0];
      const ms = median(
        "add of one head action",
        () => ({ fork: log.fork(), action: oneWrite(log.heads, item, "d1") }),
        ({ fork, action }) => {
          expect(fork.add([action]).added).toEqual([action.id]);
        },
      );
      expect(ms).toBeLessThanOrEqual(2);
    },
  );

  it(
    "add of one remote action 5,000 positions back takes at most 10 ms",
    SLOW,
    () => {
      const order = log.order();
      const parent = order[order.length - 5000];
      const item = [...projectPlan(PLAN_ID, log).items.keys()][1];
      const ms = median(
        "add of one remote action 5,000 positions back",
        () => ({ fork: log.fork(), action: oneWrite([parent], item, "d2") }),
        ({ fork, action }) => {
          expect(fork.add([action]).added).toEqual([action.id]);
        },
      );
      expect(ms).toBeLessThanOrEqual(10);
    },
  );

  it(
    "fork() takes at most 20 ms",
    SLOW,
    () => {
      const ms = median(
        "fork()",
        () => null,
        () => {
          log.fork();
        },
      );
      expect(ms).toBeLessThanOrEqual(20);
    },
  );
});

const oneWrite = (par: readonly string[], item: string, dev: string): Action => ({
  id: newId(),
  dev,
  ses: "s-" + dev,
  at: 0,
  par,
  lbl: "Renamed “Review”",
  w: [{ u: `n:${item}`, v: "Budget check", c: "own" }],
});

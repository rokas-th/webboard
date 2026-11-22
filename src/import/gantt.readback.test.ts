import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Write } from "../log/types";
import { existence, name } from "../plan/units";
import { AppError } from "../services/ipc";
import type { ImportResult } from "../store/file";
import { GANTT_FILE, ganttBytes, ganttWithPeople } from "../test/fixtures/gantt";
import { GanttError, importGantt } from "./gantt";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const tamper = vi.hoisted(() => ({
  result: (r: ImportResult): ImportResult => r,
  bytes: (b: Uint8Array): Uint8Array => b,
}));

vi.mock("../store/file", async (actual) => {
  const real = await actual<typeof import("../store/file")>();
  return {
    ...real,
    buildImport: (...a: Parameters<typeof real.buildImport>): ImportResult => {
      const [bytes, ...rest] = a;
      return tamper.result(real.buildImport(tamper.bytes(bytes), ...rest));
    },
  };
});

const run = (bytes: Uint8Array = ganttBytes()) => importGantt({ bytes, fileName: GANTT_FILE, dev: "dev-R", ses: "ses-R", now: Date.UTC(2026, 10, 10) });

const withWrites = (r: ImportResult, edit: (w: readonly Write[]) => Write[]): ImportResult => ({ ...r, action: { ...r.action, w: edit(r.action.w) } });

const caught = (bytes?: Uint8Array): unknown => {
  try {
    run(bytes);
  } catch (e) {
    return e;
  }
  throw new Error("importGantt did not throw");
};

const asBug = (e: unknown, message: RegExp): void => {
  if (!(e instanceof Error)) throw new Error(`not an Error: ${String(e)}`);
  expect(e).not.toBeInstanceOf(GanttError);
  expect(e).not.toBeInstanceOf(AppError);
  expect(e.message).toMatch(message);
};

describe("importGantt reads its own plan back", () => {
  beforeEach(() => {
    tamper.result = (r) => r;
    tamper.bytes = (b) => b;
  });

  it("imports when the read-back matches", () => {
    expect(run().report.name).toBe("Fixture Plan");
  });

  it("refuses a read-back whose plan name differs, as a converter bug", () => {
    tamper.result = (r) => withWrites(r, (ws) => ws.map((w) => (w.u === "pn" ? { ...w, v: name.enc("Other") } : w)));
    asBug(caught(), /^The written plan does not read back as the converted plan:\n- plan name reads back as "Other", not "Fixture Plan"/);
  });

  it("refuses a read-back that lost a link, as a converter bug", () => {
    tamper.result = (r) => withWrites(r, (ws) => ws.filter((w) => !w.u.startsWith("l:")));
    asBug(caught(), /^The written plan does not read back as the converted plan:\n[\s\S]*- the number of links reads back as 0, not 2/);
  });

  it("refuses a read-back that lost an assignment, as a converter bug", () => {
    const bytes = ganttBytes(ganttWithPeople());
    expect(run(bytes).report.counts).toMatchObject({ people: 2, assignments: 3 });
    tamper.result = (r) => withWrites(r, (ws) => ws.filter((w) => !(w.u.startsWith("pa:") && Array.isArray(w.v) && w.v.length === 2)));
    asBug(caught(bytes), /^The written plan does not read back as the converted plan:\n- Task 3 Build: assignees reads back as null, not \["[\w-]+","[\w-]+"\]$/);
  });

  it("refuses a read-back the log rules refuse, as a converter bug", () => {
    tamper.result = (r) => withWrites(r, (ws) => [...ws, ...ws.filter((w) => w.u === "pn")]);
    asBug(caught(), /^The written plan does not read back: /);
  });

  it("refuses bytes it cannot read back, as a converter bug that keeps the cause", () => {
    tamper.bytes = (b) => b.subarray(0, b.length - 4);
    const e = caught();
    asBug(e, /^The converter wrote a plan it cannot read back: This file is incomplete/);
    expect(e).toMatchObject({ cause: expect.any(AppError) });
  });

  it("runs the fidelity check on the read-back plan and refuses it as a GanttError", () => {
    tamper.result = (r) =>
      withWrites(r, (ws) => ws.map((w) => (w.u.startsWith("e:") && JSON.stringify(w.v) === JSON.stringify(existence.enc({ k: "task", t: false })) ? { ...w, v: existence.enc({ k: "task", t: true }) } : w)));
    const e = caught();
    expect(e).toBeInstanceOf(GanttError);
    if (!(e instanceof Error)) throw new Error("not an Error");
    expect(e.message).toMatch(/^WebBoard would show different dates than the \.gantt file:\n- Task \d+ \w+: source .*, WebBoard leaves it unscheduled/);
  });
});

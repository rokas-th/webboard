import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lagThatHolds } from "../../domain/schedule";
import type { PlanSession } from "../../store/session";
import { fs, testSession } from "../../test/session";
import { OpenChoice, type Run } from "../run";
import { FixActions } from "./FixActions";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../../domain/schedule", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../domain/schedule")>();
  return { ...m, lagThatHolds: vi.fn(m.lagThatHolds) };
});

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  vi.mocked(lagThatHolds).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const run: Run = { run: () => null, undo: () => null, redo: () => null };

describe("FixActions", () => {
  it("names the year of a push target that is not this year", async () => {
    const t = await testSession([
      { name: "Build", start: "2027-11-15", dur: 5 },
      { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
    ]);
    sessions.push(t.session);
    render(
      <OpenChoice.Provider value={() => undefined}>
        <FixActions view={t.session.view()} item="Review" readOnly={false} run={run} />
      </OpenChoice.Provider>,
    );
    expect(screen.getByRole("button", { name: "Push “Review” to Mon 22 Nov 2027" })).toBeTruthy();
  });

  it("works out the lag that holds once per view, not once per render", async () => {
    const t = await testSession([
      { name: "Build", start: "2026-11-16", dur: 2 },
      { name: "Review", start: "2026-11-19", dur: 2, status: "doing", progress: 10, deps: [fs("Build", 3)] },
    ]);
    sessions.push(t.session);
    const view = t.session.view();
    const ui = (readOnly: boolean) => (
      <OpenChoice.Provider value={() => undefined}>
        <FixActions view={view} item="Review" readOnly={readOnly} run={run} />
      </OpenChoice.Provider>
    );
    const { rerender } = render(ui(false));
    expect(screen.getByRole("button", { name: "Shorten the lag to 1" })).toBeTruthy();
    rerender(ui(false));
    rerender(ui(false));
    expect(screen.getByRole("button", { name: "Shorten the lag to 1" })).toBeTruthy();
    expect(vi.mocked(lagThatHolds)).toHaveBeenCalledTimes(1);
  });

  it("offers only Remove the link when the lag that holds is past the lag bound", async () => {
    const t = await testSession([
      { name: "Build", start: "2026-11-16", dur: 2 },
      { name: "Review", start: "2026-11-19", dur: 2, status: "doing", progress: 10, deps: [fs("Build", 3)] },
    ]);
    sessions.push(t.session);
    vi.mocked(lagThatHolds).mockReturnValueOnce(-1240);
    render(
      <OpenChoice.Provider value={() => undefined}>
        <FixActions view={t.session.view()} item="Review" readOnly={false} run={run} />
      </OpenChoice.Provider>,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove the link"]);
  });
});

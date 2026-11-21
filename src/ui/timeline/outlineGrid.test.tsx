import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession } from "../../test/session";
import { OpenChoice } from "../run";
import { BareDetail } from "../../test/detail";
import { UiContext, useUi } from "../state";
import { Timeline, type OutlineControl } from "./Timeline";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("./Grid", () => ({ Grid: () => <div className="tl-grid" /> }));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const OUTLINE: OutlineControl = {
  open: true,
  width: 300,
  stored: null,
  min: 160,
  max: 700,
  def: 300,
  phone: false,
  onCommit: () => undefined,
};

const noChoice = (): void => {
  throw new Error("no choice dialog");
};

function Bare(p: { session: PlanSession }) {
  const [ui, setUi] = useUi();
  return (
    <UiContext.Provider value={{ ui, setUi }}>
      <OpenChoice.Provider value={noChoice}>
        <BareDetail>
          <Timeline session={p.session} outline={OUTLINE} />
        </BareDetail>
      </OpenChoice.Provider>
    </UiContext.Provider>
  );
}

describe("the outline pane's grid", () => {
  it("throws, naming the outline pane, when the Timeline renders no #timeline-outline grid", async () => {
    const t = await testSession([{ id: "a", name: "A", start: "2026-12-01", dur: 2 }]);
    sessions.push(t.session);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Bare session={t.session} />)).toThrow("outline pane: the Timeline has no #timeline-outline grid to observe");
  });
});

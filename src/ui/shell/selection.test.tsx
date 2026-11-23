import { act, cleanup, renderHook } from "@testing-library/react";
import { useMemo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { phoneRegistry } from "../../test/phone";
import { testSession } from "../../test/session";
import { clearToasts } from "../common/Toast";
import { UiContext, useUi } from "../state";
import { usePlanSelection } from "./selection";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

function Ui(p: { children: ReactNode }) {
  const [ui, setUi] = useUi("timeline");
  const value = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return <UiContext.Provider value={value}>{p.children}</UiContext.Provider>;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const failing = async (error: unknown, recorded: AppError | null) => {
  const t = await testSession([{ name: "A" }]);
  sessions.push(t.session);
  const registry = await phoneRegistry(t);
  registries.push(registry);
  const id = t.session.view().plan.id;
  const listeners: (() => void)[] = [];
  vi.spyOn(registry, "subscribe").mockImplementation((cb) => {
    listeners.push(cb);
    return () => undefined;
  });
  const failures = vi.spyOn(registry, "failures").mockReturnValue(new Map(recorded === null ? [] : [[id, recorded]]));
  const thrown: unknown[] = [];
  const session = vi.spyOn(registry, "session").mockImplementation(() => {
    const p = Promise.reject(error);
    const then = p.then.bind(p);
    vi.spyOn(p, "then").mockImplementation((ok, bad) => {
      const next = then(ok, bad);
      void next.then(
        () => null,
        (e: unknown) => thrown.push(e),
      );
      return next;
    });
    return p;
  });
  const { result } = renderHook(() => usePlanSelection(registry), { wrapper: Ui });
  await settle();
  const notify = (): void => listeners.forEach((cb) => cb());
  return { id, session, thrown, result, notify, failures };
};

describe("usePlanSelection", () => {
  it("a failure the registry did not record is failed with recorded false, rethrown, and not retried on notify", async () => {
    const error = new AppError("store.io", "Could not read the plan: disk error.");
    const { id, session, thrown, result, notify } = await failing(error, null);
    expect(result.current.main).toEqual({ k: "failed", id, error, recorded: false });
    expect(thrown).toEqual([error]);
    act(() => notify());
    await settle();
    expect(session).toHaveBeenCalledTimes(1);
  });

  it("a failure the registry recorded is failed with recorded true, and loads again once the registry drops it", async () => {
    const error = new AppError("store.io", "Could not read the plan: disk error.");
    const { id, session, thrown, result, notify, failures } = await failing(error, error);
    expect(result.current.main).toEqual({ k: "failed", id, error, recorded: true });
    expect(thrown).toEqual([]);
    failures.mockReturnValue(new Map());
    act(() => notify());
    await settle();
    expect(session).toHaveBeenCalledTimes(2);
  });

  it("an error that is not an AppError is never dressed as one, and is rethrown", async () => {
    const boom = new Error("boom");
    const { id, thrown, result } = await failing(boom, null);
    expect(result.current.main).toEqual({ k: "error", id, message: "boom" });
    expect(thrown).toEqual([boom]);
  });
});

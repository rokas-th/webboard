import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeAsk } from "../../services/alert";
import { IPHONE, MAC, setPlatform } from "../../test/platform";
import { hold, resetTauri, tauri } from "../../test/tauriMock";
import { NativeConfirm, STALE_CONFIRM } from "./NativeConfirm";
import { clearToasts, Toasts } from "./Toast";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const ASK: NativeAsk = { title: "Delete “Alpha” forever?", message: "“Alpha” is erased from this device. This cannot be undone.", confirm: { label: "Delete forever", destructive: true }, cancel: "Cancel" };

const asks = (): number => tauri.calls.filter((c) => c.cmd === "alert_ask").length;
const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);
const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast.bad")).map((e) => e.textContent);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

function Host(p: { shown: boolean; current?: boolean; run(): Promise<void> | void; onClose(): void }) {
  return (
    <>
      <Toasts />
      {p.shown && <NativeConfirm ask={ASK} current={p.current} run={p.run} onClose={p.onClose} />}
    </>
  );
}

beforeEach(() => {
  setPlatform(IPHONE);
  resetTauri({});
  clearToasts();
});

afterEach(() => {
  cleanup();
  clearToasts();
  setPlatform(MAC);
});

describe("NativeConfirm whose owner is gone before the answer", () => {
  it("a confirm after unmount runs nothing and says nothing was changed", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const view = render(<Host shown run={run} onClose={onClose} />);
    await settle();
    expect(asks()).toBe(1);
    view.rerender(<Host shown={false} run={run} onClose={onClose} />);
    act(() => alert.resolve("confirm"));
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(badToasts()).toEqual([STALE_CONFIRM]);
  });

  it("a cancel after unmount runs nothing and shows no toast", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const view = render(<Host shown run={run} onClose={onClose} />);
    await settle();
    view.rerender(<Host shown={false} run={run} onClose={onClose} />);
    act(() => alert.resolve("cancel"));
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("an error after unmount still shows its toast", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const view = render(<Host shown run={run} onClose={vi.fn()} />);
    await settle();
    view.rerender(<Host shown={false} run={run} onClose={vi.fn()} />);
    act(() => alert.reject({ code: "alert.busy", message: "The alert cannot be shown: something else is already presented over the window." }));
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(badToasts()).toEqual(["The alert cannot be shown: something else is already presented over the window."]);
  });

  it("an unmount while the confirmed action runs lets it finish and flags nothing", async () => {
    const alert = hold("alert_ask");
    let finish: () => void = () => {
      throw new Error("the action never started");
    };
    let done = false;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            done = true;
            resolve();
          };
        }),
    );
    const onClose = vi.fn();
    const view = render(<Host shown run={run} onClose={onClose} />);
    await settle();
    act(() => alert.resolve("confirm"));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    view.rerender(<Host shown={false} run={run} onClose={onClose} />);
    act(() => finish());
    await settle();
    expect(done).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([]);
  });

  it("a confirm while the question is no longer current runs nothing and says nothing was changed", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<Host shown current={false} run={run} onClose={onClose} />);
    await settle();
    expect(asks()).toBe(1);
    act(() => alert.resolve("confirm"));
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(badToasts()).toEqual([STALE_CONFIRM]);
  });

  it("a confirm while the question is still current runs the action", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<Host shown current run={run} onClose={onClose} />);
    await settle();
    act(() => alert.resolve("confirm"));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([]);
  });

  it("a question that stops being current and becomes current again before the answer runs the action", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const view = render(<Host shown current run={run} onClose={onClose} />);
    await settle();
    view.rerender(<Host shown current={false} run={run} onClose={onClose} />);
    await settle();
    view.rerender(<Host shown current run={run} onClose={onClose} />);
    await settle();
    act(() => alert.resolve("confirm"));
    await settle();
    expect(asks()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([]);
  });

  it("a question current when asked and no longer current at the answer runs nothing", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const view = render(<Host shown current run={run} onClose={onClose} />);
    await settle();
    view.rerender(<Host shown current={false} run={run} onClose={onClose} />);
    await settle();
    act(() => alert.resolve("confirm"));
    await settle();
    expect(asks()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(badToasts()).toEqual([STALE_CONFIRM]);
  });

  it("an answer that lands after a commit and before its passive effects reads that commit's props", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const control: { stop: (() => void) | null } = { stop: null };
    const busy = (ms: number): void => {
      const until = performance.now() + ms;
      while (performance.now() < until) continue;
    };
    function Gap() {
      const [current, setCurrent] = useState(true);
      useLayoutEffect(() => {
        control.stop = () => setCurrent(false);
      }, []);
      useLayoutEffect(() => {
        if (current) return;
        alert.resolve("confirm");
        busy(20);
      }, [current]);
      return <Host shown current={current} run={run} onClose={onClose} />;
    }
    render(<Gap />);
    await settle();
    expect(asks()).toBe(1);
    const stop = control.stop;
    if (stop === null) throw new Error("Gap never committed");
    const actEnvironment: unknown = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      stop();
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(badToasts()).toEqual([STALE_CONFIRM]);
  });

  it("under StrictMode asks once and runs the action once on confirm", async () => {
    const alert = hold("alert_ask");
    const run = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Host shown run={run} onClose={onClose} />
      </StrictMode>,
    );
    await settle();
    expect(asks()).toBe(1);
    act(() => alert.resolve("confirm"));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([]);
  });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../settings/lastSection";
import { UiContext, useUi, type UiState } from "../state";
import { SettingsRow } from "./PlansSheet";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function Host(p: { seen: { current: UiState | null }; children: ReactNode }) {
  const [ui, setUi] = useUi();
  p.seen.current = ui;
  useEffect(() => setUi({ plan: "plan0000001" }), [setUi]);
  return <UiContext.Provider value={{ ui, setUi }}>{p.children}</UiContext.Provider>;
}

describe("the Settings… row", () => {
  it.each([
    [false, "general"],
    [true, "baselines"],
  ])("opens a saved plan section only when a plan session is open (session %s), whatever plan is selected", (hasPlan, opened) => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, at: "baselines" }));
    const seen: { current: UiState | null } = { current: null };
    const onClose = vi.fn<() => void>();
    render(
      <Host seen={seen}>
        <SettingsRow hasPlan={hasPlan} onClose={onClose} />
      </Host>,
    );
    expect(seen.current?.plan).toBe("plan0000001");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Settings…" }));
    });
    expect([seen.current?.settings, onClose.mock.calls.length, screen.getByRole("button", { name: "Settings…" }).className]).toEqual([opened, 1, "choice-row plans-settings-row"]);
  });
});

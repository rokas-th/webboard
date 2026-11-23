import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession } from "../../test/session";
import { geometry, type Geometry } from "./geometry";
import { gestureIntent, isClick, startIntent } from "./gesture";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
let W: Geometry;
let M: Geometry;

beforeEach(async () => {
  const t = await testSession([
    { id: "t", name: "T", start: "2026-11-13", dur: 3 },
    { id: "c", name: "C", start: "2026-11-23", dur: 2 },
    { id: "f", name: "F", start: "2026-11-11", dur: 3 },
  ]);
  sessions.push(t.session);
  W = geometry(t.session.view(), "W", 1);
  M = geometry(t.session.view(), "M", 1);
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("gestureIntent", () => {
  it("moves by the working days the calendar days reach", () => {
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: 40 })).toEqual({ t: "move", items: ["t"], days: 1 });
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: 200 })).toEqual({ t: "move", items: ["t"], days: 3 });
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: -40 })).toEqual({ t: "move", items: ["t"], days: -1 });
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: -200 })).toEqual({ t: "move", items: ["t"], days: -5 });
    expect(gestureIntent(M, { kind: "move", item: "t", dxPx: 16 })).toEqual({ t: "move", items: ["t"], days: 1 });
  });

  it("issues nothing under 4 px or below one day", () => {
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: 19 })).toBeNull();
    expect(gestureIntent(W, { kind: "move", item: "t", dxPx: -3 })).toBeNull();
    expect(gestureIntent(M, { kind: "move", item: "t", dxPx: 3 })).toBeNull();
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: 3 })).toBeNull();
  });

  it("resizes to the working days up to the dragged end", () => {
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: 80 })).toEqual({ t: "resize", item: "t", dur: 5 });
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: -40 })).toEqual({ t: "resize", item: "t", dur: 2 });
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: -400 })).toEqual({ t: "resize", item: "t", dur: 1 });
  });

  it("issues no resize that ends at the stored duration", () => {
    expect(gestureIntent(W, { kind: "resize", item: "f", dxPx: 40 })).toBeNull();
    expect(gestureIntent(W, { kind: "resize", item: "f", dxPx: 80 })).toBeNull();
    expect(gestureIntent(W, { kind: "resize", item: "f", dxPx: 120 })).toEqual({ t: "resize", item: "f", dur: 4 });
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: 160 })).toEqual({ t: "resize", item: "t", dur: 6 });
    expect(gestureIntent(W, { kind: "resize", item: "t", dxPx: 200 })).toEqual({ t: "resize", item: "t", dur: 6 });
  });

  it("links to another target only", () => {
    expect(gestureIntent(W, { kind: "link", item: "t", dxPx: 0, target: "c" })).toEqual({ t: "link", from: "t", to: "c", type: "FS", lag: 0 });
    expect(gestureIntent(W, { kind: "link", item: "t", dxPx: 0 })).toBeNull();
    expect(gestureIntent(W, { kind: "link", item: "t", dxPx: 120, target: "t" })).toBeNull();
  });

  it("issues nothing for an item without dates", () => {
    expect(gestureIntent(W, { kind: "move", item: "nope", dxPx: 120 })).toBeNull();
  });
});

describe("startIntent", () => {
  it("moves the start and keeps the end", () => {
    expect(startIntent(W, "t", 40)).toEqual({ t: "schedule", item: "t", set: { start: "2026-11-16", dur: 2 } });
    expect(startIntent(W, "t", -40)).toEqual({ t: "schedule", item: "t", set: { start: "2026-11-12", dur: 4 } });
    expect(startIntent(W, "t", 400)).toEqual({ t: "schedule", item: "t", set: { start: "2026-11-17", dur: 1 } });
  });

  it("issues nothing under 4 px or below one day", () => {
    expect(startIntent(W, "t", 3)).toBeNull();
    expect(startIntent(W, "t", 19)).toBeNull();
  });
});

describe("isClick", () => {
  it("is a pointer that moved under 4 px", () => {
    const down = { x: 0, y: 0 };
    expect(isClick(down, { x: 3, y: 0 })).toBe(true);
    expect(isClick(down, { x: 4, y: 0 })).toBe(false);
    expect(isClick(down, { x: 3, y: 3 })).toBe(false);
    expect(isClick(down, { x: 0, y: 0 })).toBe(true);
  });
});

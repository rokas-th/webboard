import { describe, expect, it } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing } from "../../store/registry";
import type { UpdateState } from "../../store/updates";
import { failureShown, listAttention } from "./sidebarAttention";

const listing = (id: PlanId, o: Partial<PlanListing> = {}): PlanListing => ({ id, name: id, trashed: false, loaded: true, space: null, example: false, ...o });

const bad = new AppError("store.corrupt", "plan p2 could not be read");

const ATTENTION_UPDATES: readonly UpdateState[] = [
  { k: "available", version: "9.9.9" },
  { k: "installFailed", version: "9.9.9", message: "disk full" },
];

const QUIET_UPDATES: readonly (UpdateState | null)[] = [
  null,
  { k: "idle" },
  { k: "checking" },
  { k: "current", at: 0 },
  { k: "downloading", version: "9.9.9", percent: 50 },
  { k: "installing", version: "9.9.9" },
  { k: "checkFailed", message: "offline" },
  { k: "closeFailed", version: "9.9.9", line: "x" },
  { k: "restartFailed", version: "9.9.9", line: "x" },
];

describe("failureShown", () => {
  it("shows a failure on a plan that is not the open, loaded one", () => {
    const failures = new Map([["p2", bad]]);
    expect(failureShown(listing("p2"), failures, "p1")).toBe(true);
    expect(failureShown(listing("p2"), failures, null)).toBe(true);
    expect(failureShown(listing("p2", { loaded: false }), failures, "p2")).toBe(true);
  });

  it("does not show it on the open, loaded plan, which shows its own banner", () => {
    expect(failureShown(listing("p2"), new Map([["p2", bad]]), "p2")).toBe(false);
  });

  it("does not show a plan without a failure or a trashed plan", () => {
    expect(failureShown(listing("p1"), new Map([["p2", bad]]), null)).toBe(false);
    expect(failureShown(listing("p2", { trashed: true }), new Map([["p2", bad]]), null)).toBe(false);
  });
});

describe("listAttention", () => {
  const none = new Map<PlanId, AppError>();
  const plans = [listing("p1"), listing("p2")];

  it("is off while the list is shown, whatever it holds", () => {
    expect(listAttention({ open: true, plans, failures: new Map([["p2", bad]]), selected: "p1", update: ATTENTION_UPDATES[0] })).toBe(false);
  });

  it("is off for a hidden list with nothing to act on", () => {
    QUIET_UPDATES.forEach((update) => expect(listAttention({ open: false, plans, failures: none, selected: "p1", update })).toBe(false));
  });

  it("is on for a hidden list holding a plan failure it would show", () => {
    expect(listAttention({ open: false, plans, failures: new Map([["p2", bad]]), selected: "p1", update: null })).toBe(true);
  });

  it("is off for a hidden list whose only failure is the open plan's, or a trashed plan's", () => {
    expect(listAttention({ open: false, plans, failures: new Map([["p1", bad]]), selected: "p1", update: null })).toBe(false);
    expect(listAttention({ open: false, plans: [listing("p1"), listing("p2", { trashed: true })], failures: new Map([["p2", bad]]), selected: "p1", update: null })).toBe(false);
  });

  it("is on for a hidden list with an update to install, and off for a failed check", () => {
    ATTENTION_UPDATES.forEach((update) => expect(listAttention({ open: false, plans, failures: none, selected: "p1", update })).toBe(true));
    expect(listAttention({ open: false, plans, failures: none, selected: "p1", update: { k: "checkFailed", message: "offline" } })).toBe(false);
  });
});

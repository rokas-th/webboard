import { describe, expect, it } from "vitest";
import { AppError } from "../../services/ipc";
import { failureActions } from "./failure";

const corrupt = new AppError("store.corrupt", "Bad record in seg-0.log.");

describe("failureActions", () => {
  it("offers Try again for every code but store.corrupt", () => {
    expect(failureActions(new AppError("store.locked", "Locked by another process."), "S1", true)).toEqual({ action: "retry", filesStay: false });
  });

  it("offers Move to Trash for a corrupt local-only plan, whose files stay", () => {
    expect(failureActions(corrupt, null, false)).toEqual({ action: "trash", filesStay: true });
  });

  it("offers Load again from the server for a corrupt space plan", () => {
    expect(failureActions(corrupt, "S1", false)).toEqual({ action: "reload", filesStay: false });
  });

  it("offers nothing for a corrupt space plan while the space is read-only, whose files stay", () => {
    expect(failureActions(corrupt, "S1", true)).toEqual({ action: null, filesStay: true });
  });
});

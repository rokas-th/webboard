import { describe, expect, it, vi } from "vitest";
import { chipText, type SyncState } from "./manager";
import { syncActions } from "./reload";

vi.mock("../store/plan-id", async (importOriginal) => ({ ...(await importOriginal<typeof import("../store/plan-id")>()), SPACE_PREFIX: "sx-" }));

const failed = (code: "too-large" | "rejected", doc: string): SyncState => ({ kind: "error", code, since: 0, doc, waiting: 0, message: null, cause: null, op: null });

describe("the plan-list prefix", () => {
  it("comes from the store, so sync names a plan list by the store's prefix", () => {
    expect(chipText(failed("too-large", "sx-S1"), () => "Launch")).toBe("The plan list is too large to sync");
    expect(chipText(failed("too-large", "ix-S1"), () => "Launch")).toBe("Too large to sync: Launch");
    expect(syncActions(failed("rejected", "sx-S1"), true)).toEqual(["retry"]);
    expect(syncActions(failed("rejected", "ix-S1"), true)).toEqual(["export", "retry"]);
  });
});

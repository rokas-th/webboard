import { describe, expect, it } from "vitest";
import type { SyncState } from "./manager";
import { canReload, stopsArrival, syncActions } from "./reload";

type Code = Extract<SyncState, { kind: "error" }>["code"];

const err = (code: Code, doc: string | null = null): SyncState => ({ kind: "error", code, since: 0, doc, waiting: 0, message: "m", cause: null, op: null });

const PLAIN: readonly SyncState[] = [{ kind: "off" }, { kind: "offline", waiting: 0 }, { kind: "syncing" }, { kind: "synced" }, { kind: "receiving" }];

describe("reload rules", () => {
  it("canReload follows refinement 32", () => {
    const no: SyncState[] = [{ kind: "off" }, { kind: "offline", waiting: 0 }, ...(["revoked", "unauthorized", "keychain", "not-configured", "limited", "unreachable", "failed"] as const).map((c) => err(c))];
    const yes: SyncState[] = [{ kind: "synced" }, { kind: "syncing" }, { kind: "receiving" }, ...(["local-failed", "store-failed", "rejected", "too-large"] as const).map((c) => err(c))];
    expect(no.map(canReload)).toEqual(no.map(() => false));
    expect(yes.map(canReload)).toEqual(yes.map(() => true));
  });

  it("stopsArrival follows refinement 46", () => {
    const yes: SyncState[] = [
      ...(["too-large", "rejected", "store-failed", "failed"] as const).map((c) => err(c, "S")),
      ...(["revoked", "unauthorized", "not-configured", "keychain", "failed", "local-failed"] as const).map((c) => err(c)),
    ];
    const no: SyncState[] = [
      ...(["too-large", "rejected", "store-failed"] as const).flatMap((c) => [err(c, "L"), err(c, "ix-sp000000000")]),
      ...(["local-failed", "limited", "unreachable"] as const).map((c) => err(c, "S")),
      err("local-failed", "ix-sp000000000"),
      ...PLAIN,
    ];
    expect(yes.map((s) => stopsArrival(s, "S"))).toEqual(yes.map(() => true));
    expect(no.map((s) => stopsArrival(s, "S"))).toEqual(no.map(() => false));
  });

  it("syncActions follows the table", () => {
    const rows: [SyncState, boolean, readonly string[]][] = [
      ...PLAIN.flatMap((s): [SyncState, boolean, readonly string[]][] => [
        [s, true, []],
        [s, false, []],
      ]),
      [err("revoked"), true, []],
      [err("unauthorized"), true, []],
      [err("local-failed", "ix-sp000000000"), true, []],
      [err("local-failed", "ix-sp000000000"), false, []],
      [err("local-failed"), true, ["reset", "retry"]],
      [err("local-failed"), false, ["reset", "retry"]],
      ...(["rejected", "too-large", "store-failed"] as const).flatMap((c): [SyncState, boolean, readonly string[]][] => [
        [err(c, "P"), true, ["export", "retry"]],
        [err(c, "P"), false, ["retry"]],
        [err(c, "ix-sp000000000"), true, ["retry"]],
        [err(c, "ix-sp000000000"), false, ["retry"]],
      ]),
      ...(["keychain", "not-configured", "failed", "limited", "unreachable"] as const).flatMap((c): [SyncState, boolean, readonly string[]][] => [
        [err(c), true, ["retry"]],
        [err(c, "P"), false, ["retry"]],
      ]),
    ];
    expect(rows.map(([s, holds]) => syncActions(s, holds))).toEqual(rows.map(([, , want]) => want));
  });
});

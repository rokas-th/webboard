import * as Y from "yjs";
import { PlanDoc } from "../../store/doc";
import { encodeWbx } from "../../store/file";
import { act } from "../act";

function build(): Uint8Array {
  const doc = new Y.Doc();
  new PlanDoc(doc).append(
    act(
      "a0",
      [],
      [
        { u: "pn", v: "Bridge", c: "own" },
        { u: "cw", v: [1, 2, 3, 4, 5], c: "own" },
        { u: "cr", v: null, c: "own" },
        { u: "e:T1", v: { k: "task", t: false }, c: "own" },
        { u: "n:T1", v: "Survey", c: "own" },
        { u: "s:T1", v: ["2026-11-09", 3, "todo", 0, "now"], c: "own" },
        { u: "p:T1", v: [null, "a0"], c: "own" },
        { u: "e:T2", v: { k: "task", t: false }, c: "own" },
        { u: "n:T2", v: "Build", c: "own" },
        { u: "s:T2", v: ["2026-11-09", 3, "todo", 0, "now"], c: "own" },
        { u: "p:T2", v: [null, "a1"], c: "own" },
      ],
      { dev: "dev-A" },
    ),
    ["T1", "T2"],
  );
  const update = Y.encodeStateAsUpdate(doc);
  return encodeWbx({ planId: "P0000000000", name: "Bridge", exportedAt: "2026-11-08T14:05:00Z", updateLength: update.length }, update);
}

export const VALID_WEBBOARD: { bytes: Uint8Array; plan: { name: "Bridge"; items: 2 } } = {
  bytes: build(),
  plan: { name: "Bridge", items: 2 },
};

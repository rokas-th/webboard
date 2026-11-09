import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { bindTextarea, LOCAL_NOTE } from "./noteBinding";

const disposers: (() => void)[] = [];

afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
});

function pair(initial: string) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.getText("note").insert(0, initial);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const toA = (update: Uint8Array, origin: unknown): void => {
    if (origin !== "remote") Y.applyUpdate(a, update, "remote");
  };
  const toB = (update: Uint8Array, origin: unknown): void => {
    if (origin !== "remote") Y.applyUpdate(b, update, "remote");
  };
  b.on("update", toA);
  a.on("update", toB);
  const el = document.createElement("textarea");
  document.body.append(el);
  const binding = bindTextarea(el, a.getText("note"));
  disposers.push(() => binding.dispose());
  return { a, b, el, binding, local: a.getText("note"), remote: b.getText("note") };
}

const type = (el: HTMLTextAreaElement, value: string, caret: number): void => {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("bindTextarea", () => {
  it("shows the text it binds", () => {
    const { el } = pair("abc");
    expect(el.value).toBe("abc");
  });

  it("writes one insert for a typed character", () => {
    const { el, local } = pair("abc");
    const deltas: unknown[] = [];
    const origins: unknown[] = [];
    local.observe((e, tr) => {
      deltas.push(e.delta);
      origins.push(tr.origin);
    });
    type(el, "abXc", 3);
    expect(deltas).toEqual([[{ retain: 2 }, { insert: "X" }]]);
    expect(origins).toEqual([LOCAL_NOTE]);
    expect(local.toString()).toBe("abXc");
  });

  it("writes a replaced range as one delete and one insert in one transaction", () => {
    const { el, local } = pair("hello world");
    const deltas: unknown[] = [];
    local.observe((e) => deltas.push(e.delta));
    type(el, "hello there world", 11);
    type(el, "help world", 3);
    expect(deltas).toEqual([[{ retain: 6 }, { insert: "there " }], [{ retain: 3 }, { delete: 8 }, { insert: "p" }]]);
    expect(local.toString()).toBe("help world");
  });

  it("keeps the caret where it was when a remote edit lands before it", () => {
    const { el, remote } = pair("abc");
    type(el, "abXc", 3);
    remote.insert(0, ">> ");
    expect(el.value).toBe(">> abXc");
    expect(el.selectionStart).toBe(6);
    expect(el.selectionEnd).toBe(6);
  });

  it("undoes and redoes only its own edits", () => {
    const { el, binding, remote, local } = pair("abc");
    type(el, "abXc", 3);
    remote.insert(0, ">> ");
    expect(binding.undo()).toBe(true);
    expect(el.value).toBe(">> abc");
    expect(local.toString()).toBe(">> abc");
    expect(remote.toString()).toBe(">> abc");
    expect(binding.undo()).toBe(false);
    expect(el.value).toBe(">> abc");
    expect(binding.redo()).toBe(true);
    expect(el.value).toBe(">> abXc");
    expect(remote.toString()).toBe(">> abXc");
    expect(binding.redo()).toBe(false);
  });

  it("stops following the text and the textarea once disposed", () => {
    const { el, binding, local, remote } = pair("abc");
    disposers.splice(0);
    binding.dispose();
    remote.insert(0, "R");
    expect(el.value).toBe("abc");
    type(el, "abcd", 4);
    expect(local.toString()).toBe("Rabc");
  });
});

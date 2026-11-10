import { afterEach, describe, expect, it } from "vitest";
import { isTyping, keyToCommand, type KeyInput, type KeyState } from "./keymap";

const k = (key: string, o: Partial<KeyInput> = {}): KeyInput => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

const MAC: KeyState = { mac: true, typing: false, dialog: false, selected: false };
const PC: KeyState = { ...MAC, mac: false };

describe("keyToCommand on macOS", () => {
  it("opens the palette on ⌘K even while typing, and not while a dialog is open", () => {
    expect(keyToCommand(k("k", { metaKey: true }), MAC)).toBe("palette");
    expect(keyToCommand(k("K", { metaKey: true }), { ...MAC, typing: true })).toBe("palette");
    expect(keyToCommand(k("k", { metaKey: true }), { ...MAC, dialog: true })).toBeNull();
    expect(keyToCommand(k("k", { metaKey: true }), { ...MAC, dialog: true, typing: true })).toBeNull();
    expect(keyToCommand(k("k", { ctrlKey: true }), MAC)).toBeNull();
  });

  it("undoes on ⌘Z and redoes on ⇧⌘Z, not while typing", () => {
    expect(keyToCommand(k("z", { metaKey: true }), MAC)).toBe("undo");
    expect(keyToCommand(k("Z", { metaKey: true, shiftKey: true }), MAC)).toBe("redo");
    expect(keyToCommand(k("z", { metaKey: true }), { ...MAC, typing: true })).toBeNull();
    expect(keyToCommand(k("z", { metaKey: true, shiftKey: true }), { ...MAC, typing: true })).toBeNull();
    expect(keyToCommand(k("z", { ctrlKey: true }), MAC)).toBeNull();
  });

  it("does not take Ctrl+Y as redo", () => {
    expect(keyToCommand(k("y", { ctrlKey: true }), MAC)).toBeNull();
    expect(keyToCommand(k("y", { metaKey: true }), MAC)).toBeNull();
  });

  it("maps single keys only when neither typing nor in a dialog", () => {
    const sel = { ...MAC, selected: true };
    const cases: [KeyInput, string][] = [
      [k("n"), "new-task"],
      [k("N", { shiftKey: true }), "new-task"],
      [k("1"), "view-timeline"],
      [k("2"), "view-board"],
      [k("3"), "view-list"],
      [k("ArrowRight"), "nudge+1"],
      [k("ArrowLeft"), "nudge-1"],
      [k("ArrowRight", { altKey: true }), "nudge+5"],
      [k("ArrowLeft", { altKey: true }), "nudge-5"],
      [k("ArrowRight", { shiftKey: true }), "resize+1"],
      [k("ArrowLeft", { shiftKey: true }), "resize-1"],
      [k("ArrowRight", { shiftKey: true, altKey: true }), "resize+5"],
      [k("ArrowLeft", { shiftKey: true, altKey: true }), "resize-5"],
      [k("Delete"), "trash"],
      [k("Backspace"), "trash"],
    ];
    expect(cases.map(([e]) => keyToCommand(e, sel))).toEqual(cases.map(([, id]) => id));
    expect(cases.map(([e]) => keyToCommand(e, { ...sel, typing: true }))).toEqual(cases.map(() => null));
    expect(cases.map(([e]) => keyToCommand(e, { ...sel, dialog: true }))).toEqual(cases.map(() => null));
  });

  it("needs a selection for arrows and Delete", () => {
    expect(["ArrowRight", "ArrowLeft", "Delete", "Backspace"].map((key) => keyToCommand(k(key), MAC))).toEqual([null, null, null, null]);
    expect(keyToCommand(k("n"), MAC)).toBe("new-task");
  });

  it("closes a dialog on Esc, else deselects", () => {
    expect(keyToCommand(k("Escape"), { ...MAC, dialog: true })).toBe("close-dialog");
    expect(keyToCommand(k("Escape"), { ...MAC, dialog: true, typing: true })).toBe("close-dialog");
    expect(keyToCommand(k("Escape"), { ...MAC, selected: true })).toBe("deselect");
    expect(keyToCommand(k("Escape"), MAC)).toBe("deselect");
    expect(keyToCommand(k("Escape"), { ...MAC, typing: true })).toBeNull();
  });

  it("leaves other keys alone", () => {
    expect(["4", "a", "Enter", "Tab", " "].map((key) => keyToCommand(k(key), { ...MAC, selected: true }))).toEqual([null, null, null, null, null]);
    expect(keyToCommand(k("1", { metaKey: true }), MAC)).toBeNull();
    expect(keyToCommand(k("n", { altKey: true }), MAC)).toBeNull();
  });
});

describe("keyToCommand off macOS", () => {
  it("uses Ctrl, and ⌘K does nothing", () => {
    expect(keyToCommand(k("k", { ctrlKey: true }), PC)).toBe("palette");
    expect(keyToCommand(k("k", { metaKey: true }), PC)).toBeNull();
    expect(keyToCommand(k("z", { ctrlKey: true }), PC)).toBe("undo");
    expect(keyToCommand(k("z", { ctrlKey: true, shiftKey: true }), PC)).toBe("redo");
    expect(keyToCommand(k("z", { metaKey: true }), PC)).toBeNull();
  });

  it("redoes on Ctrl+Y, not while typing", () => {
    expect(keyToCommand(k("y", { ctrlKey: true }), PC)).toBe("redo");
    expect(keyToCommand(k("y", { ctrlKey: true }), { ...PC, typing: true })).toBeNull();
    expect(keyToCommand(k("y", { ctrlKey: true, shiftKey: true }), PC)).toBeNull();
  });

  it("maps the single keys the same way", () => {
    expect(keyToCommand(k("ArrowRight", { altKey: true }), { ...PC, selected: true })).toBe("nudge+5");
    expect(keyToCommand(k("2"), PC)).toBe("view-board");
  });
});

describe("keyToCommand in a dialog or a text field", () => {
  it("leaves undo and redo to the dialog: ⌘Z, ⇧⌘Z and Ctrl+Y give null", () => {
    expect(keyToCommand(k("z", { metaKey: true }), { ...MAC, dialog: true })).toBeNull();
    expect(keyToCommand(k("z", { metaKey: true, shiftKey: true }), { ...MAC, dialog: true })).toBeNull();
    expect(keyToCommand(k("z", { ctrlKey: true }), { ...PC, dialog: true })).toBeNull();
    expect(keyToCommand(k("z", { ctrlKey: true, shiftKey: true }), { ...PC, dialog: true })).toBeNull();
    expect(keyToCommand(k("y", { ctrlKey: true }), { ...PC, dialog: true })).toBeNull();
  });

  it("does nothing on Ctrl K off macOS while a dialog is open", () => {
    expect(keyToCommand(k("k", { ctrlKey: true }), { ...PC, dialog: true })).toBeNull();
    expect(keyToCommand(k("k", { ctrlKey: true }), { ...PC, dialog: true, typing: true })).toBeNull();
    expect(keyToCommand(k("k", { ctrlKey: true }), { ...PC, typing: true })).toBe("palette");
  });

  it("leaves Esc to the text field outside a dialog", () => {
    expect(keyToCommand(k("Escape"), { ...MAC, typing: true, selected: true })).toBeNull();
    expect(keyToCommand(k("Escape"), { ...PC, typing: true, selected: true })).toBeNull();
  });
});

describe("isTyping", () => {
  const made = (html: string): Element => {
    const box = document.createElement("div");
    box.innerHTML = html;
    document.body.append(box);
    const el = box.querySelector("[data-t]");
    if (el === null) throw new Error("no target in " + html);
    return el;
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("counts text fields and editable content as typing", () => {
    const typing = [
      '<input data-t type="text">',
      "<input data-t>",
      '<input data-t type="search">',
      '<input data-t type="email">',
      '<input data-t type="url">',
      '<input data-t type="tel">',
      '<input data-t type="password">',
      '<input data-t type="number">',
      '<input data-t type="date">',
      "<textarea data-t></textarea>",
      "<select data-t></select>",
      '<div data-t contenteditable=""></div>',
      '<div data-t contenteditable="true"></div>',
      '<div data-t contenteditable="plaintext-only"></div>',
      '<div contenteditable=""><p data-t>x</p></div>',
    ];
    expect(typing.filter((h) => ["n", "ArrowRight", "Escape"].some((key) => !isTyping(made(h), key)))).toEqual([]);
  });

  it("leaves the arrow keys to a range or a radio, and nothing else", () => {
    const stepped = ['<input data-t type="range">', '<input data-t type="radio">'];
    expect(stepped.map((h) => ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "n", "2", "Delete", "Escape"].map((key) => isTyping(made(h), key)))).toEqual(
      stepped.map(() => [true, true, true, true, false, false, false, false]),
    );
  });

  it("does not count checkboxes, radios, ranges, buttons or plain elements for N, 1-3 or Delete", () => {
    const not = [
      '<input data-t type="checkbox">',
      '<input data-t type="radio">',
      '<input data-t type="range">',
      "<button data-t>x</button>",
      "<div data-t></div>",
      '<div contenteditable=""><p data-t contenteditable="false">x</p></div>',
    ];
    expect(not.filter((h) => ["n", "2", "Delete"].some((key) => isTyping(made(h), key)))).toEqual([]);
    expect(isTyping(null, "n")).toBe(false);
    expect(isTyping(window, "n")).toBe(false);
  });
});

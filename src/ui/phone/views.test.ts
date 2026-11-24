import { describe, expect, it, vi } from "vitest";
import { PHONE_VIEWS, phoneViewPatch, scrollToStart } from "./views";

describe("PHONE_VIEWS", () => {
  it("is Timeline, Board, List in that order", () => {
    expect(PHONE_VIEWS).toEqual([
      ["timeline", "Timeline"],
      ["board", "Board"],
      ["list", "List"],
    ]);
  });
});

describe("phoneViewPatch", () => {
  it("is null for the view already shown", () => {
    expect(PHONE_VIEWS.map(([v]) => phoneViewPatch(v, v))).toEqual([null, null, null]);
  });

  it("clears the query on any move to the Timeline", () => {
    expect(phoneViewPatch("list", "timeline")).toEqual({ view: "timeline", query: "" });
    expect(phoneViewPatch("board", "timeline")).toEqual({ view: "timeline", query: "" });
  });

  it("keeps the query between List and Board and from the Timeline", () => {
    expect(phoneViewPatch("list", "board")).toEqual({ view: "board" });
    expect(phoneViewPatch("board", "list")).toEqual({ view: "list" });
    expect(phoneViewPatch("timeline", "list")).toEqual({ view: "list" });
  });
});

const scrolls = (): [unknown, unknown][] => {
  const m = vi.mocked(Element.prototype.scrollTo);
  return m.mock.contexts.map((el, i) => [el, m.mock.calls[i]?.[0]]);
};

const page = (html: string): Document => {
  const doc = document.implementation.createHTMLDocument("page");
  doc.body.innerHTML = html;
  return doc;
};

const one = (doc: Document, selector: string): Element => {
  const el = doc.querySelector(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};

const BOARD = `<div class="phone-main"><div class="step-bar"><button class="step-tab" data-page="todo" aria-selected="false"></button><button class="step-tab" data-page="doing" aria-selected="true"></button></div><div class="board-pages"><section class="board-page" data-page="todo"></section><section class="board-page" data-page="doing"></section></div></div>`;

describe("scrollToStart", () => {
  it("scrolls the Timeline's scroller to the top and keeps its left", () => {
    const doc = page(`<div class="phone-main"><div class="tl-scroll"></div></div>`);
    scrollToStart(doc, "timeline", true);
    expect(scrolls()).toEqual([[one(doc, ".tl-scroll"), { top: 0, behavior: "smooth" }]]);
  });

  it("scrolls the List's main area to the top", () => {
    const doc = page(`<div class="phone-main"><ul></ul></div>`);
    scrollToStart(doc, "list", false);
    expect(scrolls()).toEqual([[one(doc, ".phone-main"), { top: 0, behavior: "auto" }]]);
  });

  it("scrolls the Board page of the selected step to the top, and no other page", () => {
    const doc = page(BOARD);
    scrollToStart(doc, "board", true);
    expect(scrolls()).toEqual([[one(doc, '.board-page[data-page="doing"]'), { top: 0, behavior: "smooth" }]]);
  });

  it("does nothing on a Board without pages", () => {
    const doc = page(`<div class="phone-main"><div class="phone-board"><p class="note"></p></div></div>`);
    scrollToStart(doc, "board", true);
    expect(scrolls()).toEqual([]);
  });

  it.each([
    ["timeline", `<div class="phone-main"></div>`, ".phone-main .tl-scroll"],
    ["list", `<div class="other"></div>`, ".phone-main"],
    ["board", BOARD.replace('aria-selected="true"', 'aria-selected="false"'), '.phone-main .step-tab[aria-selected="true"]'],
    ["board", BOARD.replace('<section class="board-page" data-page="doing"></section>', ""), '.phone-main .board-page[data-page="doing"]'],
  ] as const)("throws naming the missing scroller of the %s", (view, html, named) => {
    expect(() => scrollToStart(page(html), view, true)).toThrow(`scrollToStart(${view}) found no ${named}`);
    expect(scrolls()).toEqual([]);
  });

  it("throws naming the selected step tab when it has no data-page", () => {
    const doc = page(BOARD.replace('data-page="doing" aria-selected="true"></button>', 'aria-selected="true">Doing</button>'));
    expect(() => scrollToStart(doc, "board", true)).toThrow('scrollToStart(board) found the selected step tab "Doing" without a data-page');
    expect(scrolls()).toEqual([]);
  });
});

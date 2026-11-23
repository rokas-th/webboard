import { describe, expect, it } from "vitest";

type Decls = Record<string, string>;

interface Rule {
  selector: string;
  decls: Decls;
  conditions: readonly string[];
}

interface Stop {
  stop: string;
  decls: Decls;
}

interface Sheet {
  rules: Rule[];
  frames: Map<string, Stop[]>;
}

function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\") out += css[i++];
        out += css[i++];
      }
      out += css[i++] ?? "";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function blocks(src: string): Array<{ prelude: string; body: string }> {
  const out: Array<{ prelude: string; body: string }> = [];
  let prelude = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      let depth = 1;
      const start = ++i;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      out.push({ prelude: prelude.trim(), body: src.slice(start, i - 1) });
      prelude = "";
      continue;
    }
    if (ch === ";" && prelude.trim().startsWith("@")) {
      prelude = "";
      i++;
      continue;
    }
    prelude += ch;
    i++;
  }
  return out;
}

function declarations(body: string): Decls {
  const decls: Decls = {};
  let depth = 0;
  let buf = "";
  const flush = () => {
    const at = buf.indexOf(":");
    if (at > 0) decls[buf.slice(0, at).trim()] = buf.slice(at + 1).trim();
    buf = "";
  };
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return decls;
}

function collect(src: string, conditions: readonly string[], sheet: Sheet): void {
  for (const { prelude, body } of blocks(src)) {
    if (prelude.startsWith("@keyframes")) {
      sheet.frames.set(
        prelude.slice("@keyframes".length).trim(),
        blocks(body).map((b) => ({ stop: b.prelude, decls: declarations(b.body) })),
      );
      continue;
    }
    if (prelude.startsWith("@")) {
      collect(body, [...conditions, prelude], sheet);
      continue;
    }
    const decls = declarations(body);
    for (const sel of prelude.split(",")) {
      const selector = sel.trim().replace(/\s+/g, " ");
      if (selector !== "") sheet.rules.push({ selector, decls, conditions });
    }
  }
}

function parse(css: string): Sheet {
  const sheet: Sheet = { rules: [], frames: new Map() };
  collect(stripComments(css), [], sheet);
  return sheet;
}

const SHEETS: Record<string, string> = import.meta.glob("./*.css", { query: "?raw", import: "default", eager: true });

const RAW = Object.values(SHEETS).join("\n");

const sheet = parse(RAW);

const SOURCES: Record<string, string> = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

const CODE = Object.entries(SOURCES)
  .filter(([name]) => !/\.test\.tsx?$/.test(name))
  .map(([, source]) => source)
  .join("\n");

const TOKENS = new Set(CODE.match(/[A-Za-z_][\w-]*/g) ?? []);

const PREFIXES = (CODE.match(/[A-Za-z][\w-]*\$\{/g) ?? []).map((m) => m.slice(0, -2)).filter((p) => p.length >= 3);

const ALLOWED: Record<string, string> = {};

function rendered(cls: string): boolean {
  if (TOKENS.has(cls)) return true;
  return PREFIXES.some((p) => cls !== p && cls.startsWith(p));
}

const styled = new Set(sheet.rules.flatMap((r) => (r.selector.match(/\.[A-Za-z][\w-]*/g) ?? []).map((c) => c.slice(1))));

describe("every class the stylesheets style", () => {
  it("reads the sources and sheets it is asserting against", () => {
    expect(Object.keys(SHEETS).sort()).toEqual(["./base.css", "./board.css", "./calendar.css", "./choices.css", "./detail.css", "./list.css", "./palette.css", "./panel.css", "./people.css", "./phone.css", "./print.css", "./settings.css", "./sheet.css", "./shell.css", "./sync.css", "./theme.css", "./timeline.css", "./tokens.css"]);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(40);
    expect(CODE.length).toBeGreaterThan(100000);
    expect(styled.size).toBeGreaterThan(60);
    expect(rendered("entry-name")).toBe(true);
    expect(rendered("a-class-nothing-renders")).toBe(false);
  });

  it("is rendered by something, or named in the allowlist with a reason", () => {
    const dead = [...styled].filter((c) => !rendered(c) && ALLOWED[c] === undefined).sort();
    expect(dead).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    expect(Object.keys(ALLOWED).filter((c) => rendered(c))).toEqual([]);
  });
});

describe("the Cyberdeck look", () => {
  it("never scrolls the document", () => {
    ["html", "body", "#root"].forEach((sel) => {
      const own = sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0);
      expect(own.some((r) => r.decls["overflow"] === "hidden")).toBe(true);
    });
  });

  it("has no backdrop-filter, text-shadow or drop-shadow", () => {
    expect(sheet.rules.length).toBeGreaterThan(100);
    const found = sheet.rules.flatMap((r) =>
      Object.entries(r.decls).flatMap(([k, v]) => (k === "backdrop-filter" || k === "-webkit-backdrop-filter" || k === "text-shadow" || v.includes("drop-shadow(") ? [`${r.selector} { ${k}: ${v} }`] : [])),
    );
    expect(found).toEqual([]);
    expect(RAW).not.toMatch(/backdrop-filter|text-shadow|drop-shadow\(/);
  });

  it("breathes only breathe-cyan, for 3 s, and only when motion is welcome", () => {
    expect([...sheet.frames.keys()]).toEqual(["breathe-cyan"]);
    const animated = sheet.rules.filter((r) => r.decls["animation"] !== undefined || r.decls["animation-name"] !== undefined);
    animated.forEach((r) => {
      const value = r.decls["animation"] ?? "";
      expect(value.split(/\s+/)).toContain("breathe-cyan");
      expect(value.split(/\s+/)).toContain("3s");
      expect(r.conditions.some((c) => c.includes("prefers-reduced-motion: no-preference"))).toBe(true);
    });
    expect(sheet.rules.some((r) => r.decls["transition"] !== undefined)).toBe(true);
  });

  it("keeps magenta for danger", () => {
    const allowed = (sel: string): boolean => /bad|conflict|danger|magenta|\.x:/.test(sel) || sel.includes(".legend .lc");
    const users = sheet.rules.filter((r) => Object.entries(r.decls).some(([k, v]) => k !== "--s-magenta" && /var\(--magenta(-rgb)?\)/.test(v)));
    expect(users.length).toBeGreaterThan(3);
    expect(users.filter((r) => !allowed(r.selector)).map((r) => r.selector)).toEqual([]);
  });

  it("keeps the iPad's Board hold targets free of text selection, the callout and browser pans, as the Timeline's are", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    const hold = { "touch-action": "pan-x pan-y", "-webkit-touch-callout": "none", "-webkit-user-select": "none", "user-select": "none" };
    const timeline = decls(".bar");
    expect(Object.keys(hold).map((k) => timeline[k])).toEqual(Object.values(hold));
    ['html[data-os="ios"] .card:not(.card-draft)', 'html[data-os="ios"] .col-head', 'html[data-os="ios"] .col-strip'].forEach((sel) => {
      expect([sel, decls(sel)]).toEqual([sel, expect.objectContaining(hold)]);
    });
    expect(decls('html[data-os="ios"] .col-head .col-rename')).toEqual(expect.objectContaining({ "-webkit-user-select": "text", "user-select": "text" }));
  });

  it("stacks a Board popover above its scrim: a positioned popover with the float's z-index", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    const scrim = decls(".popover-scrim");
    const pop = decls(".board-float .popover");
    expect([pop["position"], Number(pop["z-index"]) > Number(scrim["z-index"])]).toEqual(["relative", true]);
  });

  it("keeps the amber day-off edge on a bar that is also a conflict", () => {
    const both = sheet.rules.find((r) => r.selector === ".bar.dayoff.conflict" && r.conditions.length === 0);
    expect(both?.decls["border-left-color"]).toBe("var(--amber)");
  });

  it("anchors every absolute box to a positioned box in its pane", () => {
    const anchors: Record<string, string> = {
      ".choice-popover": ".plan-head",
      ".plan-menu-list": ".plan-menu",
      ".tl-month": ".tl-scale",
      ".tl-tick": ".tl-scale",
      ".tl-today-label": ".tl-scale",
      ".tl-row": ".tl-rows",
      ".tl-grid::after": ".tl-grid",
      ".tl-rowline": ".tl-chart",
      ".tl-off": ".tl-chart",
      ".tl-today": ".tl-chart",
      ".tl-links": ".tl-chart",
      ".bar": ".tl-chart",
      ".bar-label": ".tl-chart",
      ".gbar": ".tl-chart",
      ".ms": ".tl-chart",
      ".ghost": ".tl-chart",
      ".drop-ghost": ".tl-chart",
      ".bar .fill": ".bar",
      ".bar .h": ".bar",
      ".nub": ".bar",
      ".gbar::before": ".gbar",
      ".gbar::after": ".gbar",
      ".ms::before": ".ms",
      ".theme-pv-side": ".theme-preview",
      ".theme-pv-done": ".theme-preview",
      ".theme-pv-doing": ".theme-preview",
      ".theme-pv-held": ".theme-preview",
      ".theme-pv-today": ".theme-preview",
      ".theme-pv-danger": ".theme-preview",
      ".theme-switch::after": ".theme-switch",
      "[data-pane-divider]::before": "[data-pane-divider]",
      '.toolbar .sidebar-toggle[data-attention="true"]::after': ".toolbar .sidebar-toggle",
      'html[data-os="ios"] .toolbar button:not(.overlay *)::before': 'html[data-os="ios"] .toolbar button:not(.overlay *)',
      'html[data-os="ios"] .phone-head button:not(.overlay *)::before': 'html[data-os="ios"] .phone-head button:not(.overlay *)',
      'html[data-os="ios"] .phone-views button::before': 'html[data-os="ios"] .phone-views button',
      'html[data-os="ios"] .phone-status button::before': 'html[data-os="ios"] .phone-status button',
      'html[data-os="ios"] .sidebar button::before': 'html[data-os="ios"] .sidebar button',
      'html[data-os="ios"] .sheet-head button::before': 'html[data-os="ios"] .sheet-head button',
      'html[data-os="ios"] .modal-actions button::before': 'html[data-os="ios"] .modal-actions button',
      'html[data-os="ios"] .modal-head button::before': 'html[data-os="ios"] .modal-head button',
      'html[data-os="ios"] .drawer-head button::before': 'html[data-os="ios"] .drawer-head button',
      ".sheet-grabber": ".sheet",
      ".sheet-close::after": ".sheet-close",
      ".modal-close::after": ".modal-close",
      ".drawer-close::after": ".drawer-close",
      ".inspector-close::after": ".inspector-close",
      ".palette-close::after": ".palette-close",
      ".popover-close::before": ".popover-close",
      'html[data-os="ios"] .popover-close::after': 'html[data-os="ios"] .popover-close',
      'html[data-os="ios"] .popover-close::before': 'html[data-os="ios"] .popover-close',
      'html[data-os="ios"] .palette-close::before': 'html[data-os="ios"] .palette-close',
      'html[data-os="ios"] .panel .actions button::before': 'html[data-os="ios"] .panel .actions button',
      'html[data-os="ios"] .sync-tabs button::before': 'html[data-os="ios"] .sync-tabs button',
      'html[data-os="ios"] .sync-buttons button::before': 'html[data-os="ios"] .sync-buttons button',
      'html[data-os="ios"] .banner button::before': 'html[data-os="ios"] .banner button',
      'html[data-os="ios"] .choice-banner button::before': 'html[data-os="ios"] .choice-banner button',
      'html[data-os="ios"] .settings-row .settings-control button::before': 'html[data-os="ios"] .settings-row .settings-control button',
      ".settings-count": ".settings-side",
      "table.list .sort-said": "table.list th",
      ".search-field .search-glass": ".search-field",
      ".search-field .search-count": ".search-field",
      ".list-edge": ".app-body",
      ".plan-overlay-layer": ".app-body",
      ".plan-overlay-scrim": ".plan-overlay-layer",
      ".plan-overlay": ".plan-overlay-layer",
      ".inspector-overlay-layer": ".app-body",
      ".inspector-overlay-scrim": ".inspector-overlay-layer",
      ".inspector-overlay": ".inspector-overlay-layer",
      '.tl-frame > [data-pane-divider="outline"]': ".tl-frame",
      ".outline-strip": ".tl-frame",
      ".outline-strip::before": ".outline-strip",
    };
    const positioned = ["relative", "absolute", "sticky"];
    const absolute = sheet.rules.filter((r) => r.decls["position"] === "absolute" && r.conditions.length === 0).map((r) => r.selector);
    expect(absolute.sort()).toEqual(Object.keys(anchors).sort());
    Object.values(anchors).forEach((anchor) => {
      expect([anchor, sheet.rules.some((r) => r.selector === anchor && positioned.includes(r.decls["position"] ?? ""))]).toEqual([anchor, true]);
    });
    expect(sheet.rules.some((r) => r.selector === ".tl-scroll" && r.decls["position"] === "relative" && r.decls["overflow"] === "auto")).toBe(true);
  });

  it("sizes the detail head's steps at 28 px and 44 pt on iOS, the position in mono and dim", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    [".detail-prev", ".detail-next", ".detail-expand"].forEach((sel) => {
      expect([sel, decls(sel)["width"], decls(sel)["height"]]).toEqual([sel, "28px", "28px"]);
      expect([sel, decls(`${IOS} ${sel}`)["width"], decls(`${IOS} ${sel}`)["height"]]).toEqual([sel, "44px", "44px"]);
    });
    expect([decls(".detail-head")["display"], decls(".detail-head")["align-items"]]).toEqual(["flex", "center"]);
    expect([decls(".mono")["font-family"], decls(".detail-pos")["color"]]).toEqual(["var(--mono)", "var(--dim)"]);
  });

  it("sizes the item modal 720 px by 80 vh, inside the window, a column whose body scrolls, narrower on an iPad", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    const m = decls(".modal.modal-item");
    expect([m["width"], m["height"], m["max-height"], m["display"], m["flex-direction"], m["overflow"]]).toEqual(["720px", "80vh", "calc(100% - 40px)", "flex", "column", "hidden"]);
    expect(decls(`${IOS} .modal.modal-item`)["width"]).toBe("min(720px, 100% - 48px)");
    const body = decls(".modal-item-body");
    expect([body["flex"], body["min-height"], body["overflow-y"]]).toEqual(["1 1 auto", "0", "auto"]);
  });

  it("sizes the Settings modal 780 by 580 px inside the window, a sidebar of 212 px beside a main column, each scrolling on its own", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    const m = decls(".modal.modal-settings");
    expect([m["display"], m["flex-direction"], m["width"], m["height"], m["max-width"], m["max-height"], m["padding"], m["overflow"]]).toEqual([
      "flex",
      "column",
      "780px",
      "580px",
      "calc(100% - 32px)",
      "calc(100% - 32px)",
      "0",
      "hidden",
    ]);
    const ios = decls(`${IOS} .modal.modal-settings`);
    expect([ios["width"], ios["height"]]).toEqual(["min(780px, 100% - 48px)", "min(580px, 100% - 48px)"]);
    const layout = decls(".settings-layout");
    expect([layout["display"], layout["grid-template-columns"], layout["min-height"]]).toEqual(["grid", "212px minmax(0, 1fr)", "0"]);
    expect([decls(".settings-side")["overflow-y"], decls(".settings-main")["overflow-y"], decls(".settings-side")["border-inline-end"]]).toEqual(["auto", "auto", "1px solid var(--line)"]);
    const title = decls(".settings-nav-title");
    expect([title["font-family"], title["font-size"], title["text-transform"], title["color"]]).toEqual(["var(--display)", "10px", "uppercase", "var(--amber)"]);
    const active = decls('.settings-nav-item[aria-current="page"]');
    expect([active["border-color"], active["box-shadow"], active["color"]]).toEqual(["var(--cyan-dim)", "inset 2px 0 0 var(--cyan)", "var(--heading)"]);
    expect([decls(".settings-nav-item")["min-height"], decls(`${IOS} .settings-nav-item`)["min-height"]]).toEqual(["30px", "44px"]);
  });

  it("holds a phone sheet at 52 % on the medium detent and full height on the large one", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect([decls('html[data-form="phone"] .sheet[data-detent="medium"]')["height"], decls('html[data-form="phone"] .sheet[data-detent="large"]')["height"]]).toEqual(["52%", "100%"]);
    expect([decls(".sheet-actions")["display"], decls(".sheet-actions")["flex"]]).toEqual(["flex", "none"]);
  });

  it("lines the summary rows with 1 px --line, 44 pt on iOS", () => {
    const decls = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect([decls(".summary-row")["border-bottom"], decls(".summary-rows")["border-top"], decls(`${IOS} .summary-row`)["min-height"]]).toEqual([
      "1px solid var(--line)",
      "1px solid var(--line)",
      "44px",
    ]);
    expect(decls(`${IOS} .inspector-close`)).toEqual({ width: "44px", height: "44px" });
  });

  it("clips every name to one line", () => {
    [".entry-name", ".plan-head h1", ".plan-head .plan-name-input", ".choice-row", ".tl-row .name", ".list-name", ".palette-label", ".plan-summary .summary-name"].forEach((sel) => {
      const decls = Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
      expect([sel, decls["overflow"], decls["text-overflow"], decls["white-space"]]).toEqual([sel, "hidden", "ellipsis", "nowrap"]);
    });
  });

  it("clamps a board card title to two lines", () => {
    const decls = Object.assign({}, ...sheet.rules.filter((r) => r.selector === ".card-name" && r.conditions.length === 0).map((r) => r.decls));
    expect([decls["display"], decls["-webkit-line-clamp"], decls["-webkit-box-orient"], decls["overflow"], decls["white-space"]]).toEqual(["-webkit-box", "2", "vertical", "hidden", "normal"]);
  });

  it("sizes the shared modal at 520 px and the wide calendar modal at 600 px", () => {
    const widths = (sel: string): string[] => sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0 && r.decls["width"] !== undefined).map((r) => r.decls["width"] ?? "");
    expect(widths(".modal")).toEqual(["520px"]);
    expect(widths(".modal.modal-wide")).toEqual(["600px"]);
  });

  it("pulls the dialog head's ✕ to the leading corner with logical margins, so it follows right-to-left", () => {
    const heads = sheet.rules.filter((r) => r.selector === ".modal-head" || r.selector === 'html[data-os="ios"] .modal-head');
    expect(heads.map((r) => [r.selector, r.decls["margin-block"], r.decls["margin-inline"], ["margin", "margin-left", "margin-right"].filter((m) => r.decls[m] !== undefined)])).toEqual([
      [".modal-head", "-6px 10px", "-10px 0", []],
      ['html[data-os="ios"] .modal-head', "-12px 0", "-16px 0", []],
    ]);
  });

  it("clips the panel's name inputs with an ellipsis", () => {
    [".panel .title-input", ".panel .baseline-name"].forEach((sel) => {
      const decls = Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
      expect([sel, decls["overflow"], decls["text-overflow"]]).toEqual([sel, "hidden", "ellipsis"]);
    });
  });

  it("keeps a card's group path and a month label on one line with an ellipsis, the month clipped so its label can stick", () => {
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect([".card-meta .card-group", ".tl-month"].map((sel) => [sel, plain(sel)["overflow"], plain(sel)["text-overflow"], plain(sel)["white-space"]])).toEqual([
      [".card-meta .card-group", "hidden", "ellipsis", "nowrap"],
      [".tl-month", "clip", "ellipsis", "nowrap"],
    ]);
    expect([plain(".tl-month-text")["display"], plain(".tl-month-text")["position"], plain(".tl-month-text")["left"]]).toEqual(["inline-block", "sticky", "calc(var(--grid-w) + 8px)"]);
  });

  it("keeps the TODAY pill under the pinned corner and fades the chart in from the task column", () => {
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect(Number(plain(".tl-today-label")["z-index"])).toBeLessThan(Number(plain(".tl-corner")["z-index"]));
    const fade = plain(".tl-grid::after");
    expect([fade["left"], fade["width"], fade["background"], fade["pointer-events"]]).toEqual(["calc(100% + 1px)", "28px", "linear-gradient(to right, var(--void), transparent)", "none"]);
  });

  it("insets the toolbar for the traffic lights only on macOS", () => {
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect(plain(".toolbar")["padding"]).toBe("0 24px");
    expect(plain(".toolbar.toolbar-mac")["padding-left"]).toBe("96px");
    expect(sheet.rules.filter((r) => r.decls["padding"]?.includes("96px") === true || r.decls["padding-left"] === "96px").map((r) => r.selector)).toEqual([".toolbar.toolbar-mac"]);
  });

  it("tightens the toolbar below 1240 px and hides the wordmark only in the compact form", () => {
    const narrow = (sel: string): Decls =>
      Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 1 && r.conditions[0] === "@media (max-width: 1240px)").map((r) => r.decls));
    expect(narrow(".toolbar")["gap"]).toBe("6px");
    expect(narrow(".toolbar > button")["padding"]).toBe("7px 10px");
    expect(narrow(".seg-modes button")["padding"]).toBe("4px 8px");
    expect(sheet.rules.filter((r) => r.selector.includes(".wordmark") && r.decls["display"] === "none").map((r) => [r.selector, r.conditions])).toEqual([
      ['html[data-form="compact"] .wordmark', []],
    ]);
  });

  it("draws every pane divider from one rule set: a 1 px line, cyan on hover, focus and drag, 8 px hit and 44 px on touch", () => {
    const under = (sel: string, conditions: readonly string[]): Decls =>
      Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.join(" | ") === conditions.join(" | ")).map((r) => r.decls));
    const line = under("[data-pane-divider]::before", []);
    expect([line["width"], line["left"], line["background"], line["cursor"]]).toEqual(["8px", "-4px", "linear-gradient(var(--line), var(--line)) 4px 0 / 1px 100% no-repeat", "col-resize"]);
    expect(under("[data-pane-divider]", [])["flex"]).toBe("0 0 1px");
    const trailing = under('[data-pane-divider="inspector"]::before', []);
    expect([trailing["left"], trailing["background-position"]]).toEqual(["0", "0 0"]);
    ["[data-pane-divider]::before", '[data-pane-divider="inspector"]::before'].forEach((sel) => {
      const coarse = under(sel, ["@media (pointer: coarse)"]);
      expect([sel, coarse["width"], coarse["left"], coarse["background-position"]]).toEqual([sel, "44px", "-22px", "22px 0"]);
    });
    const cyan = "linear-gradient(var(--cyan), var(--cyan))";
    expect(under("[data-pane-divider]:hover::before", ["@media (hover: hover)"])["background-image"]).toBe(cyan);
    [
      "[data-pane-divider]:focus-visible::before",
      'html.sidebar-dragging [data-pane-divider="list"]::before',
      'html.inspector-dragging [data-pane-divider="inspector"]::before',
      'html.outline-dragging [data-pane-divider="outline"]::before',
    ].forEach((sel) => {
      expect([sel, under(sel, [])["background-image"]]).toEqual([sel, cyan]);
    });
    expect(sheet.rules.filter((r) => r.selector.includes("resizer")).map((r) => r.selector)).toEqual([]);
  });

  it("gives the list drawer a 20 pt leading edge strip that leaves vertical panning to the page", () => {
    const edge = Object.assign({}, ...sheet.rules.filter((r) => r.selector === ".list-edge" && r.conditions.length === 0).map((r) => r.decls));
    expect([edge["left"], edge["top"], edge["bottom"], edge["width"], edge["touch-action"], edge["z-index"]]).toEqual(["0", "0", "0", "calc(20px + env(safe-area-inset-left))", "pan-y", "20"]);
  });

  it("tiers the outline by its own width off the phone, and collapses it to an 8 px strip with a wider hit", () => {
    const under = (sel: string, conditions: readonly string[]): Decls =>
      Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.join(" | ") === conditions.join(" | ")).map((r) => r.decls));
    expect([under(".tl-grid", [])["container-type"], under(".tl-corner", [])["container-type"]]).toEqual(["inline-size", "inline-size"]);
    const hidden = (sel: string, query: string): string | undefined => under(sel, [query])["display"];
    expect([
      hidden('html:not([data-form="phone"]) .tl-corner .days', "@container (width < 219px)"),
      hidden('html:not([data-form="phone"]) .tl-row .days', "@container (width < 219px)"),
      hidden('html:not([data-form="phone"]) .tl-row .dot', "@container (width < 179px)"),
    ]).toEqual(["none", "none", "none"]);
    expect(sheet.rules.filter((r) => r.conditions.some((c) => c.startsWith("@container")) && !r.selector.startsWith('html:not([data-form="phone"]) '))).toEqual([]);
    const divider = under('.tl-frame > [data-pane-divider="outline"]', []);
    expect([divider["position"], divider["left"]]).toEqual(["absolute", "calc(var(--grid-w) - 1px)"]);
    expect(under('.tl-frame[data-pane-snap="outline"]', [])["--grid-w"]).toBe("8px !important");
    expect(['.tl-frame[data-outline="collapsed"] .tl-grid', '.tl-frame[data-pane-snap="outline"] .tl-corner'].map((sel) => under(sel, [])["visibility"])).toEqual(["hidden", "hidden"]);
    const strip = under(".outline-strip", []);
    expect([strip["position"], strip["left"], strip["width"]]).toEqual(["absolute", "0", "8px"]);
    expect(strip["z-index"]).toBe("21");
    expect([under(".outline-strip::before", [])["width"], under(".outline-strip::before", ["@media (pointer: coarse)"])["width"]]).toEqual(["28px", "44px"]);
    expect(under(".outline-collapse", [])["width"]).toBe("44px");
  });

  it("fills each link arrowhead from the token its path is stroked with", () => {
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect([".tl-links path", ".tl-links path.hot", ".tl-links path.bad"].map((sel) => plain(sel)["stroke"])).toEqual(["var(--cyan-dim)", "var(--cyan)", "var(--magenta)"]);
    expect([".tl-links marker path", ".tl-links marker.hot path", ".tl-links marker.bad path"].map((sel) => plain(sel)["fill"])).toEqual(["var(--cyan-dim)", "var(--cyan)", "var(--magenta)"]);
    expect(plain(".tl-links marker path")["stroke"]).toBe("none");
  });

  it("styles the converted report's list like the calendar dialog's list", () => {
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    const day = plain(".day-list");
    expect(plain(".converted-dropped")).toEqual(day);
    expect([day["list-style"], day["font-variant-numeric"]]).toEqual(["none", "tabular-nums"]);
  });

  it("tints timeline greys with --dim's channels", () => {
    const timeline = SHEETS["./timeline.css"];
    if (timeline === undefined) throw new Error("timeline.css not read");
    expect(timeline).not.toMatch(/90,\s*107,\s*133/);
    const plain = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
    expect([plain(".tl-tick.off")["color"], plain(".tl-off")["background"], plain(".ghost")["background"]]).toEqual([
      "rgba(var(--dim-rgb), 0.55)",
      "rgba(var(--dim-rgb), 0.055)",
      "rgba(var(--dim-rgb), 0.75)",
    ]);
  });

  it("lets a swipe that starts on a tray chip scroll the tray", () => {
    const chip = sheet.rules.filter((r) => r.selector === ".tray-chip" && r.decls["touch-action"] !== undefined).map((r) => [r.conditions.length, r.decls["touch-action"]]);
    expect(chip).toEqual([[0, "pan-x pan-y"]]);
  });

  it("hides the print sheet on screen and only the app when printing, on a landscape page (product-8)", () => {
    const under = (sel: string, media: string): Decls =>
      Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 1 && r.conditions[0] === media).map((r) => r.decls));
    expect(under(".print-sheet", "@media screen")["display"]).toBe("none");
    expect(under("#root", "@media print")["display"]).toBe("none");
    expect(under(".print-sheet", "@media print")["display"]).toBe("block");
    expect(under(".print-sheet", "@media print")["print-color-adjust"]).toBe("exact");
    const page = under("html", "@media print");
    expect([page["height"], page["overflow"], page["background"]]).toEqual(["auto", "visible", "#FFFFFF"]);
    expect(under("body", "@media print")).toEqual(page);
    expect(under(".print-table thead", "@media print")["display"]).toBe("table-header-group");
    expect(under(".print-table tr", "@media print")["break-inside"]).toBe("avoid");
    expect(under(".print-table tr.print-group", "@media print")["break-after"]).toBe("avoid");
    expect(SHEETS["./print.css"].replace(/\s+/g, " ")).toContain("@page { size: landscape; margin: 12mm; }");
    expect(sheet.rules.filter((r) => r.selector.includes("print-") && !r.conditions.some((c) => c === "@media print" || c === "@media screen"))).toEqual([]);
  });

  it("draws print bars and the today line as borders, so they print with backgrounds off (product-8)", () => {
    const under = (sel: string): Decls => Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.includes("@media print")).map((r) => r.decls));
    expect([under(".print-bar")["height"], under(".print-bar")["border-top"]]).toEqual(["0", "2.6mm solid #2B6E80"]);
    expect(under(".print-bar.done")["border-top-color"]).toBe("#9DBFC7");
    expect(under(".print-today")["width"]).toBe("0");
    expect(under(".print-today")["border-left"]).toMatch(/^0\.3mm solid #/);
    expect(sheet.rules.filter((r) => r.selector.startsWith(".print-") && r.decls["background"] !== undefined && r.decls["background"] !== "#FFFFFF")).toEqual([]);
  });
});

const IOS = 'html[data-os="ios"]';
const PRESS = `:where(${IOS})`;

const BUTTON_HOVERS = [
  "button:hover:not(:disabled)",
  ".button-primary:hover:not(:disabled)",
  ".button-danger:hover:not(:disabled)",
  ".seg button:hover:not(:disabled)",
  ".entry:hover",
  ".entry-open:hover:not(:disabled)",
  "button.chip:hover:not(:disabled)",
  ".chip-button:hover:not(:disabled)",
  ".line-button:hover:not(:disabled)",
  ".x:hover:not(:disabled)",
  ".sync-remove.danger:hover:not(:disabled)",
  ".theme-card:hover:not(:disabled)",
  '.theme-card[aria-pressed="true"]:hover:not(:disabled)',
  ".tl-row .caret:hover",
  ".sheet-close:hover:not(:disabled)",
  ".modal-close:hover:not(:disabled)",
  ".drawer-close:hover:not(:disabled)",
  ".inspector-close:hover:not(:disabled)",
  ".popover-close:hover:not(:disabled)",
  ".palette-close:hover:not(:disabled)",
];

describe("iOS presses", () => {
  const hoverOf = (sel: string): Decls => {
    const found = sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 1 && r.conditions[0] === "@media (hover: hover)");
    expect([sel, found.length]).toEqual([sel, 1]);
    return found[0].decls;
  };

  it("never flashes the tap highlight", () => {
    expect(sheet.rules.filter((r) => r.selector === IOS && r.conditions.length === 0).map((r) => r.decls["-webkit-tap-highlight-color"])).toEqual(["transparent"]);
  });

  it("shows each button's hover treatment while it is pressed on iOS, at the hover rule's own specificity", () => {
    const pressed = BUTTON_HOVERS.map((sel) => {
      const active = `${PRESS} ${sel.replace(":hover", ":active")}`;
      const rules = sheet.rules.filter((r) => r.selector === active && r.conditions.length === 0);
      return [active, rules.map((r) => r.decls)];
    });
    expect(pressed).toEqual(BUTTON_HOVERS.map((sel) => [`${PRESS} ${sel.replace(":hover", ":active")}`, [hoverOf(sel)]]));
  });

  it("has a press twin for every button hover, and no other press rule", () => {
    const twins = sheet.rules.filter((r) => r.selector.includes(":active")).map((r) => r.selector);
    expect(twins.sort()).toEqual(BUTTON_HOVERS.map((sel) => `${PRESS} ${sel.replace(":hover", ":active")}`).sort());
  });

  it("presses nothing off iOS", () => {
    expect(sheet.rules.filter((r) => r.selector.includes(":active") && !r.selector.startsWith(`${PRESS} `)).map((r) => r.selector)).toEqual([]);
  });

  it("draws no focus ring on a sheet or dialog that took focus on opening, on iOS only", () => {
    const off = sheet.rules.filter((r) => r.decls["outline"] === "none" && /\.(sheet|modal)\b/.test(r.selector)).map((r) => [r.selector, r.conditions]);
    expect(off).toEqual([
      [`${IOS} .sheet:focus-visible`, []],
      [`${IOS} .modal:focus-visible`, []],
    ]);
  });

  it("renders every field on iOS at 16 px or more, so focusing one does not zoom", () => {
    const fields = sheet.rules.filter((r) => r.selector.startsWith(`${IOS} `) && r.decls["font-size"] !== undefined && /^(input|select|textarea)$/.test(r.selector.slice(IOS.length + 1)));
    expect(fields.map((r) => [r.selector, r.decls["font-size"], r.conditions])).toEqual(["input", "select", "textarea"].map((f) => [`${IOS} ${f}`, "max(16px, 1em) !important", []]));
  });
});

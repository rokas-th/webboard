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
    expect(Object.keys(SHEETS).sort()).toEqual(["./base.css", "./board.css", "./calendar.css", "./choices.css", "./list.css", "./palette.css", "./panel.css", "./phone.css", "./print.css", "./sheet.css", "./shell.css", "./sync.css", "./theme.css", "./timeline.css", "./tokens.css"]);
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
    const users = sheet.rules.filter((r) => Object.values(r.decls).some((v) => /var\(--magenta(-rgb)?\)/.test(v)));
    expect(users.length).toBeGreaterThan(3);
    expect(users.filter((r) => !allowed(r.selector)).map((r) => r.selector)).toEqual([]);
  });

  it("keeps the amber day-off edge on a bar that is also a conflict", () => {
    const both = sheet.rules.find((r) => r.selector === ".bar.dayoff.conflict" && r.conditions.length === 0);
    expect(both?.decls["border-left-color"]).toBe("var(--amber)");
  });

  it("anchors every absolute box to a positioned box in its pane", () => {
    const anchors: Record<string, string> = {
      ".choice-list": ".plan-head",
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
      ".sidebar-resizer::before": ".sidebar-resizer",
      '.toolbar .sidebar-toggle[data-attention="true"]::after': ".toolbar .sidebar-toggle",
      'html[data-os="ios"] .toolbar button:not(.overlay *)::before': 'html[data-os="ios"] .toolbar button:not(.overlay *)',
      'html[data-os="ios"] .phone-head button:not(.overlay *)::before': 'html[data-os="ios"] .phone-head button:not(.overlay *)',
      'html[data-os="ios"] .phone-views button::before': 'html[data-os="ios"] .phone-views button',
      'html[data-os="ios"] .phone-status button::before': 'html[data-os="ios"] .phone-status button',
      'html[data-os="ios"] .sidebar button::before': 'html[data-os="ios"] .sidebar button',
      'html[data-os="ios"] .sheet-head button::before': 'html[data-os="ios"] .sheet-head button',
      'html[data-os="ios"] .modal-actions button::before': 'html[data-os="ios"] .modal-actions button',
      'html[data-os="ios"] .panel .actions button::before': 'html[data-os="ios"] .panel .actions button',
      'html[data-os="ios"] .settings-head button::before': 'html[data-os="ios"] .settings-head button',
      'html[data-os="ios"] .settings-tabs button::before': 'html[data-os="ios"] .settings-tabs button',
      'html[data-os="ios"] .sync-tabs button::before': 'html[data-os="ios"] .sync-tabs button',
      'html[data-os="ios"] .sync-buttons button::before': 'html[data-os="ios"] .sync-buttons button',
      'html[data-os="ios"] .banner button::before': 'html[data-os="ios"] .banner button',
      'html[data-os="ios"] .choice-banner button::before': 'html[data-os="ios"] .choice-banner button',
      'html[data-os="ios"][data-idiom="pad"] .plan-overlay-layer': 'html[data-os="ios"][data-idiom="pad"] .app-body',
      'html[data-os="ios"][data-idiom="pad"] .plan-overlay-scrim': 'html[data-os="ios"][data-idiom="pad"] .plan-overlay-layer',
      'html[data-os="ios"][data-idiom="pad"] .plan-overlay': 'html[data-os="ios"][data-idiom="pad"] .plan-overlay-layer',
    };
    const positioned = ["relative", "absolute", "sticky"];
    const absolute = sheet.rules.filter((r) => r.decls["position"] === "absolute" && r.conditions.length === 0).map((r) => r.selector);
    expect(absolute.sort()).toEqual(Object.keys(anchors).sort());
    Object.values(anchors).forEach((anchor) => {
      expect([anchor, sheet.rules.some((r) => r.selector === anchor && positioned.includes(r.decls["position"] ?? ""))]).toEqual([anchor, true]);
    });
    expect(sheet.rules.some((r) => r.selector === ".tl-scroll" && r.decls["position"] === "relative" && r.decls["overflow"] === "auto")).toBe(true);
  });

  it("clips every name to one line", () => {
    [".entry-name", ".plan-head h1", ".plan-head .plan-name-input", ".choice-row", ".tl-row .name", ".list-name", ".palette-label"].forEach((sel) => {
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

  it("lights the resize handle on hover the way its pointer draws the focus accent", () => {
    const under = (sel: string, conditions: readonly string[]): Decls =>
      Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.join(" | ") === conditions.join(" | ")).map((r) => r.decls));
    const coarseAccent = under(".sidebar-resizer:focus-visible::before", ["@media (pointer: coarse)"]);
    expect(coarseAccent["background"]).toBe("linear-gradient(var(--cyan), var(--cyan)) 9px 0 / 2px 100% no-repeat");
    expect(under("html.sidebar-dragging .sidebar-resizer::before", ["@media (pointer: coarse)"])).toEqual(coarseAccent);
    expect(under(".sidebar-resizer::before", ["@media (pointer: coarse)"])["border-left"]).toBe("none");
    expect(under(".sidebar-resizer:hover::before", ["@media (hover: hover)"])["border-left-color"]).toBe("var(--cyan)");
    expect(under(".sidebar-resizer:hover::before", ["@media (hover: hover)", "@media (pointer: coarse)"])["background"]).toBe(coarseAccent["background"]);
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

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
    expect(Object.keys(SHEETS).sort()).toEqual(["./base.css", "./board.css", "./calendar.css", "./choices.css", "./list.css", "./palette.css", "./panel.css", "./shell.css", "./timeline.css", "./tokens.css"]);
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
    const users = sheet.rules.filter((r) => Object.values(r.decls).some((v) => v.includes("var(--magenta)")));
    expect(users.length).toBeGreaterThan(3);
    expect(users.filter((r) => !allowed(r.selector)).map((r) => r.selector)).toEqual([]);
  });

  it("keeps the amber day-off edge on a bar that is also a conflict", () => {
    const both = sheet.rules.find((r) => r.selector === ".bar.dayoff.conflict" && r.conditions.length === 0);
    expect(both?.decls["border-left-color"]).toBe("var(--amber)");
  });

  it("anchors every absolute box to a positioned box in its pane", () => {
    const anchors: Record<string, string> = {
      ".seg-modes": ".toolbar",
      ".choice-list": ".plan-head",
      ".tl-month": ".tl-scale",
      ".tl-tick": ".tl-scale",
      ".tl-today-label": ".tl-scale",
      ".tl-row": ".tl-rows",
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
    };
    const positioned = ["relative", "absolute"];
    const absolute = sheet.rules.filter((r) => r.decls["position"] === "absolute" && r.conditions.length === 0).map((r) => r.selector);
    expect(absolute.sort()).toEqual(Object.keys(anchors).sort());
    Object.values(anchors).forEach((anchor) => {
      expect([anchor, sheet.rules.some((r) => r.selector === anchor && positioned.includes(r.decls["position"] ?? ""))]).toEqual([anchor, true]);
    });
    expect(sheet.rules.some((r) => r.selector === ".tl-scroll" && r.decls["position"] === "relative" && r.decls["overflow"] === "auto")).toBe(true);
  });

  it("clips every name to one line", () => {
    [".entry-name", ".plan-head h1", ".toolbar-plan", ".choice-row", ".tl-row .name", ".card-name", ".list-name", ".palette-label"].forEach((sel) => {
      const decls = Object.assign({}, ...sheet.rules.filter((r) => r.selector === sel && r.conditions.length === 0).map((r) => r.decls));
      expect([sel, decls["overflow"], decls["text-overflow"], decls["white-space"]]).toEqual([sel, "hidden", "ellipsis", "nowrap"]);
    });
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
});

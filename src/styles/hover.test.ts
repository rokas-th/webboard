import { describe, expect, it } from "vitest";

const SHEETS: Record<string, string> = import.meta.glob("./*.css", { query: "?raw", import: "default", eager: true });

const HOVER_MEDIA = /^@media\s*\(\s*hover\s*:\s*hover\s*\)$/;

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

export function bareHovers(css: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let prelude = "";
  for (const ch of stripComments(css)) {
    if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      if (!head.startsWith("@") && head.includes(":hover") && !stack.some((s) => HOVER_MEDIA.test(s))) out.push(head);
      stack.push(head);
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return out;
}

describe("hover only where hover exists", () => {
  it("reads every stylesheet and finds a bare :hover when there is one", () => {
    expect(Object.keys(SHEETS).length).toBeGreaterThan(10);
    expect(bareHovers("a:hover { color: red; }")).toEqual(["a:hover"]);
    expect(bareHovers("@media (max-width: 9px) { a:hover { color: red; } }")).toEqual(["a:hover"]);
    expect(bareHovers("@media (hover: hover) { a:hover, b { color: red; } }")).toEqual([]);
    expect(bareHovers("@media (hover: hover) { @media (max-width: 9px) { a:hover { color: red; } } }")).toEqual([]);
  });

  it("puts every :hover rule inside @media (hover: hover)", () => {
    const bare = Object.entries(SHEETS).flatMap(([file, css]) => bareHovers(css).map((sel) => `${file}: ${sel}`));
    expect(bare).toEqual([]);
  });
});

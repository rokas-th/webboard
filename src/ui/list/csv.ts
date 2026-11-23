import { columnById, type RowContext } from "./columns";
import { listModel } from "./model";
import type { ListPrefs } from "./prefs";

const BOM = "﻿";

const EOL = "\r\n";

const FORMULA_START = /^[=+\-@\t\r]/;

const NEEDS_QUOTES = /[,"\r\n]|^ | $/;

export function csvCell(s: string): string {
  const guarded = FORMULA_START.test(s) ? `'${s}` : s;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const line = (cells: readonly string[]): string => `${cells.map(csvCell).join(",")}${EOL}`;

export function listCsv(ctx: RowContext, prefs: ListPrefs): { text: string; rows: number } {
  const cols = prefs.cols.map((c) => columnById(c.id));
  const ids = listModel(ctx, prefs, null).order.filter((id) => !ctx.ghosts.has(id));
  const head = line(cols.map((c) => c.title));
  const body = ids.map((id) => line(cols.map((c) => c.csv(ctx, id)))).join("");
  return { text: `${BOM}${head}${body}`, rows: ids.length };
}

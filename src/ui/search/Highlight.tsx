import { Fragment, type ReactNode } from "react";
import { searchQuery } from "./fold";

interface Span {
  from: number;
  to: number;
}

const runningTotal = (lengths: readonly number[]): number[] => {
  const out = new Array<number>(lengths.length + 1);
  out[0] = 0;
  lengths.forEach((n, i) => {
    out[i + 1] = out[i] + n;
  });
  return out;
};

function matchSpans(text: string, q: string): Span[] {
  const chars = [...text];
  const lowered = chars.map((c) => c.toLocaleLowerCase());
  const folded = lowered.join("");
  const foldedAt = runningTotal(lowered.map((l) => l.length));
  const textAt = runningTotal(chars.map((c) => c.length));
  const spans: Span[] = [];
  let first = 0;
  for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) {
    while (foldedAt[first + 1] <= at) first += 1;
    let last = first + 1;
    while (foldedAt[last] < at + q.length) last += 1;
    const span = { from: textAt[first], to: textAt[last] };
    const before = spans[spans.length - 1];
    if (before !== undefined && before.to > span.from) before.to = span.to;
    else spans.push(span);
  }
  return spans;
}

export function Highlight(p: { text: string; q: string }): ReactNode {
  const q = searchQuery(p.q);
  const spans = q === "" ? [] : matchSpans(p.text, q);
  if (spans.length === 0) return p.text;
  const ends = [0, ...spans.flatMap((s) => [s.from, s.to]), p.text.length];
  return (
    <>
      {ends.slice(0, -1).map((from, i) => {
        const piece = p.text.slice(from, ends[i + 1]);
        return i % 2 === 1 ? <mark key={i}>{piece}</mark> : <Fragment key={i}>{piece}</Fragment>;
      })}
    </>
  );
}

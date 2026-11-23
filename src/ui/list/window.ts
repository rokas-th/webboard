export const ROW_PX = 34;
export const OVERSCAN = 10;

export interface ListWindow {
  first: number;
  last: number;
  top: number;
  bottom: number;
}

const need = (ok: boolean, what: string, v: number): void => {
  if (!ok) throw new Error(`listWindow: ${what} ${v}`);
};

export function listWindow(scrollTop: number, height: number, count: number, row = ROW_PX, overscan = OVERSCAN): ListWindow {
  need(Number.isFinite(scrollTop) && scrollTop >= 0, "scrollTop", scrollTop);
  need(Number.isFinite(height) && height >= 0, "height", height);
  need(Number.isSafeInteger(count) && count >= 0, "count", count);
  const at = Math.min(scrollTop, Math.max(0, count * row - height));
  const first = Math.min(count, Math.max(0, Math.floor(at / row) - overscan));
  const last = Math.min(count, Math.max(first, Math.ceil((at + height) / row) + overscan));
  return { first, last, top: first * row, bottom: (count - last) * row };
}

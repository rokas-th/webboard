import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Closable {
  close(): Promise<void>;
}

export interface Destroyable {
  destroy(): Promise<void>;
}

export interface CloseEvent {
  preventDefault(): void;
}

export function closeGuard(
  current: () => Closable | null,
  win: Destroyable,
  onFailure: (e: unknown) => void,
): (event: CloseEvent) => Promise<void> {
  let closing = false;
  return async (event) => {
    const target = current();
    if (target === null) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await target.close();
      await win.destroy();
    } catch (e) {
      onFailure(e);
    } finally {
      closing = false;
    }
  };
}

export function guardWindowClose(current: () => Closable | null, onFailure: (e: unknown) => void): Promise<() => void> {
  const win = getCurrentWindow();
  return win.onCloseRequested(closeGuard(current, win, onFailure));
}

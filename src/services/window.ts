import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Closable {
  close(): Promise<void>;
}

export interface CloseEvent {
  preventDefault(): void;
}

export function closeGuard(target: Closable, onFailure: (e: unknown) => void): (event: CloseEvent) => Promise<void> {
  return async (event) => {
    try {
      await target.close();
    } catch (e) {
      event.preventDefault();
      onFailure(e);
    }
  };
}

export function guardWindowClose(target: Closable, onFailure: (e: unknown) => void): Promise<() => void> {
  return getCurrentWindow().onCloseRequested(closeGuard(target, onFailure));
}

import YProvider from "y-partyserver/provider";
import type * as Y from "yjs";

export type ProviderStatus = "connecting" | "connected" | "disconnected";

export interface ProviderLike {
  connect(): Promise<void>;
  disconnect(): void;
  destroy(): void;
  on(e: "status", cb: (s: { status: ProviderStatus }) => void): void;
  on(e: "synced", cb: (synced: boolean) => void): void;
  on(e: "connection-close", cb: (ev: { code: number; reason: string }) => void): void;
  readonly synced: boolean;
}

export type ProviderFactory = (host: string, doc: string, ydoc: Y.Doc, params: () => Promise<Record<string, string>>) => ProviderLike;

export const yProviderFactory: ProviderFactory = (host, doc, ydoc, params) => {
  const provider = new YProvider(host, doc, ydoc, {
    party: "room",
    connect: false,
    params,
    disableBc: true,
    maxBackoffTime: 30_000,
    WebSocketPolyfill: WebSocket,
  });
  provider.awareness.setLocalState(null);
  return provider;
};

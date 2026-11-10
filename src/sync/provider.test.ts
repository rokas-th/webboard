import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { yProviderFactory } from "./provider";

class StubSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly urls: string[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  readonly sent: unknown[] = [];

  constructor(url: string) {
    StubSocket.urls.push(url);
  }

  addEventListener(): void {}

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubSocket.urls.length = 0;
});

describe("yProviderFactory", () => {
  it("the factory connects with a fresh ticket", async () => {
    vi.stubGlobal("WebSocket", StubSocket);
    const tickets = ["tk_1", "tk_2"];
    const params = vi.fn(async () => ({ ticket: tickets.shift() ?? "none" }));
    const provider = yProviderFactory("webboard.rokass.org", "P0000000000", new Y.Doc(), params);
    await provider.connect();
    expect(StubSocket.urls).toHaveLength(1);
    const u = new URL(StubSocket.urls[0]);
    expect(u.protocol).toBe("wss:");
    expect(u.host).toBe("webboard.rokass.org");
    expect(u.pathname).toBe("/parties/room/P0000000000");
    expect(u.searchParams.get("ticket")).toBe("tk_1");
    expect(u.searchParams.has("_pk")).toBe(true);
    expect(params).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it("does not connect until asked", () => {
    vi.stubGlobal("WebSocket", StubSocket);
    const params = vi.fn(async () => ({ ticket: "tk_1" }));
    const provider = yProviderFactory("webboard.rokass.org", "P0000000000", new Y.Doc(), params);
    expect(StubSocket.urls).toHaveLength(0);
    expect(params).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("has no awareness state before connect", () => {
    vi.stubGlobal("WebSocket", StubSocket);
    const provider = yProviderFactory("webboard.rokass.org", "P0000000000", new Y.Doc(), async () => ({ ticket: "tk_1" }));
    expect(provider).toBeInstanceOf(YProvider);
    const y = provider as YProvider;
    expect(y.awareness.getLocalState()).toBeNull();
    expect(y.maxBackoffTime).toBe(30_000);
    expect(y.disableBc).toBe(true);
    provider.destroy();
  });
});

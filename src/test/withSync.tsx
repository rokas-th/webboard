import type { ReactElement } from "react";
import * as Y from "yjs";
import type { SpaceInfo } from "../services/ipc";
import { IndexDoc } from "../store/index-doc";
import type { Registry } from "../store/registry";
import type { ProviderFactory } from "../sync/provider";
import { SyncProvider } from "../sync/SyncProvider";
import { fakeFactory } from "./fakeProvider";
import { memoryDoc, type TestSession } from "./session";
import { tauri } from "./tauriMock";

export const SYNC_SERVER = "https://webboard.rokass.org";
export const SYNC_SPACE = "sp000000000";

const isRegistry = (x: unknown): x is Registry => typeof x === "object" && x !== null && "device" in x && "plans" in x;

function registryProp(ui: ReactElement): Registry | undefined {
  const props: unknown = ui.props;
  if (typeof props !== "object" || props === null || !("registry" in props)) return undefined;
  if (!isRegistry(props.registry)) throw new Error("withSync: the element's registry prop is not a Registry.");
  return props.registry;
}

export function withSync(
  ui: ReactElement,
  opts?: { registry?: Registry; factory?: ProviderFactory; status?: { space: SpaceInfo | null; revoked: boolean }; connected?: boolean },
): ReactElement {
  const registry = opts?.registry ?? registryProp(ui);
  if (registry === undefined) throw new Error("withSync needs a registry.");
  const connected = opts?.connected === true;
  const status = opts?.status ?? (connected ? { space: { server: SYNC_SERVER, spaceId: SYNC_SPACE, deviceId: registry.device.deviceId, deviceName: "Mac" }, revoked: false } : { space: null, revoked: false });
  tauri.answers.sync_status = () => status;
  if (connected && tauri.answers.sync_ticket === undefined) tauri.answers.sync_ticket = () => ({ ticket: "tk_test", expiresAt: 0 });
  const factory = opts?.factory ?? fakeFactory(connected ? { syncOnConnect: true } : undefined);
  return (
    <SyncProvider registry={registry} factory={factory}>
      {ui}
    </SyncProvider>
  );
}

export function connectedStubs(t: TestSession): Partial<Registry> {
  const plan = t.session.view().plan.id;
  const ix = memoryDoc("ix-" + SYNC_SPACE, new Y.Doc());
  let heads: readonly string[] | null = null;
  let index: Promise<IndexDoc> | null = null;
  return {
    setSpaceReadOnly: () => undefined,
    attachSpace: (spaceId: string) => {
      if (spaceId !== SYNC_SPACE) throw new Error("connectedStubs: no space " + spaceId);
      index ??= IndexDoc.open(ix.id, "mac", async () => ix);
      return index;
    },
    attachedSpace: () => SYNC_SPACE,
    indexErrorOf: () => null,
    reloading: () => false,
    doc: async (id: string) => {
      if (id === plan) return t.doc;
      if (id !== ix.id) throw new Error("connectedStubs: no doc " + id);
      return ix;
    },
    syncedHeads: () => heads,
    setSyncedHeads: async (_doc: string, h: readonly string[]) => {
      heads = h;
    },
    nameThisDevice: () => undefined,
  };
}

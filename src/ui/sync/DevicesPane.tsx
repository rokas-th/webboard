import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CANCEL_LABEL, usesNativeAlert, type NativeAsk } from "../../services/alert";
import { syncDevices, syncRemoveDevice, type DeviceEntry } from "../../services/ipc";
import { useSyncRegistry } from "../../sync/SyncProvider";
import { NativeConfirm } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { useDateStyle } from "../DeviceProvider";
import { PaneFailures, usePaneCommand } from "./command";
import { dayTime } from "./time";

export const REMOVE_CONFIRM = "Remove device";
export const REMOVE_TEXT = "It stops syncing at once and keeps its plans read-only.";
export const removeLabel = (name: string): string => `Remove ${name}?`;

export const removeAsk = (name: string): NativeAsk => ({ title: removeLabel(name), message: REMOVE_TEXT, confirm: { label: REMOVE_CONFIRM, destructive: true }, cancel: CANCEL_LABEL });

export const joinedAs = (name: string): string => `Joined as “${name}”`;

export function DevicesPane() {
  const style = useDateStyle();
  const registry = useSyncRegistry();
  const subscribe = useCallback((cb: () => void) => registry.subscribe(cb), [registry]);
  const names = useSyncExternalStore(subscribe, () => registry.devices());
  const shownName = (d: DeviceEntry): string => names.get(d.id) ?? d.name;
  const [devices, setDevices] = useState<readonly DeviceEntry[] | null>(null);
  const [asking, setAsking] = useState<DeviceEntry | null>(null);
  const cmd = usePaneCommand();
  const load = cmd.run;
  useEffect(() => {
    load(async () => setDevices(await syncDevices()));
  }, []);
  const native = usesNativeAlert();
  const remove = (d: DeviceEntry): void =>
    cmd.run(async () => {
      const removal = await syncRemoveDevice(d.id).then(
        () => {
          toast(`${shownName(d)} removed`);
          return [];
        },
        (e: unknown) => [e],
      );
      setAsking(null);
      const refresh = await syncDevices().then(
        (list) => {
          setDevices(list);
          return [];
        },
        (e: unknown) => [e],
      );
      const failed = [...removal, ...refresh];
      if (failed.length === 1) throw failed[0];
      if (failed.length > 1) throw new PaneFailures(failed);
    });
  return (
    <div className="sync-form">
      {devices !== null && (
        <ul className="sync-devices">
          {devices.map((d) => (
            <li key={d.id} className="sync-device">
              <span className="sync-device-who">
                <span className="sync-device-name">{shownName(d)}</span>
                {shownName(d) !== d.name && <span className="sync-joined dim">{joinedAs(d.name)}</span>}
              </span>
              <span className="dim">{d.current ? "This device" : `Last seen ${dayTime(d.lastSeenAt, style)}`}</span>
              {!d.current && (
                <button type="button" className="sync-remove danger" disabled={native && (asking !== null || cmd.busy)} onClick={() => setAsking(d)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {native && asking !== null && <NativeConfirm ask={removeAsk(shownName(asking))} run={() => remove(asking)} onClose={() => setAsking(null)} />}
      {!native && asking !== null && (
        <div className="sync-confirm">
          <p>{`${removeLabel(shownName(asking))} ${REMOVE_TEXT}`}</p>
          <div className="sync-buttons">
            <button type="button" onClick={() => setAsking(null)}>
              {CANCEL_LABEL}
            </button>
            <button type="button" className="button-danger" disabled={cmd.busy} onClick={() => remove(asking)}>
              {REMOVE_CONFIRM}
            </button>
          </div>
        </div>
      )}
      {cmd.errors.map((m, i) => (
        <p key={i} className="sync-error bad">
          {m}
        </p>
      ))}
    </div>
  );
}

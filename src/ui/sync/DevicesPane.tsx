import { useEffect, useState } from "react";
import { syncDevices, syncRemoveDevice, type DeviceEntry } from "../../services/ipc";
import { toast } from "../common/Toast";
import { usePaneCommand } from "./command";
import { dayTime } from "./time";

export function DevicesPane() {
  const [devices, setDevices] = useState<readonly DeviceEntry[] | null>(null);
  const [asking, setAsking] = useState<DeviceEntry | null>(null);
  const cmd = usePaneCommand();
  const load = cmd.run;
  useEffect(() => {
    load(async () => setDevices(await syncDevices()));
  }, []);
  const remove = (d: DeviceEntry): void =>
    cmd.run(async () => {
      try {
        await syncRemoveDevice(d.id);
        toast(`${d.name} removed`);
      } finally {
        setAsking(null);
        setDevices(await syncDevices());
      }
    });
  return (
    <div className="sync-form">
      {devices !== null && (
        <ul className="sync-devices">
          {devices.map((d) => (
            <li key={d.id} className="sync-device">
              <span className="sync-device-name">{d.name}</span>
              <span className="dim">{d.current ? "This device" : `Last seen ${dayTime(d.lastSeenAt)}`}</span>
              {!d.current && (
                <button type="button" className="sync-remove danger" onClick={() => setAsking(d)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {asking !== null && (
        <div className="sync-confirm">
          <p>{`Remove ${asking.name}? It stops syncing at once and keeps its plans read-only.`}</p>
          <div className="sync-buttons">
            <button type="button" onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button type="button" className="button-danger" disabled={cmd.busy} onClick={() => remove(asking)}>
              Remove device
            </button>
          </div>
        </div>
      )}
      {cmd.error !== null && <p className="sync-error bad">{cmd.error}</p>}
    </div>
  );
}

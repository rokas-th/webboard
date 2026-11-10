import { useState } from "react";
import { normalizeName } from "../../actions/build";
import { syncSetup } from "../../services/ipc";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { toast } from "../common/Toast";
import { usePaneCommand } from "./command";

export const DEFAULT_SERVER = "https://webboard.rokass.org";

export function SetupPane() {
  const registry = useSyncRegistry();
  const { restart } = useSyncState();
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [secret, setSecret] = useState("");
  const [name, setName] = useState(registry.device.name);
  const cmd = usePaneCommand();
  const create = (): void =>
    cmd.run(async () => {
      const deviceName = normalizeName(name);
      await syncSetup(server, secret, deviceName);
      setSecret("");
      await restart();
      toast("Sync set up");
    });
  return (
    <div className="sync-form">
      <label className="sync-field">
        <span>Server address</span>
        <input type="url" value={server} onChange={(e) => setServer(e.target.value)} />
      </label>
      <label className="sync-field">
        <span>Setup secret</span>
        <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      <label className="sync-field">
        <span>Device name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="sync-buttons">
        <button type="button" className="button-primary" disabled={cmd.busy} onClick={create}>
          Create or join space
        </button>
      </div>
      {cmd.error !== null && <p className="sync-error bad">{cmd.error}</p>}
    </div>
  );
}

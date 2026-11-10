import { useState } from "react";
import { normalizeName } from "../../actions/build";
import { syncPairJoin } from "../../services/ipc";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { toast } from "../common/Toast";
import { enrolThenRestart, usePaneCommand } from "./command";
import { DEFAULT_SERVER } from "./SetupPane";

export function JoinPane() {
  const registry = useSyncRegistry();
  const { restart } = useSyncState();
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [code, setCode] = useState("");
  const [name, setName] = useState(registry.device.name);
  const cmd = usePaneCommand();
  const join = (): void =>
    cmd.run(async () => {
      const deviceName = normalizeName(name);
      await enrolThenRestart(async () => {
        await syncPairJoin(server, code, deviceName);
      }, restart);
      toast("Joined the space");
    });
  return (
    <div className="sync-form">
      <label className="sync-field">
        <span>Server address</span>
        <input type="url" value={server} onChange={(e) => setServer(e.target.value)} />
      </label>
      <label className="sync-field">
        <span>Pairing code</span>
        <input type="text" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="sync-field">
        <span>Device name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="sync-buttons">
        <button type="button" className="button-primary" disabled={cmd.busy} onClick={join}>
          Join space
        </button>
      </div>
      {cmd.errors.map((m, i) => (
        <p key={i} className="sync-error bad">
          {m}
        </p>
      ))}
    </div>
  );
}

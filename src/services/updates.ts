import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkUpdate, type DownloadEvent } from "@tauri-apps/plugin-updater";
import type { InstallProgress } from "../store/updates";

export interface FoundUpdate {
  version: string;
  install(onProgress: (p: InstallProgress) => void): Promise<void>;
}

export function progressTracker(onProgress: (p: InstallProgress) => void): (e: DownloadEvent) => void {
  let downloaded = 0;
  let total: number | null = null;
  return (e) => {
    if (e.event === "Finished") {
      onProgress({ t: "installing" });
      return;
    }
    if (e.event === "Started") {
      downloaded = 0;
      total = e.data.contentLength ?? null;
    } else {
      downloaded += e.data.chunkLength;
    }
    onProgress({ t: "downloading", downloaded, total });
  };
}

export async function check(): Promise<FoundUpdate | null> {
  const update = await checkUpdate();
  if (update === null) return null;
  return {
    version: update.version,
    install: (onProgress) => update.downloadAndInstall(progressTracker(onProgress)),
  };
}

export function restart(): Promise<void> {
  return relaunch();
}

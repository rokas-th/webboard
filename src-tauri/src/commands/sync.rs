use std::path::PathBuf;

use tauri::State;
use webboard_core::error::Result;
use webboard_core::sync::{DeviceEntry, PairCode, SpaceInfo, SyncClient, SyncStatus, Ticket};
use webboard_core::CommandError;

pub struct SyncState {
    dir: PathBuf,
    client: SyncClient,
}

impl SyncState {
    pub fn new(dir: PathBuf, client: SyncClient) -> Self {
        Self { dir, client }
    }

    async fn device_id(&self, cmd: &str) -> Result<String> {
        let dir = self.dir.clone();
        let info = super::blocking(cmd, "device.io", move || {
            super::device::device_info_in(&dir)
        })
        .await?;
        Ok(info.device_id)
    }
}

#[tauri::command]
pub async fn sync_setup(
    sync: State<'_, super::Started<SyncState>>,
    server: String,
    secret: String,
    device_name: String,
) -> Result<SpaceInfo> {
    let sync = sync.get()?;
    let device_id = sync.device_id("sync_setup").await?;
    sync.client
        .setup(&server, &secret, &device_id, &device_name)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_pair_join(
    sync: State<'_, super::Started<SyncState>>,
    server: String,
    code: String,
    device_name: String,
) -> Result<SpaceInfo> {
    let sync = sync.get()?;
    let device_id = sync.device_id("sync_pair_join").await?;
    sync.client
        .pair_join(&server, &code, &device_id, &device_name)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_pair_code(sync: State<'_, super::Started<SyncState>>) -> Result<PairCode> {
    sync.get()?
        .client
        .pair_code()
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_ticket(
    sync: State<'_, super::Started<SyncState>>,
    doc: String,
) -> Result<Ticket> {
    sync.get()?
        .client
        .ticket(&doc)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_devices(sync: State<'_, super::Started<SyncState>>) -> Result<Vec<DeviceEntry>> {
    sync.get()?
        .client
        .devices()
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_remove_device(
    sync: State<'_, super::Started<SyncState>>,
    id: String,
) -> Result<()> {
    sync.get()?
        .client
        .remove_device(&id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_status(sync: State<'_, super::Started<SyncState>>) -> Result<SyncStatus> {
    sync.get()?
        .client
        .status()
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_mark_revoked(sync: State<'_, super::Started<SyncState>>) -> Result<()> {
    sync.get()?
        .client
        .mark_revoked()
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_reset(sync: State<'_, super::Started<SyncState>>) -> Result<()> {
    sync.get()?.client.reset().await.map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_purge_plan(
    sync: State<'_, super::Started<SyncState>>,
    doc: String,
) -> Result<()> {
    sync.get()?
        .client
        .purge_plan(&doc)
        .await
        .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::sync::Arc;
    use tauri::ipc::InvokeBody;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tempfile::TempDir;
    use webboard_core::sync::{MemoryTokens, SyncClient};

    struct Harness {
        _app: App<tauri::test::MockRuntime>,
        webview: WebviewWindow<tauri::test::MockRuntime>,
        tmp: TempDir,
    }

    fn harness() -> Harness {
        let tmp = TempDir::new().expect("temp dir");
        let client = SyncClient::new(
            tmp.path().to_path_buf(),
            Arc::new(MemoryTokens::new()),
            webboard_core::sync::http_client().expect("http client"),
        );
        let app = mock_builder()
            .manage(crate::commands::Started::new(Ok(SyncState::new(
                tmp.path().to_path_buf(),
                client,
            ))))
            .invoke_handler(tauri::generate_handler![
                sync_setup,
                sync_pair_code,
                sync_pair_join,
                sync_ticket,
                sync_devices,
                sync_remove_device,
                sync_status,
                sync_mark_revoked,
                sync_reset,
                sync_purge_plan
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        Harness {
            _app: app,
            webview,
            tmp,
        }
    }

    fn invoke(h: &Harness, cmd: &str, args: Value) -> std::result::Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&h.webview, request)
            .map(|body| body.deserialize::<Value>().expect("a JSON answer"))
    }

    const HOST: &str = "This build syncs only with webboard.rokass.org.";
    const NOT_JOINED: &str = "This device is not in a space yet. Set up sync or join with a code.";

    #[test]
    fn status_without_a_space() {
        let h = harness();
        assert_eq!(
            invoke(&h, "sync_status", json!({})),
            Ok(json!({ "space": null, "revoked": false }))
        );
        assert_eq!(invoke(&h, "sync_reset", json!({})), Ok(Value::Null));
    }

    #[test]
    fn setup_and_join_read_the_device_id_then_refuse_another_host() {
        let h = harness();
        assert_eq!(
            invoke(
                &h,
                "sync_setup",
                json!({ "server": "https://example.org", "secret": "s3cr3t", "deviceName": "Mac" })
            ),
            Err(json!({ "code": "sync.host", "message": HOST }))
        );
        assert!(h.tmp.path().join("device.json").is_file());
        assert_eq!(
            invoke(
                &h,
                "sync_pair_join",
                json!({ "server": "https://example.org", "code": "ABCD2345", "deviceName": "Mac" })
            ),
            Err(json!({ "code": "sync.host", "message": HOST }))
        );
        assert!(!h.tmp.path().join("sync.json").exists());
    }

    #[test]
    fn a_corrupt_device_file_stops_setup_with_device_io() {
        let h = harness();
        fs::write(h.tmp.path().join("device.json"), "{").expect("write");
        for (cmd, args) in [
            (
                "sync_setup",
                json!({ "server": "https://example.org", "secret": "s3cr3t", "deviceName": "Mac" }),
            ),
            (
                "sync_pair_join",
                json!({ "server": "https://example.org", "code": "ABCD2345", "deviceName": "Mac" }),
            ),
        ] {
            let e = invoke(&h, cmd, args).expect_err("a corrupt device.json");
            assert_eq!(e["code"], "device.io", "{e}");
            assert!(
                e["message"]
                    .as_str()
                    .is_some_and(|m| m.starts_with("device.json is not valid: ")),
                "{e}"
            );
        }
        assert!(!h.tmp.path().join("sync.json").exists());
    }

    #[test]
    fn token_using_commands_need_a_space() {
        let h = harness();
        let not_joined = Err(json!({ "code": "sync.not_joined", "message": NOT_JOINED }));
        assert_eq!(invoke(&h, "sync_pair_code", json!({})), not_joined.clone());
        assert_eq!(
            invoke(&h, "sync_ticket", json!({ "doc": "ix-sp000000000" })),
            not_joined.clone()
        );
        assert_eq!(invoke(&h, "sync_devices", json!({})), not_joined.clone());
        assert_eq!(
            invoke(&h, "sync_remove_device", json!({ "id": "dev00000000" })),
            not_joined.clone()
        );
        assert_eq!(
            invoke(&h, "sync_purge_plan", json!({ "doc": "pl0000000001" })),
            not_joined.clone()
        );
        assert_eq!(invoke(&h, "sync_mark_revoked", json!({})), not_joined);
    }
}

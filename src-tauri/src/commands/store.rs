use std::borrow::Cow;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;
use webboard_core::error::Result;
use webboard_core::store::{DocStore, Store};
use webboard_core::CommandError;

async fn blocking<T: Send + 'static>(
    cmd: &str,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::new("store.io", format!("{cmd} stopped: {e}")))?
}

struct Write {
    doc: String,
    seq: u64,
    bytes: Vec<u8>,
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<Cow<'a, str>> {
    request
        .headers()
        .get(name)
        .map(|v| String::from_utf8_lossy(v.as_bytes()))
}

fn write_of(cmd: &str, request: &Request<'_>) -> Result<Write> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(CommandError::new(
            "store.io",
            format!("{cmd} expects raw bytes"),
        )),
    }?;
    let doc = header(request, "x-doc")
        .ok_or_else(|| CommandError::new("store.io", "missing x-doc header"))?
        .into_owned();
    let seq = header(request, "x-seq")
        .ok_or_else(|| CommandError::new("store.seq", "missing x-seq header"))?;
    let seq = seq
        .parse::<u64>()
        .map_err(|_| CommandError::new("store.seq", format!("x-seq is not a number: {seq}")))?;
    Ok(Write { doc, seq, bytes })
}

fn lock_doc<'a>(doc: &'a Mutex<DocStore>, id: &str) -> Result<MutexGuard<'a, DocStore>> {
    doc.lock().map_err(|_| {
        CommandError::new(
            "store.io",
            format!("Document {id} is unusable after an earlier panic; restart WebBoard."),
        )
    })
}

#[tauri::command]
pub async fn store_load(store: State<'_, Store>, doc: String) -> Result<Response> {
    let store = store.inner().clone();
    blocking("store_load", move || {
        let handle = store.doc(&doc)?;
        let loaded = lock_doc(&handle, &doc)?.load()?;
        Ok(Response::new(loaded.encode()))
    })
    .await
}

#[tauri::command]
pub async fn store_append(store: State<'_, Store>, request: Request<'_>) -> Result<()> {
    let w = write_of("store_append", &request)?;
    let store = store.inner().clone();
    blocking("store_append", move || {
        let handle = store.doc(&w.doc)?;
        let result = lock_doc(&handle, &w.doc)?.append(w.seq, &w.bytes);
        result
    })
    .await
}

#[tauri::command]
pub async fn store_compact(store: State<'_, Store>, request: Request<'_>) -> Result<()> {
    let w = write_of("store_compact", &request)?;
    let store = store.inner().clone();
    blocking("store_compact", move || {
        let handle = store.doc(&w.doc)?;
        let result = lock_doc(&handle, &w.doc)?.compact(w.seq, &w.bytes);
        result
    })
    .await
}

#[tauri::command]
pub async fn store_list(store: State<'_, Store>) -> Result<Vec<String>> {
    let store = store.inner().clone();
    blocking("store_list", move || store.list()).await
}

#[tauri::command]
pub async fn store_set_aside(store: State<'_, Store>, doc: String) -> Result<()> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| {
            CommandError::new("store.io", format!("The system clock is before 1970: {e}"))
        })?
        .as_secs();
    let store = store.inner().clone();
    blocking("store_set_aside", move || store.set_aside(&doc, secs)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::Path;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tempfile::TempDir;
    use webboard_core::store::Loaded;

    struct Harness {
        _app: App<tauri::test::MockRuntime>,
        webview: WebviewWindow<tauri::test::MockRuntime>,
        _tmp: TempDir,
        docs: std::path::PathBuf,
    }

    fn harness() -> Harness {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let app = mock_builder()
            .manage(Store::new(docs.clone()))
            .invoke_handler(tauri::generate_handler![
                store_load,
                store_append,
                store_compact,
                store_list,
                store_set_aside
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Harness {
            _app: app,
            webview,
            _tmp: tmp,
            docs,
        }
    }

    fn request(cmd: &str, body: InvokeBody, headers: &[(&'static str, &str)]) -> InvokeRequest {
        let mut map = tauri::http::HeaderMap::new();
        headers.iter().for_each(|(k, v)| {
            map.insert(*k, v.parse().unwrap());
        });
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers: map,
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    fn invoke(
        h: &Harness,
        cmd: &str,
        body: InvokeBody,
        headers: &[(&'static str, &str)],
    ) -> std::result::Result<tauri::ipc::InvokeResponseBody, Value> {
        get_ipc_response(&h.webview, request(cmd, body, headers))
    }

    fn append(h: &Harness, doc: &str, seq: &str, bytes: &[u8]) -> std::result::Result<(), Value> {
        invoke(
            h,
            "store_append",
            InvokeBody::Raw(bytes.to_vec()),
            &[("x-doc", doc), ("x-seq", seq)],
        )
        .map(|_| ())
    }

    fn load(h: &Harness, doc: &str) -> Vec<u8> {
        match invoke(
            h,
            "store_load",
            InvokeBody::Json(json!({ "doc": doc })),
            &[],
        )
        .unwrap()
        {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
            other => panic!("store_load answered JSON: {other:?}"),
        }
    }

    fn list(h: &Harness) -> Vec<String> {
        invoke(h, "store_list", InvokeBody::Json(json!({})), &[])
            .unwrap()
            .deserialize()
            .unwrap()
    }

    fn error(code: &str, message: &str) -> Value {
        json!({ "code": code, "message": message })
    }

    fn bad_names(docs: &Path) -> Vec<String> {
        fs::read_dir(docs)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.contains(".bad-"))
            .collect()
    }

    #[test]
    fn append_then_load_over_ipc() {
        let h = harness();
        append(&h, "p1", "1", b"one").unwrap();
        append(&h, "p1", "2", b"two").unwrap();
        let expected = Loaded {
            torn: false,
            snapshot: Vec::new(),
            snapshot_seq: 0,
            records: vec![(1, b"one".to_vec()), (2, b"two".to_vec())],
            last_seq: 2,
        };
        assert_eq!(load(&h, "p1"), expected.encode());
        invoke(
            &h,
            "store_compact",
            InvokeBody::Raw(b"state".to_vec()),
            &[("x-doc", "p1"), ("x-seq", "2")],
        )
        .unwrap();
        let compacted = Loaded {
            torn: false,
            snapshot: b"state".to_vec(),
            snapshot_seq: 2,
            records: Vec::new(),
            last_seq: 2,
        };
        assert_eq!(load(&h, "p1"), compacted.encode());
        assert_eq!(list(&h), ["p1"]);
    }

    #[test]
    fn json_body_refused() {
        let h = harness();
        ["store_append", "store_compact"].iter().for_each(|cmd| {
            assert_eq!(
                invoke(
                    &h,
                    cmd,
                    InvokeBody::Json(json!({})),
                    &[("x-doc", "p1"), ("x-seq", "1")]
                )
                .unwrap_err(),
                error("store.io", &format!("{cmd} expects raw bytes"))
            );
        });
    }

    #[test]
    fn seq_header_required() {
        let h = harness();
        ["store_append", "store_compact"].iter().for_each(|cmd| {
            assert_eq!(
                invoke(&h, cmd, InvokeBody::Raw(b"u".to_vec()), &[("x-doc", "p1")]).unwrap_err(),
                error("store.seq", "missing x-seq header")
            );
            assert_eq!(
                invoke(
                    &h,
                    cmd,
                    InvokeBody::Raw(b"u".to_vec()),
                    &[("x-doc", "p1"), ("x-seq", "abc")]
                )
                .unwrap_err(),
                error("store.seq", "x-seq is not a number: abc")
            );
        });
    }

    #[test]
    fn doc_header_required() {
        let h = harness();
        ["store_append", "store_compact"].iter().for_each(|cmd| {
            assert_eq!(
                invoke(&h, cmd, InvokeBody::Raw(b"u".to_vec()), &[("x-seq", "1")]).unwrap_err(),
                error("store.io", "missing x-doc header")
            );
        });
        assert!(!h.docs.exists());
    }

    #[test]
    fn set_aside_over_ipc() {
        let h = harness();
        append(&h, "p1", "1", b"one").unwrap();
        append(&h, "p1", "2", b"two").unwrap();
        append(&h, "p2", "1", b"other").unwrap();
        let before = fs::read(h.docs.join("p1").join("seg-1.log")).unwrap();
        invoke(
            &h,
            "store_set_aside",
            InvokeBody::Json(json!({ "doc": "p1" })),
            &[],
        )
        .unwrap();
        assert_eq!(list(&h), ["p2"]);
        let bad = bad_names(&h.docs);
        assert_eq!(bad.len(), 1, "{bad:?}");
        let secs = bad[0].strip_prefix("p1.bad-").unwrap();
        assert!(
            !secs.is_empty() && secs.bytes().all(|b| b.is_ascii_digit()),
            "{}",
            bad[0]
        );
        assert!(h.docs.join(&bad[0]).is_dir());
        assert_eq!(
            fs::read(h.docs.join(&bad[0]).join("seg-1.log")).unwrap(),
            before
        );
        let empty = Loaded {
            torn: false,
            snapshot: Vec::new(),
            snapshot_seq: 0,
            records: Vec::new(),
            last_seq: 0,
        };
        assert_eq!(load(&h, "p1"), empty.encode());
        assert_eq!(
            load(&h, "p1"),
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(
            invoke(
                &h,
                "store_set_aside",
                InvokeBody::Json(json!({ "doc": "nope" })),
                &[],
            )
            .unwrap_err(),
            error("store.io", "no document nope")
        );
    }
}

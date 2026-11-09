use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use webboard_core::error::Result;
use webboard_core::CommandError;

const CODE: &str = "file.io";
const FILE_URL: &str = "file://";
const LOCALHOST: &str = "localhost";

fn io(message: impl Into<String>) -> CommandError {
    CommandError::new(CODE, message)
}

fn decoded(text: &str, what: &str) -> Result<String> {
    percent_decode_str(text)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|e| io(format!("{what} is not UTF-8 once decoded: {e}")))
}

fn path_of(request: &Request<'_>) -> Result<PathBuf> {
    let raw = request
        .headers()
        .get("x-path")
        .ok_or_else(|| io("missing x-path header"))?;
    let raw = raw
        .to_str()
        .map_err(|_| io("header x-path is not percent-encoded ASCII"))?;
    let path = decoded(raw, "x-path")?;
    let path = match strip_ignoring_case(&path, FILE_URL) {
        None => path,
        Some(rest) => {
            let rest = strip_ignoring_case(rest, LOCALHOST).unwrap_or(rest);
            if !rest.starts_with('/') {
                return Err(io(format!("{path} names a file on another host")));
            }
            decoded(rest, "the file URL's path")?
        }
    };
    if path.is_empty() {
        return Err(io("x-path names no file"));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(io(format!("{} is not an absolute path", path.display())));
    }
    Ok(path)
}

fn strip_ignoring_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let fail = |e: std::io::Error| io(format!("Could not write {}: {e}.", path.display()));
    let (dir, name) = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(dir), Some(name)) => (dir, name),
        _ => {
            return Err(io(format!(
                "Could not write {}: it names no file.",
                path.display()
            )))
        }
    };
    super::replace_file(dir, name, bytes).map_err(fail)
}

fn read_file(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| io(format!("Could not read {}: {e}.", path.display())))
}

#[tauri::command]
pub async fn file_write(request: Request<'_>) -> Result<()> {
    let path = path_of(&request)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err(io("file_write expects raw bytes")),
    };
    super::blocking("file_write", CODE, move || write_file(&path, &bytes)).await
}

#[tauri::command]
pub async fn file_read(request: Request<'_>) -> Result<Response> {
    let path = path_of(&request)?;
    let bytes = super::blocking("file_read", CODE, move || read_file(&path)).await?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    use serde_json::{json, Value};
    use tauri::ipc::InvokeResponseBody;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tempfile::TempDir;

    struct Harness {
        _app: App<tauri::test::MockRuntime>,
        webview: WebviewWindow<tauri::test::MockRuntime>,
    }

    fn harness() -> Harness {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![file_write, file_read])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Harness { _app: app, webview }
    }

    fn encode(text: &str) -> String {
        utf8_percent_encode(text, NON_ALPHANUMERIC).to_string()
    }

    fn invoke(
        h: &Harness,
        cmd: &str,
        body: InvokeBody,
        x_path: Option<&str>,
    ) -> std::result::Result<InvokeResponseBody, Value> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(p) = x_path {
            headers.insert("x-path", p.parse().unwrap());
        }
        get_ipc_response(
            &h.webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn read(h: &Harness, x_path: &str) -> std::result::Result<Vec<u8>, Value> {
        match invoke(h, "file_read", InvokeBody::Json(json!({})), Some(x_path))? {
            InvokeResponseBody::Raw(bytes) => Ok(bytes),
            InvokeResponseBody::Json(j) => panic!("file_read answered JSON: {j}"),
        }
    }

    #[test]
    fn file_round_trip() {
        let h = harness();
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("Plan ü.webboard");
        let text = path.to_str().unwrap();
        let bytes = b"WBX1\x01\x00\x00\x00 plan".to_vec();
        invoke(
            &h,
            "file_write",
            InvokeBody::Raw(bytes.clone()),
            Some(&encode(text)),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(read(&h, &encode(text)).unwrap(), bytes);

        let url = format!(
            "file://{}",
            text.split('/').map(encode).collect::<Vec<_>>().join("/")
        );
        assert!(url.contains("Plan%20%C3%BC"), "{url}");
        assert_eq!(read(&h, &encode(&url)).unwrap(), bytes);

        let missing = tmp.path().join("Gone.webboard");
        let e = read(&h, &encode(missing.to_str().unwrap())).unwrap_err();
        assert_eq!(e["code"], "file.io");
        let message = e["message"].as_str().unwrap();
        assert!(
            message.starts_with(&format!("Could not read {}: ", missing.display())),
            "{message}"
        );
    }

    #[test]
    fn file_write_through_a_url() {
        let h = harness();
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("Plan ü.webboard");
        let text = path.to_str().unwrap();
        let url = format!(
            "file://{}",
            text.split('/').map(encode).collect::<Vec<_>>().join("/")
        );
        invoke(
            &h,
            "file_write",
            InvokeBody::Raw(b"bytes".to_vec()),
            Some(&encode(&url)),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"bytes");
    }

    #[test]
    fn file_write_keeps_the_old_file_when_it_fails() {
        let h = harness();
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("Plan.webboard");
        fs::write(&path, b"old plan").unwrap();
        fs::create_dir(tmp.path().join("Plan.webboard.tmp")).unwrap();
        let e = invoke(
            &h,
            "file_write",
            InvokeBody::Raw(b"new plan".to_vec()),
            Some(&encode(path.to_str().unwrap())),
        )
        .unwrap_err();
        assert_eq!(e["code"], "file.io");
        let message = e["message"].as_str().unwrap();
        assert!(
            message.starts_with(&format!("Could not write {}: ", path.display())),
            "{message}"
        );
        assert_eq!(fs::read(&path).unwrap(), b"old plan");

        fs::remove_dir(tmp.path().join("Plan.webboard.tmp")).unwrap();
        invoke(
            &h,
            "file_write",
            InvokeBody::Raw(b"new plan".to_vec()),
            Some(&encode(path.to_str().unwrap())),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new plan");
        assert!(!tmp.path().join("Plan.webboard.tmp").exists());
    }

    #[test]
    fn file_url_prefix_ignores_case() {
        let h = harness();
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("x.webboard");
        let url = format!("FILE://{}", path.to_str().unwrap());
        invoke(
            &h,
            "file_write",
            InvokeBody::Raw(b"bytes".to_vec()),
            Some(&encode(&url)),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"bytes");
        assert_eq!(read(&h, &encode(&url)).unwrap(), b"bytes");
        let host = format!("File://LocalHost{}", path.to_str().unwrap());
        assert_eq!(read(&h, &encode(&host)).unwrap(), b"bytes");
    }

    #[test]
    fn relative_path_refused() {
        let h = harness();
        let expected =
            json!({ "code": "file.io", "message": "a.webboard is not an absolute path" });
        assert_eq!(
            invoke(
                &h,
                "file_read",
                InvokeBody::Json(json!({})),
                Some("a.webboard")
            )
            .unwrap_err(),
            expected
        );
        assert_eq!(
            invoke(
                &h,
                "file_write",
                InvokeBody::Raw(b"x".to_vec()),
                Some("a.webboard")
            )
            .unwrap_err(),
            expected
        );
        assert!(!Path::new("a.webboard").exists());
    }

    #[test]
    fn x_path_required() {
        let h = harness();
        let expected = json!({ "code": "file.io", "message": "missing x-path header" });
        assert_eq!(
            invoke(&h, "file_read", InvokeBody::Json(json!({})), None).unwrap_err(),
            expected
        );
        assert_eq!(
            invoke(&h, "file_write", InvokeBody::Raw(b"x".to_vec()), None).unwrap_err(),
            expected
        );
    }

    #[test]
    fn file_write_refuses_json() {
        let h = harness();
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.webboard");
        let e = invoke(
            &h,
            "file_write",
            InvokeBody::Json(json!({})),
            Some(&encode(path.to_str().unwrap())),
        )
        .unwrap_err();
        assert_eq!(
            e,
            json!({ "code": "file.io", "message": "file_write expects raw bytes" })
        );
        assert!(!path.exists());
    }
}

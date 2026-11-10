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

fn header(request: &Request<'_>, name: &str) -> Result<String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| io(format!("missing {name} header")))?;
    let raw = raw
        .to_str()
        .map_err(|_| io(format!("header {name} is not percent-encoded ASCII")))?;
    decoded(raw, name)
}

fn raw_body(request: &Request<'_>, cmd: &str) -> Result<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(io(format!("{cmd} expects raw bytes"))),
    }
}

fn path_of(request: &Request<'_>) -> Result<PathBuf> {
    let path = header(request, "x-path")?;
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
    let bytes = raw_body(&request, "file_write")?;
    super::blocking("file_write", CODE, move || write_file(&path, &bytes)).await
}

#[cfg(any(target_os = "ios", test))]
pub struct Staging(pub PathBuf);

#[cfg(any(target_os = "ios", test))]
fn file_name_of(path: &str) -> Option<&str> {
    Path::new(path).file_name().and_then(|n| n.to_str())
}

#[cfg(any(target_os = "ios", test))]
fn remove_staged(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(format!("Could not remove {}: {e}.", path.display()))),
    }
}

#[cfg(any(target_os = "ios", test))]
#[tauri::command]
pub async fn file_stage(
    staging: tauri::State<'_, Staging>,
    request: Request<'_>,
) -> Result<String> {
    let default_path = header(&request, "x-name")?;
    let name = file_name_of(&default_path)
        .ok_or_else(|| io("x-name names no file"))?
        .to_string();
    let bytes = raw_body(&request, "file_stage")?;
    let path = staging.0.join(&name);
    super::blocking("file_stage", CODE, move || write_file(&path, &bytes)).await?;
    Ok(name)
}

#[cfg(any(target_os = "ios", test))]
#[tauri::command]
pub async fn file_unstage(staging: tauri::State<'_, Staging>, name: String) -> Result<()> {
    if file_name_of(&name) != Some(name.as_str()) {
        return Err(io(format!("{name:?} is not a file name")));
    }
    let path = staging.0.join(&name);
    super::blocking("file_unstage", CODE, move || remove_staged(&path)).await
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
        documents: TempDir,
    }

    fn harness() -> Harness {
        let documents = TempDir::new().unwrap();
        let app = mock_builder()
            .manage(Staging(documents.path().to_path_buf()))
            .invoke_handler(tauri::generate_handler![
                file_write,
                file_read,
                file_stage,
                file_unstage
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Harness {
            _app: app,
            webview,
            documents,
        }
    }

    fn stage(h: &Harness, x_name: &str, bytes: &[u8]) -> std::result::Result<Value, Value> {
        match invoke_with(
            h,
            "file_stage",
            InvokeBody::Raw(bytes.to_vec()),
            Some(("x-name", &encode(x_name))),
        )? {
            InvokeResponseBody::Json(j) => Ok(serde_json::from_str(&j).unwrap()),
            InvokeResponseBody::Raw(_) => panic!("file_stage answered raw bytes"),
        }
    }

    fn unstage(h: &Harness, name: &str) -> std::result::Result<InvokeResponseBody, Value> {
        invoke_with(
            h,
            "file_unstage",
            InvokeBody::Json(json!({ "name": name })),
            None,
        )
    }

    fn staged(h: &Harness) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(h.documents.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn file_stage_writes_the_bytes_under_the_file_name_the_dialog_uses() {
        let h = harness();
        assert_eq!(
            stage(&h, "Q3/Plan ü.webboard", b"WBX1 first"),
            Ok(json!("Plan ü.webboard"))
        );
        assert_eq!(staged(&h), ["Plan ü.webboard"]);
        assert_eq!(
            fs::read(h.documents.path().join("Plan ü.webboard")).unwrap(),
            b"WBX1 first"
        );
        assert_eq!(
            stage(&h, "Plan ü.webboard", b"WBX1 second"),
            Ok(json!("Plan ü.webboard"))
        );
        assert_eq!(staged(&h), ["Plan ü.webboard"]);
        assert_eq!(
            fs::read(h.documents.path().join("Plan ü.webboard")).unwrap(),
            b"WBX1 second"
        );
    }

    #[test]
    fn file_unstage_removes_the_staged_copy() {
        let h = harness();
        stage(&h, "Plan.webboard", b"WBX1").unwrap();
        unstage(&h, "Plan.webboard").unwrap();
        assert_eq!(staged(&h), Vec::<String>::new());
        unstage(&h, "Plan.webboard").unwrap();
        assert_eq!(staged(&h), Vec::<String>::new());
    }

    #[test]
    fn file_unstage_takes_only_a_file_name() {
        let h = harness();
        let outside = h.documents.path().parent().unwrap().join("Plan.webboard");
        fs::write(&outside, b"not staged").unwrap();
        for name in ["../Plan.webboard", "a/Plan.webboard", "", ".."] {
            assert_eq!(
                unstage(&h, name).unwrap_err(),
                json!({ "code": "file.io", "message": format!("{name:?} is not a file name") })
            );
        }
        assert_eq!(fs::read(&outside).unwrap(), b"not staged");
        fs::remove_file(outside).unwrap();
    }

    #[test]
    fn file_stage_refuses_a_missing_name_and_json() {
        let h = harness();
        assert_eq!(
            invoke_with(&h, "file_stage", InvokeBody::Raw(b"x".to_vec()), None).unwrap_err(),
            json!({ "code": "file.io", "message": "missing x-name header" })
        );
        assert_eq!(
            stage(&h, "", b"x").unwrap_err(),
            json!({ "code": "file.io", "message": "x-name names no file" })
        );
        assert_eq!(
            invoke_with(
                &h,
                "file_stage",
                InvokeBody::Json(json!({})),
                Some(("x-name", &encode("Plan.webboard")))
            )
            .unwrap_err(),
            json!({ "code": "file.io", "message": "file_stage expects raw bytes" })
        );
        assert_eq!(staged(&h), Vec::<String>::new());
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
        invoke_with(h, cmd, body, x_path.map(|p| ("x-path", p)))
    }

    fn invoke_with(
        h: &Harness,
        cmd: &str,
        body: InvokeBody,
        header: Option<(&'static str, &str)>,
    ) -> std::result::Result<InvokeResponseBody, Value> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some((name, value)) = header {
            headers.insert(name, value.parse().unwrap());
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

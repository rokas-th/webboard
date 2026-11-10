use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Runtime, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use webboard_core::error::Result;
use webboard_core::CommandError;

const CODE: &str = "file.io";
const EXTENSION: &str = "webboard";
const IMPORT_FILTER: &str = "WebBoard or GanttProject plan";
const EXPORT_FILTER: &str = "WebBoard plan";

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

fn export_name(plan: &str) -> Result<String> {
    let name = plan.replace(['/', '\\'], "-");
    let stem = name.trim_end_matches('.');
    if stem.is_empty() {
        return Err(io("The plan has no name to export under."));
    }
    Ok(format!("{stem}.{EXTENSION}"))
}

#[cfg(any(desktop, test))]
fn with_extension(path: PathBuf) -> Result<PathBuf> {
    let stem = path
        .file_name()
        .map(|n| {
            n.to_str()
                .map(|n| n.trim_end_matches('.').to_string())
                .ok_or_else(|| io("The chosen file name is not UTF-8."))
        })
        .transpose()?
        .unwrap_or_default();
    if stem.is_empty() {
        return Err(io("The chosen file name has no name before the extension."));
    }
    let trimmed = path.with_file_name(&stem);
    let has = trimmed
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION));
    if has {
        return Ok(trimmed);
    }
    let mut text = trimmed.into_os_string();
    text.push(format!(".{EXTENSION}"));
    Ok(PathBuf::from(text))
}

#[cfg(any(desktop, test))]
fn replace_question(file: &str) -> String {
    format!("{file} already exists. Replace it?")
}

fn picked_path(file: FilePath) -> Result<PathBuf> {
    let shown = file.to_string();
    file.into_path().map_err(|e| {
        io(format!(
            "The dialog answered {shown}, which is not a file on this device ({e})."
        ))
    })
}

fn utf8_name(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .ok_or_else(|| io("The chosen file name is not UTF-8."))
}

#[cfg(any(desktop, test))]
fn export_with(
    name: &str,
    bytes: &[u8],
    dialog: impl FnOnce(&str) -> Option<FilePath>,
    confirm: impl FnOnce(&str) -> bool,
) -> Result<Option<String>> {
    let Some(picked) = dialog(name) else {
        return Ok(None);
    };
    let picked = picked_path(picked)?;
    let path = with_extension(picked.clone())?;
    let file = utf8_name(&path)?;
    let taken = path != picked
        && path
            .try_exists()
            .map_err(|e| io(format!("Could not check {}: {e}.", path.display())))?;
    if taken && !confirm(&file) {
        return Ok(None);
    }
    write_file(&path, bytes)?;
    Ok(Some(file))
}

#[cfg(any(target_os = "ios", test))]
fn export_staged(
    dir: &Path,
    name: &str,
    bytes: &[u8],
    dialog: impl FnOnce(&str) -> Option<FilePath>,
) -> Result<Option<String>> {
    let staged = dir.join(name);
    write_file(&staged, bytes)?;
    let answered = dialog(name)
        .map(|file| picked_path(file).and_then(|path| utf8_name(&path)))
        .transpose();
    match (answered, remove_staged(&staged)) {
        (Ok(answer), Ok(())) => Ok(answer),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(first), Err(second)) => Err(io(format!("{} {}", first.message, second.message))),
    }
}

fn frame(name: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
    let len = u32::try_from(name.len()).map_err(|_| {
        io(format!(
            "The chosen file name is {} bytes long.",
            name.len()
        ))
    })?;
    Ok([&len.to_le_bytes()[..], name.as_bytes(), &bytes].concat())
}

fn import_with(dialog: impl FnOnce() -> Option<FilePath>) -> Result<Vec<u8>> {
    let Some(picked) = dialog() else {
        return Ok(Vec::new());
    };
    let path = picked_path(picked)?;
    let name = utf8_name(&path)?;
    frame(&name, read_file(&path)?)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plan_export<R: Runtime>(
    window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<Option<String>> {
    let plan = header(&request, "x-name")?;
    let bytes = raw_body(&request, "plan_export")?;
    let name = export_name(&plan)?;
    super::blocking("plan_export", CODE, move || {
        export_with(
            &name,
            &bytes,
            |name| {
                window
                    .dialog()
                    .file()
                    .add_filter(EXPORT_FILTER, &[EXTENSION])
                    .set_file_name(name)
                    .set_parent(&window)
                    .blocking_save_file()
            },
            |file| {
                window
                    .dialog()
                    .message(replace_question(file))
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                    .parent(&window)
                    .blocking_show()
            },
        )
    })
    .await
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn plan_export<R: Runtime>(
    window: WebviewWindow<R>,
    staging: tauri::State<'_, super::Started<Staging>>,
    request: Request<'_>,
) -> Result<Option<String>> {
    let plan = header(&request, "x-name")?;
    let bytes = raw_body(&request, "plan_export")?;
    let name = export_name(&plan)?;
    let dir = staging.get()?.0.clone();
    super::blocking("plan_export", CODE, move || {
        export_staged(&dir, &name, &bytes, |name| {
            window
                .dialog()
                .file()
                .add_filter(EXPORT_FILTER, &[EXTENSION])
                .set_file_name(name)
                .blocking_save_file()
        })
    })
    .await
}

#[tauri::command]
pub async fn plan_import<R: Runtime>(window: WebviewWindow<R>) -> Result<Response> {
    let framed = super::blocking("plan_import", CODE, move || {
        import_with(|| {
            let dialog = window
                .dialog()
                .file()
                .add_filter(IMPORT_FILTER, &[EXTENSION, "gantt"]);
            #[cfg(desktop)]
            let dialog = dialog.set_parent(&window);
            dialog.blocking_pick_file()
        })
    })
    .await?;
    Ok(Response::new(framed))
}

#[cfg(target_os = "ios")]
pub struct Staging(pub PathBuf);

#[cfg(any(target_os = "ios", test))]
fn remove_staged(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(format!("Could not remove {}: {e}.", path.display()))),
    }
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
            .invoke_handler(tauri::generate_handler![plan_export, plan_import])
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

    fn url(text: &str) -> FilePath {
        FilePath::Url(tauri::Url::parse(text).unwrap())
    }

    fn in_dir(dir: &Path, name: &str) -> FilePath {
        FilePath::Path(dir.join(name))
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn never_asked(name: &str) -> bool {
        panic!("asked whether to replace {name}")
    }

    #[test]
    fn export_name_turns_separators_into_dashes_and_adds_the_extension() {
        assert_eq!(
            export_name("Q3/Q4 \\ Bridge").unwrap(),
            "Q3-Q4 - Bridge.webboard"
        );
        assert_eq!(export_name("Bridge ü").unwrap(), "Bridge ü.webboard");
    }

    #[test]
    fn export_name_trims_every_trailing_dot() {
        [
            ("Plan.", "Plan.webboard"),
            ("Plan..", "Plan.webboard"),
            ("Plan.v2...", "Plan.v2.webboard"),
            ("a/.", "a-.webboard"),
            ("v1.2", "v1.2.webboard"),
        ]
        .iter()
        .for_each(|(plan, offered)| assert_eq!(export_name(plan).unwrap(), *offered, "{plan}"));
        assert_eq!(
            export_name("...").unwrap_err(),
            CommandError::new("file.io", "The plan has no name to export under.")
        );
    }

    #[test]
    fn export_name_refuses_an_empty_name() {
        assert_eq!(
            export_name("").unwrap_err(),
            CommandError::new("file.io", "The plan has no name to export under.")
        );
    }

    #[test]
    fn a_bare_name_gets_the_extension() {
        [
            ("/x/Plan", "/x/Plan.webboard"),
            ("/x/Plan.v2", "/x/Plan.v2.webboard"),
            ("/x/Plan.WEBBOARD", "/x/Plan.WEBBOARD"),
            ("/x/Plan.webboard", "/x/Plan.webboard"),
            ("/x/Plan.", "/x/Plan.webboard"),
            ("/x/Plan..", "/x/Plan.webboard"),
            ("/x/Plan...", "/x/Plan.webboard"),
            ("/x/Plan.v2..", "/x/Plan.v2.webboard"),
            ("/x/Plan.webboard.", "/x/Plan.webboard"),
        ]
        .iter()
        .for_each(|(picked, written)| {
            assert_eq!(
                with_extension(PathBuf::from(picked)).unwrap(),
                PathBuf::from(written),
                "{picked}"
            )
        });
    }

    #[test]
    fn a_name_of_only_dots_is_refused() {
        ["/x/...", "/x/.....", "/x/.."].iter().for_each(|picked| {
            assert_eq!(
                with_extension(PathBuf::from(picked)).unwrap_err(),
                CommandError::new(
                    "file.io",
                    "The chosen file name has no name before the extension."
                ),
                "{picked}"
            )
        });
    }

    #[test]
    fn export_refuses_a_picked_name_of_only_dots_and_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let answer = export_with(
            "Bridge.webboard",
            b"WBX1 plan",
            |_| Some(in_dir(tmp.path(), "...")),
            never_asked,
        );
        assert_eq!(
            answer.unwrap_err(),
            CommandError::new(
                "file.io",
                "The chosen file name has no name before the extension."
            )
        );
        assert!(names(tmp.path()).is_empty());
    }

    #[test]
    fn export_writes_under_the_name_with_the_extension_and_answers_it() {
        let tmp = TempDir::new().unwrap();
        let mut offered = String::new();
        let answer = export_with(
            "Bridge.webboard",
            b"WBX1 plan",
            |name| {
                offered = name.to_string();
                Some(in_dir(tmp.path(), "Bridge"))
            },
            never_asked,
        );
        assert_eq!(answer, Ok(Some("Bridge.webboard".to_string())));
        assert_eq!(offered, "Bridge.webboard");
        assert_eq!(names(tmp.path()), ["Bridge.webboard"]);
        assert_eq!(
            fs::read(tmp.path().join("Bridge.webboard")).unwrap(),
            b"WBX1 plan"
        );
    }

    #[test]
    fn export_asks_about_the_corrected_name_and_a_no_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Plan.webboard"), b"old plan").unwrap();
        let mut asked = Vec::new();
        let answer = export_with(
            "Plan.webboard",
            b"new plan",
            |_| Some(in_dir(tmp.path(), "Plan.")),
            |name| {
                asked.push(name.to_string());
                false
            },
        );
        assert_eq!(answer, Ok(None));
        assert_eq!(asked, ["Plan.webboard"]);
        assert_eq!(names(tmp.path()), ["Plan.webboard"]);
        assert_eq!(
            fs::read(tmp.path().join("Plan.webboard")).unwrap(),
            b"old plan"
        );
    }

    #[test]
    fn export_on_cancel_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(
            export_with("Bridge.webboard", b"WBX1", |_| None, never_asked),
            Ok(None)
        );
        assert_eq!(names(tmp.path()), Vec::<String>::new());
    }

    #[test]
    fn export_replaces_a_picked_file_without_asking() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Bridge.webboard"), b"old plan").unwrap();
        let answer = export_with(
            "Bridge.webboard",
            b"new plan",
            |_| Some(in_dir(tmp.path(), "Bridge.webboard")),
            never_asked,
        );
        assert_eq!(answer, Ok(Some("Bridge.webboard".to_string())));
        assert_eq!(
            fs::read(tmp.path().join("Bridge.webboard")).unwrap(),
            b"new plan"
        );
    }

    #[test]
    fn export_replaces_after_yes() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Bridge.webboard"), b"old plan").unwrap();
        let mut asked = Vec::new();
        let answer = export_with(
            "Bridge.webboard",
            b"new plan",
            |_| Some(in_dir(tmp.path(), "Bridge")),
            |name| {
                asked.push(name.to_string());
                true
            },
        );
        assert_eq!(answer, Ok(Some("Bridge.webboard".to_string())));
        assert_eq!(asked, ["Bridge.webboard"]);
        assert_eq!(names(tmp.path()), ["Bridge.webboard"]);
        assert_eq!(
            fs::read(tmp.path().join("Bridge.webboard")).unwrap(),
            b"new plan"
        );
    }

    #[test]
    fn export_writes_nothing_after_no() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Bridge.webboard"), b"old plan").unwrap();
        let answer = export_with(
            "Bridge.webboard",
            b"new plan",
            |_| Some(in_dir(tmp.path(), "Bridge")),
            |_| false,
        );
        assert_eq!(answer, Ok(None));
        assert_eq!(names(tmp.path()), ["Bridge.webboard"]);
        assert_eq!(
            fs::read(tmp.path().join("Bridge.webboard")).unwrap(),
            b"old plan"
        );
    }

    #[test]
    fn export_keeps_the_old_file_when_it_fails() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("Plan.webboard");
        fs::write(&path, b"old plan").unwrap();
        fs::create_dir(tmp.path().join("Plan.webboard.tmp")).unwrap();
        let e = export_with(
            "Plan.webboard",
            b"new plan",
            |_| Some(in_dir(tmp.path(), "Plan.webboard")),
            never_asked,
        )
        .unwrap_err();
        assert_eq!(e.code, "file.io");
        assert!(
            e.message
                .starts_with(&format!("Could not write {}: ", path.display())),
            "{}",
            e.message
        );
        assert_eq!(fs::read(&path).unwrap(), b"old plan");
    }

    #[test]
    fn export_staged_keeps_the_copy_only_while_the_dialog_is_open() {
        let documents = TempDir::new().unwrap();
        let staged = documents.path().join("Bridge.webboard");
        let mut seen = None;
        let answer = export_staged(documents.path(), "Bridge.webboard", b"WBX1 plan", |name| {
            seen = Some((name.to_string(), fs::read(&staged).unwrap()));
            Some(url(
                "file:///private/var/mobile/Shared/Bridge%20%C3%BC.webboard",
            ))
        });
        assert_eq!(answer, Ok(Some("Bridge ü.webboard".to_string())));
        assert_eq!(
            seen,
            Some(("Bridge.webboard".to_string(), b"WBX1 plan".to_vec()))
        );
        assert_eq!(names(documents.path()), Vec::<String>::new());

        let answer = export_staged(documents.path(), "Bridge.webboard", b"WBX1", |_| None);
        assert_eq!(answer, Ok(None));
        assert_eq!(names(documents.path()), Vec::<String>::new());
    }

    #[test]
    fn export_staged_opens_no_dialog_when_staging_fails() {
        let tmp = TempDir::new().unwrap();
        let documents = tmp.path().join("Documents");
        fs::write(&documents, b"a file where the folder goes").unwrap();
        let e = export_staged(&documents, "Bridge.webboard", b"WBX1", |name| {
            panic!("opened the dialog for {name}")
        })
        .unwrap_err();
        assert_eq!(e.code, "file.io");
        assert!(
            e.message.starts_with(&format!(
                "Could not write {}: ",
                documents.join("Bridge.webboard").display()
            )),
            "{}",
            e.message
        );
    }

    #[test]
    fn export_staged_names_both_failures() {
        use std::os::unix::fs::PermissionsExt;
        let documents = TempDir::new().unwrap();
        let staged = documents.path().join("Bridge.webboard");
        let e = export_staged(documents.path(), "Bridge.webboard", b"WBX1", |_| {
            fs::set_permissions(documents.path(), fs::Permissions::from_mode(0o555)).unwrap();
            Some(url("https://x/y"))
        })
        .unwrap_err();
        fs::set_permissions(documents.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(e.code, "file.io");
        let dialog = "The dialog answered https://x/y, which is not a file on this device (URL is not a valid path).";
        let removal = format!(" Could not remove {}: ", staged.display());
        assert!(
            e.message.starts_with(dialog) && e.message[dialog.len()..].starts_with(&removal),
            "{}",
            e.message
        );
    }

    #[test]
    fn import_frames_the_name_and_the_bytes() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("Bridge ü.gantt"), b"<project/>").unwrap();
        let framed = import_with(|| Some(in_dir(tmp.path(), "Bridge ü.gantt"))).unwrap();
        let name = "Bridge ü.gantt".as_bytes();
        let mut expected = (name.len() as u32).to_le_bytes().to_vec();
        expected.extend_from_slice(name);
        expected.extend_from_slice(b"<project/>");
        assert_eq!(framed, expected);
        assert_eq!(&framed[..4], &[15, 0, 0, 0]);
    }

    #[test]
    fn import_on_cancel_answers_nothing() {
        assert_eq!(import_with(|| None), Ok(Vec::new()));
    }

    #[test]
    fn import_names_a_file_it_cannot_read() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("Gone.webboard");
        let e = import_with(|| Some(FilePath::Path(missing.clone()))).unwrap_err();
        assert_eq!(e.code, "file.io");
        assert!(
            e.message
                .starts_with(&format!("Could not read {}: ", missing.display())),
            "{}",
            e.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_name_that_is_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(b"/x/Bridge\xff.webboard"));
        assert_eq!(
            import_with(|| Some(FilePath::Path(path))),
            Err(CommandError::new(
                "file.io",
                "The chosen file name is not UTF-8."
            ))
        );
    }

    #[test]
    fn picked_path_decodes_a_file_url() {
        let path = picked_path(url("file:///x/Bridge%20%C3%BC.webboard")).unwrap();
        assert_eq!(path, PathBuf::from("/x/Bridge ü.webboard"));
        assert_eq!(utf8_name(&path), Ok("Bridge ü.webboard".to_string()));
    }

    #[test]
    fn picked_path_refuses_a_url_that_is_not_a_file() {
        assert_eq!(
            picked_path(url("https://x/y")),
            Err(CommandError::new(
                "file.io",
                "The dialog answered https://x/y, which is not a file on this device (URL is not a valid path)."
            ))
        );
    }

    #[test]
    fn the_replace_question_names_the_file() {
        assert_eq!(
            replace_question("Bridge.webboard"),
            "Bridge.webboard already exists. Replace it?"
        );
    }

    #[test]
    fn plan_export_checks_its_request_before_any_dialog() {
        let h = harness();
        assert_eq!(
            invoke_with(&h, "plan_export", InvokeBody::Raw(b"WBX1".to_vec()), None).unwrap_err(),
            json!({ "code": "file.io", "message": "missing x-name header" })
        );
        assert_eq!(
            invoke_with(
                &h,
                "plan_export",
                InvokeBody::Json(json!({})),
                Some(("x-name", &encode("Bridge")))
            )
            .unwrap_err(),
            json!({ "code": "file.io", "message": "plan_export expects raw bytes" })
        );
        assert_eq!(
            invoke_with(
                &h,
                "plan_export",
                InvokeBody::Raw(b"WBX1".to_vec()),
                Some(("x-name", ""))
            )
            .unwrap_err(),
            json!({ "code": "file.io", "message": "The plan has no name to export under." })
        );
    }
}

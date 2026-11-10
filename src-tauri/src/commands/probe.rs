use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use webboard_core::error::Result;
use webboard_core::CommandError;

const CODE: &str = "probe.io";
const FILE: &str = "probe.log";

fn io(message: String) -> CommandError {
    CommandError::new(CODE, message)
}

pub(crate) fn record(dir: &Path, line: &str) -> Result<()> {
    if line.contains(['\n', '\r']) {
        return Err(io(format!("A probe line holds a line break: {line:?}")));
    }
    let text = format!("WBPROBE {line}");
    println!("{text}");
    std::fs::create_dir_all(dir)
        .map_err(|e| io(format!("Could not create {}: {e}", dir.display())))?;
    let path = dir.join(FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| io(format!("Could not open {}: {e}", path.display())))?;
    writeln!(file, "{text}")
        .and_then(|()| file.sync_data())
        .map_err(|e| io(format!("Could not append to {}: {e}", path.display())))
}

#[tauri::command]
pub async fn probe_log(app: tauri::AppHandle, line: String) -> Result<()> {
    let dir = super::app_dir(&app, CODE)?;
    super::blocking("probe_log", CODE, move || record(&dir, &line)).await
}

#[cfg(test)]
mod tests {
    use super::record;

    #[test]
    fn a_line_is_appended_with_its_prefix() {
        let dir = tempfile::tempdir().expect("temp dir");
        let nested = dir.path().join("app");
        record(&nested, "ready").expect("first line");
        record(&nested, "keys {\"key\":\"k\"}").expect("second line");
        let text = std::fs::read_to_string(nested.join("probe.log")).expect("probe.log");
        assert_eq!(text, "WBPROBE ready\nWBPROBE keys {\"key\":\"k\"}\n");
    }

    #[test]
    fn a_line_break_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");
        let e = record(dir.path(), "a\nb").expect_err("a line break is refused");
        assert_eq!(e.code, "probe.io");
        assert!(!dir.path().join("probe.log").exists());
    }

    #[test]
    fn an_unwritable_folder_is_probe_io() {
        let dir = tempfile::tempdir().expect("temp dir");
        let blocker = dir.path().join("file");
        std::fs::write(&blocker, b"x").expect("blocker");
        let e = record(&blocker, "ready").expect_err("a file is not a folder");
        assert_eq!(e.code, "probe.io");
        assert!(e.message.starts_with("Could not create"), "{}", e.message);
    }
}

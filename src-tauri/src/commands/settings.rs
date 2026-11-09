use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use webboard_core::error::Result;
use webboard_core::CommandError;

const FILE: &str = "settings.json";

static WRITING: Mutex<()> = Mutex::new(());

fn io(message: String) -> CommandError {
    CommandError::new("settings.io", message)
}

pub fn settings_read_in(dir: &Path) -> Result<Value> {
    let bytes = match fs::read(dir.join(FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(io(format!("Could not read {FILE}: {e}"))),
    };
    serde_json::from_slice(&bytes).map_err(|e| {
        CommandError::new("settings.corrupt", format!("{FILE} is not valid JSON: {e}"))
    })
}

pub fn settings_write_in(dir: &Path, v: &Value) -> Result<()> {
    let json = serde_json::to_vec(v).map_err(|e| io(format!("Could not encode {FILE}: {e}")))?;
    let _guard = WRITING.lock().map_err(|_| {
        io("Settings are unusable after an earlier panic; restart WebBoard.".to_string())
    })?;
    super::replace_file(dir, FILE, &json).map_err(|e| io(format!("Could not save {FILE}: {e}")))
}

pub fn settings_reset_in(dir: &Path, secs: u64) -> Result<()> {
    let _guard = WRITING.lock().map_err(|_| {
        io("Settings are unusable after an earlier panic; restart WebBoard.".to_string())
    })?;
    match fs::rename(
        dir.join(FILE),
        dir.join(format!("settings.bad-{secs}.json")),
    ) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(format!("Could not set {FILE} aside: {e}"))),
    }
}

#[tauri::command]
pub async fn settings_read(app: tauri::AppHandle) -> Result<Value> {
    let dir = super::app_dir(&app, "settings.io")?;
    super::blocking("settings_read", "settings.io", move || {
        settings_read_in(&dir)
    })
    .await
}

#[tauri::command]
pub async fn settings_write(app: tauri::AppHandle, settings: Value) -> Result<()> {
    let dir = super::app_dir(&app, "settings.io")?;
    super::blocking("settings_write", "settings.io", move || {
        settings_write_in(&dir, &settings)
    })
    .await
}

#[tauri::command]
pub async fn settings_reset(app: tauri::AppHandle) -> Result<()> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| io(format!("The system clock is before 1970: {e}")))?
        .as_secs();
    let dir = super::app_dir(&app, "settings.io")?;
    super::blocking("settings_reset", "settings.io", move || {
        settings_reset_in(&dir, secs)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn settings_round_trip() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(settings_read_in(tmp.path()).unwrap(), Value::Null);
        let v = json!({ "v": 1, "lastRegion": null, "names": { "P": "Beta" }, "syncedHeads": { "P": ["a1"] } });
        settings_write_in(tmp.path(), &v).unwrap();
        assert_eq!(settings_read_in(tmp.path()).unwrap(), v);
        let w = json!({ "v": 1, "lastRegion": null, "names": {} });
        settings_write_in(tmp.path(), &w).unwrap();
        assert_eq!(settings_read_in(tmp.path()).unwrap(), w);
        let mut names: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["settings.json"]);
    }

    #[test]
    fn settings_write_into_a_missing_dir() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("app");
        settings_write_in(&dir, &json!({ "v": 1 })).unwrap();
        assert_eq!(settings_read_in(&dir).unwrap(), json!({ "v": 1 }));
    }

    #[test]
    fn settings_reset() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("settings.json"), "{").unwrap();
        assert_eq!(
            settings_read_in(tmp.path()).unwrap_err().code,
            "settings.corrupt"
        );
        settings_reset_in(tmp.path(), 1_700_000_000).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join("settings.bad-1700000000.json")).unwrap(),
            "{"
        );
        assert!(!tmp.path().join("settings.json").exists());
        assert_eq!(settings_read_in(tmp.path()).unwrap(), Value::Null);
        let empty = TempDir::new().unwrap();
        settings_reset_in(empty.path(), 1_700_000_001).unwrap();
        assert_eq!(fs::read_dir(empty.path()).unwrap().count(), 0);
    }

    #[test]
    fn corrupt_settings() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("settings.json"), "{").unwrap();
        let e = settings_read_in(tmp.path()).unwrap_err();
        assert_eq!(e.code, "settings.corrupt");
        assert!(
            e.message.starts_with("settings.json is not valid JSON: "),
            "{}",
            e.message
        );
        fs::write(tmp.path().join("device.json"), "{").unwrap();
        assert_eq!(
            crate::commands::device::device_info_in(tmp.path())
                .unwrap_err()
                .code,
            "device.io"
        );
    }

    #[test]
    fn settings_io_errors() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("settings.json")).unwrap();
        let e = settings_read_in(tmp.path()).unwrap_err();
        assert_eq!(e.code, "settings.io");
        assert!(
            e.message.starts_with("Could not read settings.json: "),
            "{}",
            e.message
        );
        let e = settings_write_in(tmp.path(), &json!({})).unwrap_err();
        assert_eq!(e.code, "settings.io");
        assert!(
            e.message.starts_with("Could not save settings.json: "),
            "{}",
            e.message
        );
        let file = tmp.path().join("plain");
        fs::write(&file, "x").unwrap();
        let e = settings_reset_in(&file, 1).unwrap_err();
        assert_eq!(e.code, "settings.io");
        assert!(
            e.message.starts_with("Could not set settings.json aside: "),
            "{}",
            e.message
        );
    }
}

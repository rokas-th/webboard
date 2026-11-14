use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use webboard_core::error::Result;
use webboard_core::CommandError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub(crate) device_id: String,
    pub platform: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    device_id: String,
}

#[cfg(target_os = "ios")]
pub(crate) const PLATFORM: &str = "ios";
#[cfg(target_os = "macos")]
pub(crate) const PLATFORM: &str = "macos";
#[cfg(target_os = "linux")]
pub(crate) const PLATFORM: &str = "linux";

const FILE: &str = "device.json";

static MAKING: Mutex<()> = Mutex::new(());

fn io(message: String) -> CommandError {
    CommandError::new("device.io", message)
}

fn valid(id: &str) -> bool {
    id.len() == 11
        && URL_SAFE_NO_PAD
            .decode(id)
            .is_ok_and(|bytes| bytes.len() == 8)
}

fn read(dir: &Path) -> Result<Option<String>> {
    let bytes = match fs::read(dir.join(FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(format!("Could not read {FILE}: {e}"))),
    };
    let stored: Stored =
        serde_json::from_slice(&bytes).map_err(|e| io(format!("{FILE} is not valid: {e}")))?;
    if !valid(&stored.device_id) {
        return Err(io(format!(
            "{FILE} holds a device id that is not 11 base64url characters: {}",
            stored.device_id
        )));
    }
    Ok(Some(stored.device_id))
}

fn make(dir: &Path) -> Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| io(format!("Could not make a device id: {e}")))?;
    let device_id = URL_SAFE_NO_PAD.encode(bytes);
    let json = serde_json::to_vec(&Stored {
        device_id: device_id.clone(),
    })
    .map_err(|e| io(format!("Could not encode {FILE}: {e}")))?;
    super::replace_file(dir, FILE, &json).map_err(|e| io(format!("Could not save {FILE}: {e}")))?;
    Ok(device_id)
}

pub(crate) fn device_info_in(dir: &Path) -> Result<DeviceInfo> {
    let _guard = MAKING.lock().map_err(|_| {
        io("The device id is unusable after an earlier panic; restart WebBoard.".to_string())
    })?;
    let device_id = match read(dir)? {
        Some(id) => id,
        None => make(dir)?,
    };
    Ok(DeviceInfo {
        device_id,
        platform: PLATFORM.to_string(),
    })
}

#[tauri::command]
pub async fn device_info(app: tauri::AppHandle) -> Result<DeviceInfo> {
    let dir = super::app_dir(&app, "device.io")?;
    super::blocking("device_info", "device.io", move || device_info_in(&dir)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn device_id_once() {
        let tmp = TempDir::new().unwrap();
        let first = device_info_in(tmp.path()).unwrap();
        let second = device_info_in(tmp.path()).unwrap();
        assert_eq!(first.device_id.len(), 11);
        assert!(first
            .device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(first, second);
        let expected = if cfg!(target_os = "ios") {
            "ios"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        assert_eq!(first.platform, expected);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::json!({ "deviceId": first.device_id, "platform": expected })
        );
        let other = TempDir::new().unwrap();
        assert_ne!(
            device_info_in(other.path()).unwrap().device_id,
            first.device_id
        );
        assert!(tmp.path().join("device.json").is_file());
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_device() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("device.json"), "{").unwrap();
        let e = device_info_in(tmp.path()).unwrap_err();
        assert_eq!(e.code, "device.io");
        assert!(
            e.message.starts_with("device.json is not valid: "),
            "{}",
            e.message
        );
        fs::write(tmp.path().join("device.json"), r#"{"deviceId":"short"}"#).unwrap();
        let e = device_info_in(tmp.path()).unwrap_err();
        assert_eq!(e.code, "device.io");
        assert_eq!(
            e.message,
            "device.json holds a device id that is not 11 base64url characters: short"
        );
    }
}

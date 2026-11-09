pub mod device;
pub mod holidays;
pub mod settings;
pub mod store;

use std::fs;
use std::io::Write;
use std::path::Path;

pub(crate) fn replace_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, dir.join(name))?;
    fs::File::open(dir)?.sync_all()
}

pub(crate) fn app_dir(
    app: &tauri::AppHandle,
    code: &str,
) -> webboard_core::error::Result<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| {
        webboard_core::CommandError::new(code, format!("Could not find the app data folder: {e}"))
    })
}

pub(crate) async fn blocking<T: Send + 'static>(
    cmd: &str,
    code: &str,
    work: impl FnOnce() -> webboard_core::error::Result<T> + Send + 'static,
) -> webboard_core::error::Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| webboard_core::CommandError::new(code, format!("{cmd} stopped: {e}")))?
}

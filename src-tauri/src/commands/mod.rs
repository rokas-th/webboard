pub mod device;
pub mod file;
pub mod holidays;
#[cfg(feature = "probe")]
pub mod probe;
pub mod settings;
pub mod store;
pub mod sync;

pub(crate) use webboard_core::fsutil::replace_file;

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

pub struct Started<T>(webboard_core::error::Result<T>);

impl<T> Started<T> {
    pub fn new(built: webboard_core::error::Result<T>) -> Self {
        Self(built)
    }

    pub(crate) fn get(&self) -> webboard_core::error::Result<&T> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

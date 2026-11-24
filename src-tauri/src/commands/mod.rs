#[cfg(any(target_os = "ios", test))]
pub mod alert;
#[cfg(any(target_os = "ios", test))]
pub mod appearance;
pub mod device;
pub mod file;
#[cfg(any(target_os = "ios", test))]
pub mod haptic;
pub mod holidays;
#[cfg(any(target_os = "ios", test))]
pub mod menu;
#[cfg(target_os = "macos")]
pub mod print;
#[cfg(feature = "probe")]
pub mod probe;
pub mod settings;
pub mod store;
pub mod sync;
#[cfg(any(target_os = "ios", test))]
pub mod tabbar;

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

#[cfg(any(target_os = "ios", test))]
pub(crate) mod main_thread {
    use std::sync::mpsc::{Receiver, RecvTimeoutError, SendError};
    use std::time::Duration;

    use webboard_core::error::Result;
    use webboard_core::CommandError;

    pub(crate) trait Asked: Copy + Send + 'static {
        const CMD: &'static str;
        const STOPPED: &'static str;
        fn off_main(self) -> CommandError;
        fn no_controller(self) -> CommandError;
        fn unreachable(self, e: &str) -> CommandError;
        fn stopped(why: &str) -> CommandError {
            CommandError::new(Self::STOPPED, format!("{} stopped: {why}", Self::CMD))
        }
    }

    pub(crate) fn dropped<A: Asked>() -> CommandError {
        A::stopped("the main thread dropped it without a result")
    }

    pub(crate) const MAIN_THREAD_WAIT: Duration = Duration::from_secs(5);

    pub(crate) fn unrun<A: Asked>(wait: Duration) -> CommandError {
        A::stopped(&format!(
            "the main thread did not run it within {} ms",
            wait.as_millis()
        ))
    }

    pub(crate) async fn settle<A: Asked, T: Send + 'static>(
        done: Receiver<Result<T>>,
        wait: Duration,
    ) -> Result<T> {
        super::blocking(A::CMD, A::STOPPED, move || {
            done.recv_timeout(wait).map_err(|e| match e {
                RecvTimeoutError::Timeout => unrun::<A>(wait),
                RecvTimeoutError::Disconnected => dropped::<A>(),
            })?
        })
        .await
    }

    pub(crate) fn lost<T>(
        cmd: &str,
        sent: std::result::Result<(), SendError<Result<T>>>,
    ) -> Option<String> {
        let SendError(result) = sent.err()?;
        Some(match result {
            Ok(_) => {
                format!("webboard: {cmd} ran on the main thread after the command stopped waiting")
            }
            Err(e) => format!(
                "webboard: {cmd} failed after the command stopped waiting: {}: {}",
                e.code, e.message
            ),
        })
    }

    #[cfg(target_os = "ios")]
    pub(crate) fn report(fault: Option<String>) {
        use std::io::Write;
        if let Some(fault) = fault {
            let _ = writeln!(std::io::stderr(), "{fault}");
        }
    }

    #[cfg(target_os = "ios")]
    fn on_main<A, T, W>(webview: &tauri::webview::PlatformWebview, asked: A, work: W) -> Result<T>
    where
        A: Asked,
        W: FnOnce(&objc2_ui_kit::UIViewController, Option<&objc2_ui_kit::UIView>) -> Result<T>,
    {
        if objc2::MainThreadMarker::new().is_none() {
            return Err(asked.off_main());
        }
        let Some(controller) = (unsafe {
            webview
                .view_controller()
                .cast::<objc2_ui_kit::UIViewController>()
                .as_ref()
        }) else {
            return Err(asked.no_controller());
        };
        let web = unsafe { webview.inner().cast::<objc2_ui_kit::UIView>().as_ref() };
        work(controller, web)
    }

    #[cfg(target_os = "ios")]
    pub(crate) async fn run<A, T, W>(window: &tauri::WebviewWindow, asked: A, work: W) -> Result<T>
    where
        A: Asked,
        T: Send + 'static,
        W: FnOnce(&objc2_ui_kit::UIViewController) -> Result<T> + Send + 'static,
    {
        run_with_view(window, asked, move |controller, _| work(controller)).await
    }

    #[cfg(target_os = "ios")]
    pub(crate) async fn run_with_view<A, T, W>(
        window: &tauri::WebviewWindow,
        asked: A,
        work: W,
    ) -> Result<T>
    where
        A: Asked,
        T: Send + 'static,
        W: FnOnce(&objc2_ui_kit::UIViewController, Option<&objc2_ui_kit::UIView>) -> Result<T>
            + Send
            + 'static,
    {
        let (sender, done) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                let result = on_main(&webview, asked, work);
                report(lost(A::CMD, sender.send(result)));
            })
            .map_err(|e| asked.unreachable(&e.to_string()))?;
        settle::<A, T>(done, MAIN_THREAD_WAIT).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::mpsc;

        #[derive(Clone, Copy)]
        struct Probe;

        impl Asked for Probe {
            const CMD: &'static str = "probe_cmd";
            const STOPPED: &'static str = "probe.stopped";
            fn off_main(self) -> CommandError {
                CommandError::new("probe.off_main", "off")
            }
            fn no_controller(self) -> CommandError {
                CommandError::new("probe.no_controller", "none")
            }
            fn unreachable(self, e: &str) -> CommandError {
                CommandError::new("probe.unreachable", e)
            }
        }

        #[test]
        fn the_wait_returns_what_the_main_thread_sent() {
            let (sender, done) = mpsc::channel();
            sender.send(Ok(7)).unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(settle::<Probe, i32>(done, MAIN_THREAD_WAIT)),
                Ok(7)
            );
            let (sender, done) = mpsc::channel::<Result<()>>();
            sender.send(Err(Probe.no_controller())).unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(settle::<Probe, ()>(done, MAIN_THREAD_WAIT)),
                Err(CommandError::new("probe.no_controller", "none"))
            );
        }

        #[test]
        fn a_main_thread_that_never_runs_it_stops_the_wait_by_name() {
            let (sender, done) = mpsc::channel::<Result<()>>();
            assert_eq!(
                tauri::async_runtime::block_on(settle::<Probe, ()>(
                    done,
                    Duration::from_millis(20)
                )),
                Err(CommandError::new(
                    "probe.stopped",
                    "probe_cmd stopped: the main thread did not run it within 20 ms"
                ))
            );
            assert_eq!(
                lost("probe_cmd", sender.send(Ok(()))),
                Some(
                    "webboard: probe_cmd ran on the main thread after the command stopped waiting"
                        .to_string()
                )
            );
        }

        #[test]
        fn a_closure_dropped_without_a_result_is_stopped() {
            let (sender, done) = mpsc::channel::<Result<()>>();
            drop(sender);
            assert_eq!(
                tauri::async_runtime::block_on(settle::<Probe, ()>(done, MAIN_THREAD_WAIT)),
                Err(CommandError::new(
                    "probe.stopped",
                    "probe_cmd stopped: the main thread dropped it without a result"
                ))
            );
        }

        #[test]
        fn a_result_nobody_waits_for_is_named() {
            let (sender, done) = mpsc::channel::<Result<()>>();
            assert_eq!(lost("probe_cmd", sender.send(Ok(()))), None);
            drop(done);
            assert_eq!(
                lost("probe_cmd", sender.send(Ok(()))),
                Some(
                    "webboard: probe_cmd ran on the main thread after the command stopped waiting"
                        .to_string()
                )
            );
            assert_eq!(
                lost("probe_cmd", sender.send(Err(Probe.off_main()))),
                Some("webboard: probe_cmd failed after the command stopped waiting: probe.off_main: off".to_string())
            );
        }
    }
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

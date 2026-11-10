use std::sync::mpsc;

use objc2::runtime::NSObjectProtocol;
use objc2::sel;
use objc2_app_kit::NSPrintInfo;
use objc2_web_kit::WKWebView;
use tauri::webview::PlatformWebview;
use tauri::{Runtime, WebviewWindow};
use webboard_core::error::Result;
use webboard_core::CommandError;

const NO_PRINTING: &str =
    "this version of macOS cannot print web pages; printing needs macOS 11 or later.";
const NO_WINDOW: &str = "the page is not in a window.";
const NO_ANSWER: &str = "the window did not answer.";

fn failed(reason: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "print.failed",
        format!("Could not open the print dialog: {reason}"),
    )
}

fn panel_window<T>(can_print: bool, window: Option<T>) -> std::result::Result<T, &'static str> {
    match (can_print, window) {
        (false, _) => Err(NO_PRINTING),
        (true, None) => Err(NO_WINDOW),
        (true, Some(window)) => Ok(window),
    }
}

fn open_panel(webview: &PlatformWebview) -> std::result::Result<(), &'static str> {
    let view = unsafe { webview.inner().cast::<WKWebView>().as_ref() }.ok_or(NO_WINDOW)?;
    let window = panel_window(
        view.respondsToSelector(sel!(printOperationWithPrintInfo:)),
        view.window(),
    )?;
    let info = NSPrintInfo::sharedPrintInfo();
    info.setTopMargin(0.0);
    info.setRightMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    let operation = unsafe { view.printOperationWithPrintInfo(&info) };
    operation.setCanSpawnSeparateThread(true);
    unsafe {
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window,
            None,
            None,
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn print_window<R: Runtime>(window: WebviewWindow<R>) -> Result<()> {
    let (answer, answered) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = answer.send(open_panel(&webview));
        })
        .map_err(failed)?;
    answered
        .try_recv()
        .map_err(|_| failed(NO_ANSWER))?
        .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::ipc::InvokeBody;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    #[test]
    fn print_window_fails_when_the_webview_never_opens_the_panel() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![print_window])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let answer = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "print_window".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({})),
                headers: tauri::http::HeaderMap::new(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap());
        assert_eq!(
            answer,
            Err(json!({
                "code": "print.failed",
                "message": "Could not open the print dialog: the window did not answer."
            }))
        );
    }

    #[test]
    fn the_panel_needs_a_webview_that_can_print_and_a_window() {
        assert_eq!(panel_window(false, Some(())), Err(NO_PRINTING));
        assert_eq!(panel_window(false, None::<()>), Err(NO_PRINTING));
        assert_eq!(panel_window(true, None::<()>), Err(NO_WINDOW));
        assert_eq!(panel_window(true, Some(())), Ok(()));
    }
}

use tauri::{Runtime, WebviewWindow};
use webboard_core::error::Result;
use webboard_core::CommandError;

#[tauri::command]
pub fn print_window<R: Runtime>(window: WebviewWindow<R>) -> Result<()> {
    window.print().map_err(|e| {
        CommandError::new(
            "print.failed",
            format!("Could not open the print dialog: {e}"),
        )
    })
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
    fn print_window_opens_the_print_dialog_of_the_calling_window() {
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
        assert_eq!(answer, Ok(Value::Null));
    }
}

use tauri::State;
use webboard_core::chrono::Local;
use webboard_core::error::Result;
use webboard_core::holidays::{Country, Holidays, PreviewDay, RegionRef, Subdivision, YearOut};

#[tauri::command]
pub async fn holidays_countries(holidays: State<'_, Holidays>) -> Result<Vec<Country>> {
    holidays.countries().await
}

#[tauri::command]
pub async fn holidays_subdivisions(
    holidays: State<'_, Holidays>,
    country: String,
) -> Result<Vec<Subdivision>> {
    holidays.subdivisions(&country).await
}

#[tauri::command]
pub async fn holidays_year(
    holidays: State<'_, Holidays>,
    region: RegionRef,
    year: i32,
    fresh: bool,
) -> Result<YearOut> {
    holidays.year(&region, year, fresh).await
}

#[tauri::command]
pub async fn holidays_ics_preview(
    holidays: State<'_, Holidays>,
    url: String,
) -> Result<Vec<PreviewDay>> {
    holidays.ics_preview(&url, Local::now().date_naive()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::time::{Duration, Instant};
    use tauri::ipc::InvokeBody;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};
    use tempfile::TempDir;
    use webboard_core::holidays::Sources;

    struct Harness {
        _app: App<tauri::test::MockRuntime>,
        webview: WebviewWindow<tauri::test::MockRuntime>,
        _tmp: TempDir,
    }

    fn closed_port() -> SocketAddr {
        let addr = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("bind a port to close");
        let deadline = Instant::now() + Duration::from_secs(1);
        while TcpStream::connect(addr).is_ok() {
            assert!(
                Instant::now() < deadline,
                "{addr} still accepts connections 1 s after its listener closed"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        addr
    }

    fn harness() -> Harness {
        let tmp = TempDir::new().expect("temp dir");
        let base = format!("http://{}", closed_port());
        let sources = Sources {
            openholidays: base.clone(),
            govuk: format!("{base}/bank-holidays.json"),
            opm: format!("{base}/holidays.ics"),
        };
        let holidays = Holidays::new(tmp.path().join("holidays"), sources).expect("Holidays::new");
        let app = mock_builder()
            .manage(holidays)
            .invoke_handler(tauri::generate_handler![
                holidays_countries,
                holidays_subdivisions,
                holidays_year,
                holidays_ics_preview
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        Harness {
            _app: app,
            webview,
            _tmp: tmp,
        }
    }

    fn invoke(h: &Harness, cmd: &str, args: Value) -> std::result::Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&h.webview, request)
            .map(|body| body.deserialize::<Value>().expect("a JSON answer"))
    }

    #[test]
    fn subdivisions_over_ipc_without_a_request() {
        let h = harness();
        assert_eq!(
            invoke(&h, "holidays_subdivisions", json!({ "country": "US" })),
            Ok(json!([]))
        );
        assert_eq!(
            invoke(&h, "holidays_subdivisions", json!({ "country": "GB" })).expect("GB divisions")
                [1],
            json!({ "code": "scotland", "name": "Scotland", "children": [] })
        );
    }

    #[test]
    fn year_takes_the_region_ref_and_reports_offline() {
        let h = harness();
        let answer = invoke(
            &h,
            "holidays_year",
            json!({
                "region": { "src": "openholidays", "country": "CH", "subdivision": "CH-ZH" },
                "year": 2026,
                "fresh": false
            }),
        )
        .expect_err("nothing listens on the source's port");
        assert_eq!(answer["code"], "holidays.offline", "{answer}");
        assert!(
            answer["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("Could not reach 127.0.0.1")),
            "{answer}"
        );

        let preview = invoke(
            &h,
            "holidays_ics_preview",
            json!({ "url": "not a web address" }),
        )
        .expect_err("a malformed URL");
        assert_eq!(preview["code"], "holidays.http", "{preview}");
    }
}

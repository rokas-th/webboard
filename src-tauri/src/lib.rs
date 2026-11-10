mod commands;
mod keychain;
#[cfg(target_os = "macos")]
pub mod menu;

#[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
fn raise_running_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

#[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
fn single_instance_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Err(e) = raise_running_window(app) {
            eprintln!("webboard: could not raise the running window: {e}");
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
enum Quit {
    CloseEveryWindow,
    Exit,
}

fn exit_request(open_windows: usize) -> Quit {
    if open_windows == 0 {
        Quit::Exit
    } else {
        Quit::CloseEveryWindow
    }
}

fn close_every_window<R: tauri::Runtime>(
    windows: &std::collections::HashMap<String, tauri::WebviewWindow<R>>,
) {
    windows.values().for_each(|window| {
        if let Err(e) = window.close() {
            eprintln!("webboard: could not ask {} to close: {e}", window.label());
        }
    });
}

struct Services {
    store: webboard_core::store::Store,
    holidays: webboard_core::holidays::Holidays,
    sync: commands::sync::SyncState,
    #[cfg(target_os = "ios")]
    staging: commands::file::Staging,
}

fn no_folder(e: tauri::Error) -> webboard_core::CommandError {
    webboard_core::CommandError::new(
        "app.setup",
        format!("WebBoard could not find its data folder: {e}"),
    )
}

fn services(
    data: tauri::Result<std::path::PathBuf>,
    #[cfg(target_os = "ios")] documents: tauri::Result<std::path::PathBuf>,
) -> webboard_core::error::Result<Services> {
    use webboard_core::holidays::{Holidays, Sources};
    let dir = data.map_err(no_folder)?;
    let holidays = Holidays::new(dir.join("holidays"), Sources::official())?;
    let http = webboard_core::sync::http_client()?;
    let client = webboard_core::sync::SyncClient::new(
        dir.clone(),
        std::sync::Arc::new(keychain::OsKeychain),
        http,
    );
    #[cfg(feature = "probe")]
    {
        commands::probe::record(&dir, "ready")?;
        commands::probe::record(&dir, &format!("app_data_dir {}", dir.display()))?;
    }
    Ok(Services {
        store: webboard_core::store::Store::new(dir.join("docs")),
        holidays,
        sync: commands::sync::SyncState::new(dir, client),
        #[cfg(target_os = "ios")]
        staging: commands::file::Staging(documents.map_err(no_folder)?),
    })
}

fn manage_services<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    built: webboard_core::error::Result<Services>,
) {
    use commands::Started;
    match built {
        Ok(s) => {
            app.manage(Started::new(Ok(s.store)));
            app.manage(Started::new(Ok(s.holidays)));
            app.manage(Started::new(Ok(s.sync)));
            #[cfg(target_os = "ios")]
            app.manage(Started::new(Ok(s.staging)));
        }
        Err(e) => {
            eprintln!("webboard: setup failed: {}: {}", e.code, e.message);
            app.manage(Started::<webboard_core::store::Store>::new(Err(e.clone())));
            app.manage(Started::<webboard_core::holidays::Holidays>::new(Err(
                e.clone()
            )));
            #[cfg(target_os = "ios")]
            app.manage(Started::<commands::file::Staging>::new(Err(e.clone())));
            app.manage(Started::<commands::sync::SyncState>::new(Err(e)));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(target_vendor = "apple"))]
    webboard_core::tls::install_default_provider()
        .expect("WebBoard could not set its TLS provider");

    let builder = tauri::Builder::default();

    #[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
    let builder = builder.plugin(single_instance_guard());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(menu::app_menu)
        .on_menu_event(menu::on_menu_event);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let built = services(
                app.path().app_data_dir(),
                #[cfg(target_os = "ios")]
                app.path().document_dir(),
            );
            manage_services(app, built);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::store::store_load,
            commands::store::store_append,
            commands::store::store_compact,
            commands::store::store_list,
            commands::store::store_set_aside,
            commands::holidays::holidays_countries,
            commands::holidays::holidays_subdivisions,
            commands::holidays::holidays_year,
            commands::holidays::holidays_ics_preview,
            commands::device::device_info,
            commands::file::file_write,
            commands::file::file_read,
            commands::file::plan_export,
            commands::file::plan_import,
            #[cfg(target_os = "ios")]
            commands::file::file_stage,
            #[cfg(target_os = "ios")]
            commands::file::file_unstage,
            commands::settings::settings_read,
            commands::settings::settings_write,
            commands::settings::settings_reset,
            commands::sync::sync_setup,
            commands::sync::sync_pair_code,
            commands::sync::sync_pair_join,
            commands::sync::sync_ticket,
            commands::sync::sync_devices,
            commands::sync::sync_remove_device,
            commands::sync::sync_status,
            commands::sync::sync_mark_revoked,
            commands::sync::sync_reset,
            #[cfg(feature = "probe")]
            commands::probe::probe_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building WebBoard")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                use tauri::Manager;
                let windows = app.webview_windows();
                if exit_request(windows.len()) == Quit::CloseEveryWindow {
                    api.prevent_exit();
                    close_every_window(&windows);
                }
            }
        });
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    const LIB: &str = include_str!("lib.rs");

    fn run_body() -> &'static str {
        let after = LIB
            .split_once("#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {")
            .expect("run() is defined")
            .1;
        after.split_once("\n}\n").expect("run() has a body").0
    }

    fn source_above_these_tests() -> &'static str {
        LIB.split_once("#[cfg(all(test, not(target_os = \"ios\")))]\nmod tests {")
            .expect("this module is defined")
            .0
    }

    #[test]
    fn the_second_process_guard_is_the_first_plugin_and_never_in_a_debug_build() {
        let body = run_body();

        let guard = body
            .find(".plugin(single_instance_guard())")
            .expect("run() does not register the second-process guard at all");
        let first = body.find(".plugin(").expect("run() registers no plugin");
        assert_eq!(
            guard,
            first,
            "the second-process guard is not the first plugin run() registers; this is:\n{}\n\
             Plugin setups run in registration order and the guard ends a second process \
             with exit(0) from inside its own setup, so whatever is registered ahead of it \
             runs in a process that is about to vanish.",
            body[first..].lines().next().unwrap_or_default().trim()
        );

        let registrations = body.matches(".plugin(single_instance_guard())").count();
        assert_eq!(
            registrations, 1,
            "run() registers the second-process guard {registrations} times. tauri's \
             PluginStore::register removes the plugin already registered under this name \
             and pushes the new one at the END of the store, so a second registration \
             silently moves the guard last."
        );

        let attr = body[..guard]
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with("#["))
            .expect("the guard's registration carries no attribute at all");
        assert!(
            attr.contains("not(debug_assertions)"),
            "the guard is registered without not(debug_assertions):\n{attr}\n\
             The dev build shares the bundle identifier with the installed app, so \
             compiled in, this makes `tauri dev` hand over and exit(0) instead of \
             opening a window."
        );

        let named = source_above_these_tests()
            .matches("tauri_plugin_single_instance::")
            .count();
        assert_eq!(
            named, 1,
            "the plugin is named {named} times in lib.rs. It may be named once, inside \
             single_instance_guard, which is the single place carrying the release-only cfg."
        );
    }

    fn invoke_on(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let request = tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        tauri::test::get_ipc_response(webview, request).map(|body| {
            body.deserialize::<serde_json::Value>()
                .expect("a JSON answer")
        })
    }

    fn app_with(
        built: webboard_core::error::Result<super::Services>,
    ) -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                super::commands::store::store_list,
                super::commands::holidays::holidays_countries,
                super::commands::sync::sync_status
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        super::manage_services(&app, built);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        (app, webview)
    }

    #[test]
    fn a_failed_setup_step_answers_every_command_with_its_error() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(tmp.path().join("holidays"), b"")
            .expect("a file where the cache folder goes");
        let built = super::services(Ok(tmp.path().to_path_buf()));
        let failure = match &built {
            Ok(_) => panic!("setup succeeded although the holiday cache folder is a file"),
            Err(e) => e.clone(),
        };
        assert_eq!(failure.code, "holidays.io", "{}", failure.message);
        let (_app, webview) = app_with(built);
        let answer = serde_json::json!({ "code": failure.code, "message": failure.message });
        ["store_list", "holidays_countries", "sync_status"]
            .into_iter()
            .for_each(|cmd| assert_eq!(invoke_on(&webview, cmd), Err(answer.clone()), "{cmd}"));
    }

    #[test]
    fn a_missing_data_folder_is_named_and_kept() {
        let built = super::services(Err(tauri::Error::UnknownPath));
        let failure = match &built {
            Ok(_) => panic!("setup succeeded without a data folder"),
            Err(e) => e.clone(),
        };
        assert_eq!(
            failure,
            webboard_core::CommandError::new(
                "app.setup",
                "WebBoard could not find its data folder: unknown path"
            )
        );
        let (_app, webview) = app_with(built);
        assert_eq!(
            invoke_on(&webview, "store_list"),
            Err(serde_json::json!({ "code": failure.code, "message": failure.message }))
        );
    }

    #[test]
    fn a_working_setup_serves_the_commands() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let (_app, webview) = app_with(super::services(Ok(tmp.path().to_path_buf())));
        assert_eq!(invoke_on(&webview, "store_list"), Ok(serde_json::json!([])));
        assert_eq!(
            invoke_on(&webview, "sync_status"),
            Ok(serde_json::json!({ "space": null, "revoked": false }))
        );
    }

    #[test]
    fn setup_itself_never_fails() {
        let body = run_body();
        let setup = body
            .split_once(".setup(|app| {")
            .expect("run() has a setup hook")
            .1
            .split_once(".invoke_handler(")
            .expect("the setup hook ends before the handlers")
            .0;
        assert!(
            !setup.contains('?'),
            "the setup hook still returns early with ?, so a failure panics in tauri before any window exists:\n{setup}"
        );
    }

    #[test]
    fn an_exit_request_closes_every_open_window_first() {
        use super::{exit_request, Quit};
        assert_eq!(exit_request(1), Quit::CloseEveryWindow);
        assert_eq!(exit_request(3), Quit::CloseEveryWindow);
        assert_eq!(exit_request(0), Quit::Exit);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_quit_menu_item_closes_every_window_first() {
        use super::menu::{menu_quit, QUIT_MENU_ID};
        use super::Quit;
        assert_eq!(menu_quit(QUIT_MENU_ID, 1), Some(Quit::CloseEveryWindow));
        assert_eq!(menu_quit(QUIT_MENU_ID, 3), Some(Quit::CloseEveryWindow));
        assert_eq!(menu_quit(QUIT_MENU_ID, 0), Some(Quit::Exit));
        assert_eq!(menu_quit("webboard-other", 1), None);
        assert_eq!(menu_quit("", 0), None);
    }

    #[test]
    fn run_sets_the_mac_app_menu_and_routes_its_events() {
        let body = run_body();
        let menu = body
            .find(".menu(menu::app_menu)")
            .expect("run() does not set WebBoard's app menu, so ⌘Q stays tauri's predefined Quit and skips the window close guard");
        let attr = body[..menu]
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with("#["))
            .expect("the app menu is set without a cfg");
        assert!(
            attr.contains("target_os = \"macos\""),
            "the app menu is set outside a macOS-only cfg, so Linux would gain a menu bar: {attr}"
        );
        let statement = body[menu..].split_once(';').map_or("", |(head, _)| head);
        assert!(
            statement.contains(".on_menu_event(menu::on_menu_event)"),
            "run() sets the app menu without routing its events to menu::on_menu_event"
        );
    }

    #[test]
    fn run_routes_exit_requests_through_the_decision() {
        let body = run_body();
        assert!(
            body.contains("tauri::RunEvent::ExitRequested { api, .. }"),
            "run() does not handle RunEvent::ExitRequested, so an app-level quit skips the window close guard"
        );
        assert!(
            body.contains("exit_request(windows.len())"),
            "run() handles ExitRequested without asking exit_request with the open-window count"
        );
    }

    #[test]
    fn the_capabilities_let_the_close_guard_destroy_the_window() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json is JSON");
        let permissions = caps["permissions"]
            .as_array()
            .expect("capabilities/default.json has a permissions array");
        assert!(
            permissions
                .iter()
                .any(|p| p.as_str() == Some("core:window:allow-destroy")),
            "capabilities/default.json does not grant core:window:allow-destroy, so the close \
             guard's destroy() is refused and the window never closes: {permissions:?}"
        );
    }

    #[test]
    fn the_mac_bundle_is_sealed_ad_hoc() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(
            conf["bundle"]["macOS"]["signingIdentity"].as_str(),
            Some("-"),
            "bundle.macOS.signingIdentity is not \"-\", so the bundle is only linker-signed \
             and `codesign --verify --deep --strict` reports a broken seal"
        );
    }

    #[test]
    fn the_updater_asks_webboard_only_and_ordinary_builds_need_no_signing_key() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(
            conf["plugins"]["updater"]["endpoints"],
            serde_json::json!(["https://webboard.rokass.org/releases/latest.json"]),
            "plugins.updater.endpoints is not exactly the one release manifest on webboard.rokass.org"
        );
        assert!(
            conf["plugins"]["updater"]["pubkey"].is_string(),
            "plugins.updater.pubkey is missing or not a string, so the updater plugin cannot start"
        );
        assert_ne!(
            conf["bundle"]["createUpdaterArtifacts"].as_bool(),
            Some(true),
            "bundle.createUpdaterArtifacts is true, so every build (and every gate) needs the \
             private signing key; signing is the owner's step R2 on the finished artifacts"
        );
    }

    #[test]
    fn the_update_plugins_are_registered_and_permitted_on_the_desktops_only() {
        let body = run_body();
        let updater = body
            .find(".plugin(tauri_plugin_updater::Builder::new().build())")
            .expect("run() does not register the updater plugin");
        let process = body
            .find(".plugin(tauri_plugin_process::init())")
            .expect("run() does not register the process plugin");
        let attr = body[..updater]
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with("#["))
            .expect("the updater is registered without a cfg");
        assert_eq!(
            attr.trim(),
            "#[cfg(desktop)]",
            "the update plugins are registered under {attr}, not #[cfg(desktop)]"
        );
        let statement = body[updater..].split_once(';').map_or("", |(head, _)| head);
        assert!(
            updater < process && statement.contains(".plugin(tauri_plugin_process::init())"),
            "the process plugin is not registered in the same #[cfg(desktop)] statement as the updater"
        );

        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json is JSON");
        assert_eq!(caps["platforms"], serde_json::json!(["macOS", "linux"]));
        let permissions: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("capabilities/default.json has a permissions array")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(
            permissions.contains(&"updater:default") && permissions.contains(&"process:allow-restart"),
            "the desktop capability lacks updater:default or process:allow-restart: {permissions:?}"
        );

        const MANIFEST: &str = include_str!("../Cargo.toml");
        let headers: Vec<&str> = MANIFEST
            .split("\n[")
            .filter(|s| s.contains("tauri-plugin-updater") || s.contains("tauri-plugin-process"))
            .map(|s| s.lines().next().unwrap_or_default())
            .collect();
        assert_eq!(
            headers,
            [
                "target.'cfg(any(target_os = \"macos\", target_os = \"linux\"))'.dependencies]",
                "target.'cfg(target_os = \"macos\")'.dependencies]",
                "target.'cfg(target_os = \"linux\")'.dependencies]",
            ],
            "the update plugins are declared outside the macOS and Linux dependency sections"
        );
        let updater_lines: Vec<&str> = MANIFEST
            .lines()
            .filter(|l| l.starts_with("tauri-plugin-updater"))
            .collect();
        assert_eq!(updater_lines.len(), 2, "tauri-plugin-updater is not declared once for macOS and once for Linux: {updater_lines:?}");
        assert!(
            updater_lines.iter().all(|l| l.contains("default-features = false") && !l.contains("\"zip\"")),
            "tauri-plugin-updater keeps its default features or the zip feature, which neither the macOS tarball nor the Linux .deb uses: {updater_lines:?}"
        );
    }

    #[test]
    fn run_installs_one_tls_provider_before_anything_else_off_apple() {
        let body = run_body();
        let lines: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(
            lines.first().copied(),
            Some("#[cfg(not(target_vendor = \"apple\"))]"),
            "run() does not open with the non-Apple TLS provider install: {:?}",
            lines.first()
        );
        assert!(
            lines
                .get(1)
                .is_some_and(|l| l.starts_with("webboard_core::tls::install_default_provider()")),
            "run()'s first statement is not webboard_core::tls::install_default_provider(), so the updater's first check could make ring the TLS provider of holidays and sync: {:?}",
            lines.get(1)
        );
    }

    #[test]
    fn the_package_describes_itself() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(
            conf["bundle"]["shortDescription"].as_str(),
            Some("Project timeline planner"),
            "bundle.shortDescription is not set, so the .deb says Description: (none)"
        );
        assert!(
            conf["bundle"]["longDescription"]
                .as_str()
                .is_some_and(|d| d.ends_with('.') && d.len() > 20),
            "bundle.longDescription is not one plain sentence"
        );
    }

    #[test]
    fn the_guard_is_a_dependency_of_the_two_desktops_only() {
        const MANIFEST: &str = include_str!("../Cargo.toml");

        let mut sections = MANIFEST
            .split("\n[")
            .filter(|s| s.contains("tauri-plugin-single-instance"));
        let section = sections
            .next()
            .expect("tauri-plugin-single-instance is not declared in src-tauri/Cargo.toml at all");
        assert!(
            sections.next().is_none(),
            "tauri-plugin-single-instance is declared in more than one section of \
             src-tauri/Cargo.toml"
        );

        let header = section.lines().next().unwrap_or_default();
        assert_eq!(
            header, "target.'cfg(any(target_os = \"macos\", target_os = \"linux\"))'.dependencies]",
            "the guard crate is declared under [{header} — it must be declared for macOS \
             and Linux only. Declared unconditionally it enters the iOS dependency tree, \
             and `cargo check --target aarch64-apple-ios-sim` still exits 0 because the \
             crate is cfg'd empty on iOS."
        );
    }
}

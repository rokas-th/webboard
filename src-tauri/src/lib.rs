mod commands;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
    let builder = builder.plugin(single_instance_guard());

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            use webboard_core::holidays::{Holidays, Sources};
            let docs = app.path().app_data_dir()?.join("docs");
            app.manage(webboard_core::store::Store::new(docs));
            let holidays = Holidays::new(
                app.path().app_data_dir()?.join("holidays"),
                Sources::official(),
            )
            .map_err(|e| format!("{}: {}", e.code, e.message))?;
            app.manage(holidays);
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
            commands::settings::settings_read,
            commands::settings::settings_write,
            commands::settings::settings_reset
        ])
        .run(tauri::generate_context!())
        .expect("error while running WebBoard");
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

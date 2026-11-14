#[cfg(any(target_os = "ios", test))]
const PHONE: isize = 0;
#[cfg(any(target_os = "ios", test))]
const PAD: isize = 1;

#[cfg(target_os = "ios")]
const _: () = assert!(
    objc2_ui_kit::UIUserInterfaceIdiom::Phone.0 == PHONE
        && objc2_ui_kit::UIUserInterfaceIdiom::Pad.0 == PAD
);

#[cfg(any(target_os = "ios", test))]
fn idiom_named(raw: isize) -> Result<&'static str, String> {
    match raw {
        PHONE => Ok("phone"),
        PAD => Ok("pad"),
        other => Err(format!(
            "UIKit reports the user interface idiom {other}, which is neither phone ({PHONE}) nor pad ({PAD})"
        )),
    }
}

#[derive(serde::Serialize)]
struct Global<'a> {
    os: &'a str,
    idiom: Option<&'a str>,
}

fn script(os: &str, idiom: Option<&str>) -> String {
    let value = serde_json::to_string(&Global { os, idiom })
        .unwrap_or_else(|e| panic!("the platform global {os}/{idiom:?} did not serialise: {e}"));
    format!(
        "Object.defineProperty(window, \"__WEBBOARD_PLATFORM__\", {{ value: Object.freeze({value}), enumerable: true }});"
    )
}

#[cfg(target_os = "ios")]
fn idiom() -> Result<Option<&'static str>, String> {
    let main = objc2::MainThreadMarker::new()
        .ok_or("WebBoard read the iOS user interface idiom off the main thread")?;
    let raw = objc2_ui_kit::UIDevice::currentDevice(main).userInterfaceIdiom();
    idiom_named(raw.0).map(Some)
}

#[cfg(not(target_os = "ios"))]
fn idiom() -> Result<Option<&'static str>, String> {
    Ok(None)
}

pub(crate) fn stamp<R: tauri::Runtime>() -> Result<tauri::plugin::TauriPlugin<R>, String> {
    Ok(tauri::plugin::Builder::new("webboard-platform")
        .js_init_script(script(crate::commands::device::PLATFORM, idiom()?))
        .build())
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::{idiom_named, script};

    #[test]
    fn the_script_freezes_the_platform_global() {
        assert_eq!(
            script("macos", None),
            r#"Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { value: Object.freeze({"os":"macos","idiom":null}), enumerable: true });"#
        );
        assert_eq!(
            script("ios", Some("pad")),
            r#"Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { value: Object.freeze({"os":"ios","idiom":"pad"}), enumerable: true });"#
        );
    }

    #[test]
    fn uikit_idioms_map_to_phone_and_pad_and_anything_else_is_named() {
        assert_eq!(idiom_named(0), Ok("phone"));
        assert_eq!(idiom_named(1), Ok("pad"));
        assert_eq!(
            idiom_named(5),
            Err(
                "UIKit reports the user interface idiom 5, which is neither phone (0) nor pad (1)"
                    .to_string()
            )
        );
        assert_eq!(
            idiom_named(-1),
            Err(
                "UIKit reports the user interface idiom -1, which is neither phone (0) nor pad (1)"
                    .to_string()
            )
        );
    }
}

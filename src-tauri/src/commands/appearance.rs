use serde::Deserialize;
use webboard_core::CommandError;

use super::main_thread::Asked;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    Light,
    Dark,
    Unspecified,
}

const NO_VIEW: &str = "the view controller has no view";
const NOT_SHOWN: &str = "its view is in no window";

fn style(scheme: Scheme) -> Style {
    match scheme {
        Scheme::Light => Style::Light,
        Scheme::Dark => Style::Dark,
        Scheme::System => Style::Unspecified,
    }
}

fn named(scheme: Scheme) -> &'static str {
    match scheme {
        Scheme::Light => "light",
        Scheme::Dark => "dark",
        Scheme::System => "system",
    }
}

fn cannot(scheme: Scheme, why: &str) -> String {
    format!(
        "The {} appearance cannot be set on the window: {why}.",
        named(scheme)
    )
}

fn no_window(scheme: Scheme, why: &str) -> CommandError {
    CommandError::new("appearance.no_window", cannot(scheme, why))
}

impl Asked for Scheme {
    const CMD: &'static str = "appearance_set";
    const STOPPED: &'static str = "appearance.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "appearance.off_main",
            cannot(self, "WebBoard tried to set it off the main thread"),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "appearance.no_controller",
            cannot(self, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "appearance.unreachable",
            cannot(self, &format!("the window could not be reached: {e}")),
        )
    }
}

#[cfg(target_os = "ios")]
mod uikit {
    use objc2_ui_kit::{UIUserInterfaceStyle, UIViewController};
    use webboard_core::error::Result;

    use super::{no_window, style, Scheme, Style, NOT_SHOWN, NO_VIEW};

    fn ui_style(style: Style) -> UIUserInterfaceStyle {
        match style {
            Style::Light => UIUserInterfaceStyle::Light,
            Style::Dark => UIUserInterfaceStyle::Dark,
            Style::Unspecified => UIUserInterfaceStyle::Unspecified,
        }
    }

    pub(super) fn apply(controller: &UIViewController, scheme: Scheme) -> Result<()> {
        let Some(view) = controller.view() else {
            return Err(no_window(scheme, NO_VIEW));
        };
        let Some(window) = view.window() else {
            return Err(no_window(scheme, NOT_SHOWN));
        };
        window.setOverrideUserInterfaceStyle(ui_style(style(scheme)));
        Ok(())
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn appearance_set(
    window: tauri::WebviewWindow,
    scheme: Scheme,
) -> webboard_core::error::Result<()> {
    super::main_thread::run(&window, scheme, move |controller| {
        uikit::apply(controller, scheme)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::main_thread::dropped;
    use serde_json::json;

    #[test]
    fn the_scheme_is_light_dark_or_system_and_nothing_else() {
        assert_eq!(
            serde_json::from_value::<Scheme>(json!("light")).unwrap(),
            Scheme::Light
        );
        assert_eq!(
            serde_json::from_value::<Scheme>(json!("dark")).unwrap(),
            Scheme::Dark
        );
        assert_eq!(
            serde_json::from_value::<Scheme>(json!("system")).unwrap(),
            Scheme::System
        );
        ["Dark", "System", "auto", "", "unspecified"]
            .iter()
            .for_each(|bad| {
                assert!(
                    serde_json::from_value::<Scheme>(json!(bad)).is_err(),
                    "{bad:?} was accepted"
                )
            });
        assert!(serde_json::from_value::<Scheme>(json!(null)).is_err());
        assert!(serde_json::from_value::<Scheme>(json!(1)).is_err());
    }

    #[test]
    fn each_scheme_asks_uikit_for_its_own_style() {
        assert_eq!(style(Scheme::Light), Style::Light);
        assert_eq!(style(Scheme::Dark), Style::Dark);
        assert_eq!(style(Scheme::System), Style::Unspecified);
    }

    #[test]
    fn every_failure_has_its_own_code_and_names_the_scheme() {
        let errors = [
            Scheme::Dark.off_main(),
            Scheme::Dark.no_controller(),
            no_window(Scheme::Dark, NO_VIEW),
            no_window(Scheme::Light, NOT_SHOWN),
            no_window(Scheme::System, NOT_SHOWN),
            Scheme::Dark.unreachable("the event loop is gone"),
            dropped::<Scheme>(),
        ];
        assert_eq!(
            errors.clone().map(|e| e.code),
            [
                "appearance.off_main",
                "appearance.no_controller",
                "appearance.no_window",
                "appearance.no_window",
                "appearance.no_window",
                "appearance.unreachable",
                "appearance.stopped",
            ]
        );
        assert_eq!(
            errors.map(|e| e.message),
            [
                "The dark appearance cannot be set on the window: WebBoard tried to set it off the main thread.",
                "The dark appearance cannot be set on the window: the window has no view controller.",
                "The dark appearance cannot be set on the window: the view controller has no view.",
                "The light appearance cannot be set on the window: its view is in no window.",
                "The system appearance cannot be set on the window: its view is in no window.",
                "The dark appearance cannot be set on the window: the window could not be reached: the event loop is gone.",
                "appearance_set stopped: the main thread dropped it without a result",
            ]
        );
    }
}

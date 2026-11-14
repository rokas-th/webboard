use serde::Deserialize;
use webboard_core::CommandError;

use super::main_thread::Asked;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Haptic {
    Selection,
    Light,
    Medium,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Impact {
    Light,
    Medium,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Notice {
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Feedback {
    Selection,
    Impact(Impact),
    Notification(Notice),
}

fn feedback(kind: Haptic) -> Feedback {
    match kind {
        Haptic::Selection => Feedback::Selection,
        Haptic::Light => Feedback::Impact(Impact::Light),
        Haptic::Medium => Feedback::Impact(Impact::Medium),
        Haptic::Success => Feedback::Notification(Notice::Success),
        Haptic::Warning => Feedback::Notification(Notice::Warning),
        Haptic::Error => Feedback::Notification(Notice::Error),
    }
}

fn named(kind: Haptic) -> &'static str {
    match kind {
        Haptic::Selection => "selection",
        Haptic::Light => "light",
        Haptic::Medium => "medium",
        Haptic::Success => "success",
        Haptic::Warning => "warning",
        Haptic::Error => "error",
    }
}

fn cannot(kind: Haptic, why: &str) -> String {
    format!("The {} haptic cannot be played: {why}.", named(kind))
}

fn no_view(kind: Haptic) -> CommandError {
    CommandError::new(
        "haptic.no_view",
        cannot(kind, "the view controller has no view to attach it to"),
    )
}

const IN_USE: &str = "its generators are already in use";
const GONE: &str = "the main thread's generators are gone";

fn busy(kind: Haptic, why: &str) -> CommandError {
    CommandError::new("haptic.busy", cannot(kind, why))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keep {
    Build,
    Reuse,
    Rebuild,
}

fn keep<V: PartialEq>(made_for: Option<Option<V>>, now: V) -> Keep {
    match made_for {
        None => Keep::Build,
        Some(Some(view)) if view == now => Keep::Reuse,
        Some(_) => Keep::Rebuild,
    }
}

impl Asked for Haptic {
    const CMD: &'static str = "haptic";
    const STOPPED: &'static str = "haptic.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "haptic.off_main",
            cannot(self, "WebBoard tried to play it off the main thread"),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "haptic.no_controller",
            cannot(self, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "haptic.unreachable",
            cannot(self, &format!("the window could not be reached: {e}")),
        )
    }
}

#[cfg(target_os = "ios")]
mod uikit {
    use std::cell::RefCell;

    use objc2::rc::{Retained, Weak};
    use objc2_ui_kit::{
        UIImpactFeedbackGenerator, UIImpactFeedbackStyle, UINotificationFeedbackGenerator,
        UINotificationFeedbackType, UISelectionFeedbackGenerator, UIView, UIViewController,
    };
    use webboard_core::error::Result;

    use super::{busy, feedback, keep, no_view, Feedback, Haptic, Impact, Keep, Notice};
    use super::{GONE, IN_USE};

    struct Generators {
        view: Weak<UIView>,
        selection: Option<Retained<UISelectionFeedbackGenerator>>,
        light: Option<Retained<UIImpactFeedbackGenerator>>,
        medium: Option<Retained<UIImpactFeedbackGenerator>>,
        notification: Option<Retained<UINotificationFeedbackGenerator>>,
    }

    impl Generators {
        fn new(view: &Retained<UIView>) -> Self {
            Self {
                view: Weak::from_retained(view),
                selection: None,
                light: None,
                medium: None,
                notification: None,
            }
        }

        fn made_for(&self) -> Option<*const UIView> {
            self.view.load().map(|view| Retained::as_ptr(&view))
        }

        fn impact(&mut self, impact: Impact, view: &UIView) -> &UIImpactFeedbackGenerator {
            let slot = match impact {
                Impact::Light => &mut self.light,
                Impact::Medium => &mut self.medium,
            };
            slot.get_or_insert_with(|| {
                UIImpactFeedbackGenerator::feedbackGeneratorWithStyle_forView(
                    impact_style(impact),
                    view,
                )
            })
        }

        fn fire(&mut self, kind: Haptic, view: &UIView) {
            match feedback(kind) {
                Feedback::Selection => self
                    .selection
                    .get_or_insert_with(|| {
                        UISelectionFeedbackGenerator::feedbackGeneratorForView(view)
                    })
                    .selectionChanged(),
                Feedback::Impact(impact) => self.impact(impact, view).impactOccurred(),
                Feedback::Notification(notice) => self
                    .notification
                    .get_or_insert_with(|| {
                        UINotificationFeedbackGenerator::feedbackGeneratorForView(view)
                    })
                    .notificationOccurred(notice_type(notice)),
            }
        }
    }

    thread_local! {
        static KEPT: RefCell<Option<Generators>> = const { RefCell::new(None) };
    }

    fn impact_style(impact: Impact) -> UIImpactFeedbackStyle {
        match impact {
            Impact::Light => UIImpactFeedbackStyle::Light,
            Impact::Medium => UIImpactFeedbackStyle::Medium,
        }
    }

    fn notice_type(notice: Notice) -> UINotificationFeedbackType {
        match notice {
            Notice::Success => UINotificationFeedbackType::Success,
            Notice::Warning => UINotificationFeedbackType::Warning,
            Notice::Error => UINotificationFeedbackType::Error,
        }
    }

    pub(super) fn play(controller: &UIViewController, kind: Haptic) -> Result<()> {
        let Some(view) = controller.view() else {
            return Err(no_view(kind));
        };
        KEPT.try_with(|kept| {
            let mut kept = kept.try_borrow_mut().map_err(|_| busy(kind, IN_USE))?;
            let old = kept.take();
            let made_for = old.as_ref().map(Generators::made_for);
            let generators = match keep(made_for, Retained::as_ptr(&view)) {
                Keep::Reuse => old,
                Keep::Build | Keep::Rebuild => None,
            }
            .unwrap_or_else(|| Generators::new(&view));
            kept.insert(generators).fire(kind, &view);
            Ok(())
        })
        .map_err(|_| busy(kind, GONE))?
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn haptic(
    window: tauri::WebviewWindow,
    kind: Haptic,
) -> webboard_core::error::Result<()> {
    super::main_thread::run(&window, kind, move |controller| {
        uikit::play(controller, kind)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::main_thread::dropped;
    use serde_json::json;

    const KINDS: [(&str, Haptic); 6] = [
        ("selection", Haptic::Selection),
        ("light", Haptic::Light),
        ("medium", Haptic::Medium),
        ("success", Haptic::Success),
        ("warning", Haptic::Warning),
        ("error", Haptic::Error),
    ];

    #[test]
    fn the_six_kinds_decode_and_nothing_else_does() {
        KINDS.iter().for_each(|(word, kind)| {
            assert_eq!(
                serde_json::from_value::<Haptic>(json!(word)).unwrap(),
                *kind
            );
            assert_eq!(named(*kind), *word);
        });
        ["heavy", "soft", "rigid", "Selection", "", "impact"]
            .iter()
            .for_each(|bad| {
                assert!(
                    serde_json::from_value::<Haptic>(json!(bad)).is_err(),
                    "{bad:?} was accepted"
                )
            });
        assert!(serde_json::from_value::<Haptic>(json!(null)).is_err());
    }

    #[test]
    fn each_kind_asks_uikit_for_its_own_generator() {
        assert_eq!(
            KINDS.map(|(_, kind)| feedback(kind)),
            [
                Feedback::Selection,
                Feedback::Impact(Impact::Light),
                Feedback::Impact(Impact::Medium),
                Feedback::Notification(Notice::Success),
                Feedback::Notification(Notice::Warning),
                Feedback::Notification(Notice::Error),
            ]
        );
    }

    #[test]
    fn every_failure_has_its_own_code_and_names_the_kind() {
        let errors = [
            Haptic::Selection.off_main(),
            Haptic::Medium.no_controller(),
            no_view(Haptic::Light),
            Haptic::Error.unreachable("the event loop is gone"),
            dropped::<Haptic>(),
            busy(Haptic::Success, IN_USE),
            busy(Haptic::Warning, GONE),
        ];
        assert_eq!(
            errors.clone().map(|e| e.code),
            [
                "haptic.off_main",
                "haptic.no_controller",
                "haptic.no_view",
                "haptic.unreachable",
                "haptic.stopped",
                "haptic.busy",
                "haptic.busy",
            ]
        );
        assert_eq!(
            errors.map(|e| e.message),
            [
                "The selection haptic cannot be played: WebBoard tried to play it off the main thread.",
                "The medium haptic cannot be played: the window has no view controller.",
                "The light haptic cannot be played: the view controller has no view to attach it to.",
                "The error haptic cannot be played: the window could not be reached: the event loop is gone.",
                "haptic stopped: the main thread dropped it without a result",
                "The success haptic cannot be played: its generators are already in use.",
                "The warning haptic cannot be played: the main thread's generators are gone.",
            ]
        );
    }

    #[test]
    fn the_first_haptic_builds_the_generators() {
        assert_eq!(keep::<u8>(None, 1), Keep::Build);
    }

    #[test]
    fn the_same_view_reuses_the_generators() {
        assert_eq!(keep(Some(Some(1)), 1), Keep::Reuse);
    }

    #[test]
    fn a_different_view_rebuilds_them() {
        assert_eq!(keep(Some(Some(1)), 2), Keep::Rebuild);
    }

    #[test]
    fn a_view_that_is_gone_rebuilds_them() {
        assert_eq!(keep(Some(None), 2), Keep::Rebuild);
    }
}

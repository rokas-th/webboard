use std::io::Write;
use std::sync::mpsc::{Receiver, SendError, Sender};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use webboard_core::error::Result;
use webboard_core::CommandError;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    label: String,
    destructive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ask {
    title: String,
    message: String,
    confirm: Option<Confirm>,
    cancel: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Confirm,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Default,
    Cancel,
    Destructive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Button {
    label: String,
    role: Role,
    answer: Answer,
    preferred: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Alert {
    title: String,
    message: String,
    buttons: Vec<Button>,
}

type Slot = Mutex<Option<Sender<Result<Answer>>>>;

#[derive(Debug, PartialEq, Eq)]
enum Delivery {
    Sent,
    Twice,
    Gone,
    Poisoned,
}

fn empty(what: &str) -> CommandError {
    CommandError::new(
        "alert.empty",
        format!("The alert cannot be shown: its {what} is empty."),
    )
}

fn no_controller() -> CommandError {
    CommandError::new(
        "alert.no_controller",
        "The alert cannot be shown: the window has no view controller to present it from.",
    )
}

fn busy(title: &str) -> CommandError {
    CommandError::new(
        "alert.busy",
        format!("The alert {title:?} cannot be shown: something else is already presented over the window."),
    )
}

fn off_main(title: &str) -> CommandError {
    CommandError::new(
        "alert.off_main",
        format!(
            "The alert {title:?} cannot be shown: WebBoard tried to build it off the main thread."
        ),
    )
}

fn dropped(title: &str) -> CommandError {
    CommandError::new(
        "alert.dropped",
        format!("The alert {title:?} closed without an answer."),
    )
}

fn not_presented(title: &str) -> CommandError {
    CommandError::new(
        "alert.not_presented",
        format!("UIKit did not present the alert {title:?}."),
    )
}

const STOPPED: &str = "alert.stopped";

fn unreachable(title: &str, e: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "alert.unreachable",
        format!("The alert {title:?} cannot be shown: the window could not be reached: {e}"),
    )
}

fn alert(ask: Ask) -> Result<Alert> {
    if ask.title.is_empty() {
        return Err(empty("title"));
    }
    if ask.cancel.is_empty() {
        return Err(empty("cancel label"));
    }
    let cancel = Button {
        label: ask.cancel,
        role: Role::Cancel,
        answer: Answer::Cancel,
        preferred: false,
    };
    let confirm = match ask.confirm {
        None => None,
        Some(c) if c.label.is_empty() => return Err(empty("confirm label")),
        Some(c) => Some(Button {
            label: c.label,
            role: if c.destructive {
                Role::Destructive
            } else {
                Role::Default
            },
            answer: Answer::Confirm,
            preferred: !c.destructive,
        }),
    };
    Ok(Alert {
        title: ask.title,
        message: ask.message,
        buttons: std::iter::once(cancel).chain(confirm).collect(),
    })
}

fn deliver(slot: &Slot, answer: Answer) -> Delivery {
    let Ok(mut held) = slot.lock() else {
        return Delivery::Poisoned;
    };
    match held.take() {
        None => Delivery::Twice,
        Some(sender) => match sender.send(Ok(answer)) {
            Ok(()) => Delivery::Sent,
            Err(_) => Delivery::Gone,
        },
    }
}

fn delivery_fault(title: &str, answer: Answer, delivery: &Delivery) -> Option<String> {
    match delivery {
        Delivery::Sent => None,
        Delivery::Twice => Some(format!(
            "webboard: the alert {title:?} answered {answer:?} after it had already answered"
        )),
        Delivery::Gone => Some(format!(
            "webboard: the alert {title:?} answered {answer:?} after alert_ask stopped waiting"
        )),
        Delivery::Poisoned => Some(format!(
            "webboard: the alert {title:?} could not answer {answer:?}: its answer slot is poisoned"
        )),
    }
}

fn report(fault: Option<String>) {
    if let Some(fault) = fault {
        let _ = writeln!(std::io::stderr(), "{fault}");
    }
}

fn answer_once(slot: &Slot, title: &str, answer: Answer) {
    report(delivery_fault(title, answer, &deliver(slot, answer)));
}

fn refused(sender: Sender<Result<Answer>>, title: &str, e: CommandError) -> Option<String> {
    let SendError(lost) = sender.send(Err(e)).err()?;
    let e = lost.err()?;
    Some(format!(
        "webboard: alert {title:?} failed after alert_ask stopped waiting: {}: {}",
        e.code, e.message
    ))
}

fn refuse(slot: &Slot, title: &str, e: CommandError) -> Option<String> {
    let Ok(mut held) = slot.lock() else {
        return Some(format!(
            "webboard: the alert {title:?} could not report {}: its answer slot is poisoned",
            e.code
        ));
    };
    match held.take() {
        None => Some(format!(
            "webboard: the alert {title:?} failed with {} after it had already answered",
            e.code
        )),
        Some(sender) => refused(sender, title, e),
    }
}

#[cfg(any(feature = "probe", test))]
fn presented_line(title: &str) -> String {
    format!("alert presented {title}")
}

async fn settle(work: impl FnOnce() -> Result<Answer> + Send + 'static) -> Result<Answer> {
    super::blocking("alert_ask", STOPPED, work).await
}

async fn wait(answered: Receiver<Result<Answer>>, title: String) -> Result<Answer> {
    settle(move || answered.recv().map_err(|_| dropped(&title))?).await
}

#[cfg(target_os = "ios")]
mod uikit {
    use std::ptr::NonNull;
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::NSString;
    use objc2_ui_kit::{
        UIAlertAction, UIAlertActionStyle, UIAlertController, UIAlertControllerStyle,
        UIViewController,
    };
    use tauri::webview::PlatformWebview;
    use webboard_core::error::Result;

    use super::{
        answer_once, busy, no_controller, not_presented, off_main, refuse, report, Alert, Answer,
        Role,
    };

    fn style(role: Role) -> UIAlertActionStyle {
        match role {
            Role::Default => UIAlertActionStyle::Default,
            Role::Cancel => UIAlertActionStyle::Cancel,
            Role::Destructive => UIAlertActionStyle::Destructive,
        }
    }

    #[cfg(feature = "probe")]
    pub(super) type Presented = std::path::PathBuf;
    #[cfg(not(feature = "probe"))]
    pub(super) type Presented = ();

    #[cfg(feature = "probe")]
    fn completion(dir: Presented, title: &str) -> Option<RcBlock<dyn Fn()>> {
        let line = super::presented_line(title);
        Some(RcBlock::new(move || {
            let written = std::panic::catch_unwind(|| crate::commands::probe::record(&dir, &line));
            let fault = match written {
                Ok(Ok(())) => return,
                Ok(Err(e)) => format!("{}: {}", e.code, e.message),
                Err(_) => "the probe log panicked".to_string(),
            };
            let _ = std::io::Write::write_fmt(
                &mut std::io::stderr(),
                format_args!("webboard: could not log {line:?}: {fault}\n"),
            );
        }))
    }

    #[cfg(not(feature = "probe"))]
    fn completion(_: Presented, _: &str) -> Option<RcBlock<dyn Fn()>> {
        None
    }

    pub(super) fn present(
        webview: &PlatformWebview,
        alert: &Alert,
        sender: Sender<Result<Answer>>,
        presented: Presented,
    ) -> std::result::Result<(), (Sender<Result<Answer>>, webboard_core::CommandError)> {
        let Some(main) = MainThreadMarker::new() else {
            return Err((sender, off_main(&alert.title)));
        };
        let Some(controller) = (unsafe {
            webview
                .view_controller()
                .cast::<UIViewController>()
                .as_ref()
        }) else {
            return Err((sender, no_controller()));
        };
        if controller.presentedViewController().is_some() {
            return Err((sender, busy(&alert.title)));
        }
        let shown = UIAlertController::alertControllerWithTitle_message_preferredStyle(
            Some(&NSString::from_str(&alert.title)),
            Some(&NSString::from_str(&alert.message)),
            UIAlertControllerStyle::Alert,
            main,
        );
        let slot = Arc::new(Mutex::new(Some(sender)));
        alert.buttons.iter().for_each(|button| {
            let slot = Arc::clone(&slot);
            let title = alert.title.clone();
            let answer = button.answer;
            let handler =
                RcBlock::new(move |_: NonNull<UIAlertAction>| answer_once(&slot, &title, answer));
            let action = UIAlertAction::actionWithTitle_style_handler(
                Some(&NSString::from_str(&button.label)),
                style(button.role),
                Some(&*handler),
                main,
            );
            shown.addAction(&action);
            if button.preferred {
                shown.setPreferredAction(Some(&action));
            }
        });
        let done = completion(presented, &alert.title);
        controller.presentViewController_animated_completion(&shown, true, done.as_deref());
        let asked: &UIViewController = &shown;
        let on_screen = controller
            .presentedViewController()
            .is_some_and(|now| std::ptr::eq(&*now, asked));
        if !on_screen {
            report(refuse(&slot, &alert.title, not_presented(&alert.title)));
        }
        Ok(())
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn alert_ask(window: tauri::WebviewWindow, ask: Ask) -> Result<Answer> {
    let alert = alert(ask)?;
    #[cfg(feature = "probe")]
    let presented = super::app_dir(tauri::Manager::app_handle(&window), "probe.io")?;
    #[cfg(not(feature = "probe"))]
    let presented = ();
    let title = alert.title.clone();
    let (sender, answered) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            if let Err((sender, e)) = uikit::present(&webview, &alert, sender, presented) {
                report(refused(sender, &alert.title, e));
            }
        })
        .map_err(|e| unreachable(&title, e))?;
    wait(answered, title).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    fn ask(value: serde_json::Value) -> Ask {
        serde_json::from_value(value).expect("a well-formed ask")
    }

    fn button(label: &str, role: Role, answer: Answer, preferred: bool) -> Button {
        Button {
            label: label.to_string(),
            role,
            answer,
            preferred,
        }
    }

    #[test]
    fn a_destructive_confirm_is_not_preferred_and_cancel_comes_first() {
        let shown = alert(ask(json!({
            "title": "Delete \"Roadmap\" forever?",
            "message": "Roadmap is erased from this device. This cannot be undone.",
            "confirm": { "label": "Delete forever", "destructive": true },
            "cancel": "Cancel"
        })))
        .expect("a valid ask");
        assert_eq!(
            shown,
            Alert {
                title: "Delete \"Roadmap\" forever?".to_string(),
                message: "Roadmap is erased from this device. This cannot be undone.".to_string(),
                buttons: vec![
                    button("Cancel", Role::Cancel, Answer::Cancel, false),
                    button("Delete forever", Role::Destructive, Answer::Confirm, false),
                ],
            }
        );
    }

    #[test]
    fn a_plain_confirm_is_the_preferred_action() {
        let shown = alert(ask(json!({
            "title": "Load again from the server",
            "message": "m",
            "confirm": { "label": "Load again", "destructive": false },
            "cancel": "Cancel"
        })))
        .expect("a valid ask");
        assert_eq!(
            shown.buttons,
            vec![
                button("Cancel", Role::Cancel, Answer::Cancel, false),
                button("Load again", Role::Default, Answer::Confirm, true),
            ]
        );
    }

    #[test]
    fn without_a_confirm_only_the_cancel_button_is_shown() {
        let shown = alert(ask(json!({
            "title": "t",
            "message": "refused",
            "confirm": null,
            "cancel": "OK"
        })))
        .expect("a valid ask");
        assert_eq!(
            shown.buttons,
            vec![button("OK", Role::Cancel, Answer::Cancel, false)]
        );
    }

    #[test]
    fn an_empty_message_is_allowed() {
        let shown = alert(ask(
            json!({ "title": "t", "message": "", "confirm": null, "cancel": "OK" }),
        ))
        .expect("an empty message is fine");
        assert_eq!(shown.message, "");
    }

    #[test]
    fn empty_labels_are_refused_before_uikit_sees_them() {
        let refused = |value| alert(ask(value)).expect_err("an empty label is refused");
        assert_eq!(
            refused(json!({ "title": "", "message": "m", "confirm": null, "cancel": "OK" })),
            CommandError::new(
                "alert.empty",
                "The alert cannot be shown: its title is empty."
            )
        );
        assert_eq!(
            refused(json!({ "title": "t", "message": "m", "confirm": null, "cancel": "" })),
            CommandError::new(
                "alert.empty",
                "The alert cannot be shown: its cancel label is empty."
            )
        );
        assert_eq!(
            refused(json!({
                "title": "t",
                "message": "m",
                "confirm": { "label": "", "destructive": false },
                "cancel": "Cancel"
            })),
            CommandError::new(
                "alert.empty",
                "The alert cannot be shown: its confirm label is empty."
            )
        );
    }

    #[test]
    fn an_ask_with_an_unknown_or_missing_field_is_refused() {
        assert!(serde_json::from_value::<Ask>(json!({
            "title": "t", "message": "m", "confirm": null, "cancel": "OK", "extra": 1
        }))
        .is_err());
        assert!(serde_json::from_value::<Ask>(json!({
            "title": "t", "message": "m", "confirm": { "label": "x" }, "cancel": "OK"
        }))
        .is_err());
    }

    #[test]
    fn answers_are_encoded_as_lowercase_words() {
        assert_eq!(
            serde_json::to_value(Answer::Confirm).unwrap(),
            json!("confirm")
        );
        assert_eq!(
            serde_json::to_value(Answer::Cancel).unwrap(),
            json!("cancel")
        );
    }

    #[test]
    fn the_first_answer_is_sent_and_a_second_is_named_not_sent() {
        let (sender, answered) = mpsc::channel();
        let slot: Slot = Mutex::new(Some(sender));
        assert_eq!(deliver(&slot, Answer::Confirm), Delivery::Sent);
        assert_eq!(deliver(&slot, Answer::Cancel), Delivery::Twice);
        assert_eq!(answered.recv().unwrap(), Ok(Answer::Confirm));
        assert!(answered.recv().is_err());
        assert_eq!(
            delivery_fault("Delete \"a\" forever?", Answer::Cancel, &Delivery::Twice),
            Some(
                "webboard: the alert \"Delete \\\"a\\\" forever?\" answered Cancel after it had already answered"
                    .to_string()
            )
        );
        assert_eq!(delivery_fault("t", Answer::Confirm, &Delivery::Sent), None);
    }

    #[test]
    fn an_answer_after_the_wait_ended_is_named() {
        let (sender, answered) = mpsc::channel();
        drop(answered);
        let slot: Slot = Mutex::new(Some(sender));
        assert_eq!(deliver(&slot, Answer::Cancel), Delivery::Gone);
        assert_eq!(
            delivery_fault("t", Answer::Cancel, &Delivery::Gone),
            Some(
                "webboard: the alert \"t\" answered Cancel after alert_ask stopped waiting"
                    .to_string()
            )
        );
    }

    #[test]
    fn a_poisoned_slot_is_named_and_does_not_panic() {
        let (sender, _answered) = mpsc::channel();
        let slot: std::sync::Arc<Slot> = std::sync::Arc::new(Mutex::new(Some(sender)));
        let poisoner = std::sync::Arc::clone(&slot);
        let _ = std::thread::spawn(move || {
            let _held = poisoner.lock().unwrap();
            panic!("poison the slot");
        })
        .join();
        assert_eq!(deliver(&slot, Answer::Confirm), Delivery::Poisoned);
        answer_once(&slot, "t", Answer::Confirm);
    }

    #[test]
    fn the_wait_returns_the_answer_or_the_presentation_error() {
        let (sender, answered) = mpsc::channel();
        sender.send(Ok(Answer::Cancel)).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(wait(answered, "t".to_string())),
            Ok(Answer::Cancel)
        );
        let (sender, answered) = mpsc::channel();
        sender.send(Err(busy("t"))).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(wait(answered, "t".to_string())),
            Err(CommandError::new(
                "alert.busy",
                "The alert \"t\" cannot be shown: something else is already presented over the window."
            ))
        );
    }

    #[test]
    fn a_wait_whose_senders_are_all_dropped_is_alert_dropped_not_cancel() {
        let (sender, answered) = mpsc::channel::<Result<Answer>>();
        drop(sender);
        assert_eq!(
            tauri::async_runtime::block_on(wait(answered, "Remove iPad?".to_string())),
            Err(CommandError::new(
                "alert.dropped",
                "The alert \"Remove iPad?\" closed without an answer."
            ))
        );
    }

    #[test]
    fn every_failure_has_its_own_code() {
        let codes = [
            no_controller().code,
            busy("t").code,
            off_main("t").code,
            dropped("t").code,
            empty("title").code,
            unreachable("t", "gone").code,
            not_presented("t").code,
            STOPPED.to_string(),
        ];
        assert_eq!(
            codes,
            [
                "alert.no_controller",
                "alert.busy",
                "alert.off_main",
                "alert.dropped",
                "alert.empty",
                "alert.unreachable",
                "alert.not_presented",
                "alert.stopped"
            ]
        );
    }

    #[test]
    fn a_wait_that_panics_is_alert_stopped_not_alert_dropped() {
        let stopped = tauri::async_runtime::block_on(settle(|| panic!("the wait broke")))
            .expect_err("a panicked wait is an error");
        assert_eq!(stopped.code, "alert.stopped");
        assert!(
            stopped.message.starts_with("alert_ask stopped: "),
            "{}",
            stopped.message
        );
    }

    #[test]
    fn an_alert_uikit_did_not_present_answers_not_presented() {
        let (sender, answered) = mpsc::channel();
        let slot: Slot = Mutex::new(Some(sender));
        assert_eq!(refuse(&slot, "t", not_presented("t")), None);
        assert_eq!(
            tauri::async_runtime::block_on(wait(answered, "t".to_string())),
            Err(CommandError::new(
                "alert.not_presented",
                "UIKit did not present the alert \"t\"."
            ))
        );
        assert_eq!(
            refuse(&slot, "t", not_presented("t")),
            Some(
                "webboard: the alert \"t\" failed with alert.not_presented after it had already answered"
                    .to_string()
            )
        );
    }

    #[test]
    fn a_failure_nobody_waits_for_is_named() {
        let (sender, answered) = mpsc::channel();
        drop(answered);
        assert_eq!(
            refused(sender, "t", busy("t")),
            Some(
                "webboard: alert \"t\" failed after alert_ask stopped waiting: alert.busy: The alert \"t\" cannot be shown: something else is already presented over the window."
                    .to_string()
            )
        );
        let (sender, answered) = mpsc::channel();
        assert_eq!(refused(sender, "t", busy("t")), None);
        assert_eq!(answered.recv().unwrap(), Err(busy("t")));
    }

    #[test]
    fn a_failure_on_a_poisoned_slot_is_named_and_does_not_panic() {
        let (sender, _answered) = mpsc::channel();
        let slot: std::sync::Arc<Slot> = std::sync::Arc::new(Mutex::new(Some(sender)));
        let poisoner = std::sync::Arc::clone(&slot);
        let _ = std::thread::spawn(move || {
            let _held = poisoner.lock().unwrap();
            panic!("poison the slot");
        })
        .join();
        assert_eq!(
            refuse(&slot, "t", not_presented("t")),
            Some(
                "webboard: the alert \"t\" could not report alert.not_presented: its answer slot is poisoned"
                    .to_string()
            )
        );
    }

    #[test]
    fn the_probe_line_names_the_title() {
        assert_eq!(
            presented_line("WebBoard probe alert"),
            "alert presented WebBoard probe alert"
        );
    }
}

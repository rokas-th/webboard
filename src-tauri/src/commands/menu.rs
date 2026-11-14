use std::collections::HashSet;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use serde::Deserialize;
use webboard_core::error::Result;
use webboard_core::CommandError;

use super::main_thread::Asked;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuRow {
    pub id: String,
    pub title: String,
    pub checked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuSection {
    #[serde(deserialize_with = "Option::deserialize")]
    pub title: Option<String>,
    pub rows: Vec<MenuRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuAsk {
    pub token: String,
    pub anchor: Anchor,
    pub sections: Vec<MenuSection>,
}

const SHOWN: &str = "shown";
const DISMISSED: &str = "dismissed";

fn cannot(verb: &str, why: &str) -> String {
    format!("The menu cannot be {verb}: {why}.")
}

fn no_token(verb: &str) -> CommandError {
    CommandError::new("menu.token", cannot(verb, "its token is empty"))
}

fn bad_anchor(why: &str) -> CommandError {
    CommandError::new("menu.anchor", cannot(SHOWN, why))
}

fn bad_rows(why: &str) -> CommandError {
    CommandError::new("menu.rows", cannot(SHOWN, why))
}

fn not_shown(why: &str) -> CommandError {
    CommandError::new("menu.not_shown", cannot(SHOWN, why))
}

fn no_interaction() -> CommandError {
    CommandError::new(
        "menu.no_interaction",
        cannot(DISMISSED, "its button has no menu interaction"),
    )
}

fn no_view(why: &str) -> CommandError {
    CommandError::new("menu.no_view", cannot(SHOWN, why))
}

fn busy(why: &str) -> CommandError {
    CommandError::new(
        "menu.busy",
        format!("The menu cannot be shown or dismissed: {why}."),
    )
}

const NO_VIEW: &str = "the view controller has no view";
const NO_WEB_VIEW: &str = "the window has no web view";
const IN_USE: &str = "the main thread's menu store is already in use";
const GONE: &str = "the main thread's menu store is gone";

fn anchor_fault(anchor: &Anchor) -> Option<String> {
    let sides = [
        ("x", anchor.x),
        ("y", anchor.y),
        ("width", anchor.width),
        ("height", anchor.height),
    ];
    if let Some((name, value)) = sides.iter().find(|(_, value)| !value.is_finite()) {
        return Some(format!(
            "its anchor's {name} is {value}, not a finite number"
        ));
    }
    sides[2..]
        .iter()
        .find(|(_, value)| *value < 0.0)
        .map(|(name, value)| format!("its anchor's {name} is {value}, which is negative"))
}

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn section_fault(n: usize, section: &MenuSection) -> Option<String> {
    if section.title.as_deref().is_some_and(blank) {
        return Some(format!("section {n} has an empty title"));
    }
    if section.rows.is_empty() {
        return Some(format!("section {n} has no row"));
    }
    section.rows.iter().find_map(|row| {
        if blank(&row.id) {
            Some(format!("the row {:?} has an empty id", row.title))
        } else if blank(&row.title) {
            Some(format!("the row with id {:?} has an empty title", row.id))
        } else {
            None
        }
    })
}

fn rows_fault(sections: &[MenuSection]) -> Option<String> {
    if sections.is_empty() {
        return Some("it has no section".to_string());
    }
    if let Some(fault) = sections
        .iter()
        .enumerate()
        .find_map(|(i, section)| section_fault(i + 1, section))
    {
        return Some(fault);
    }
    let mut seen = HashSet::new();
    sections
        .iter()
        .flat_map(|section| section.rows.iter())
        .find(|row| !seen.insert(row.id.as_str()))
        .map(|row| format!("the id {:?} is used twice", row.id))
}

fn validate(ask: &MenuAsk) -> Result<()> {
    if ask.token.is_empty() {
        return Err(no_token(SHOWN));
    }
    if let Some(fault) = anchor_fault(&ask.anchor) {
        return Err(bad_anchor(&fault));
    }
    match rows_fault(&ask.sections) {
        Some(fault) => Err(bad_rows(&fault)),
        None => Ok(()),
    }
}

fn dismissable(token: &str) -> Result<()> {
    if token.is_empty() {
        return Err(no_token(DISMISSED));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Out {
    Ended { token: String },
    Chosen { token: String, id: String },
}

impl Out {
    fn event(&self) -> (&'static str, serde_json::Value) {
        match self {
            Out::Ended { token } => ("menu-ended", serde_json::json!({ "token": token })),
            Out::Chosen { token, id } => (
                "menu-chosen",
                serde_json::json!({ "token": token, "id": id }),
            ),
        }
    }
}

fn emit_fault(out: &Out, e: impl std::fmt::Display) -> String {
    let (name, payload) = out.event();
    format!("webboard: could not emit {name} {payload}: {e}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Join {
    token: String,
    chosen: Option<String>,
    ended: bool,
}

impl Join {
    fn new(token: String) -> Self {
        Self {
            token,
            chosen: None,
            ended: false,
        }
    }

    fn done(&self) -> bool {
        self.ended && self.chosen.is_some()
    }

    fn choose(&mut self, id: &str) -> Vec<Out> {
        if self.chosen.is_some() {
            return Vec::new();
        }
        self.chosen = Some(id.to_string());
        if !self.ended {
            return Vec::new();
        }
        vec![Out::Chosen {
            token: self.token.clone(),
            id: id.to_string(),
        }]
    }

    fn end(&mut self) -> Vec<Out> {
        if self.ended {
            return Vec::new();
        }
        self.ended = true;
        std::iter::once(Out::Ended {
            token: self.token.clone(),
        })
        .chain(self.chosen.iter().map(|id| Out::Chosen {
            token: self.token.clone(),
            id: id.clone(),
        }))
        .collect()
    }
}

const RETIRED: usize = 8;

#[derive(Debug)]
struct Joins {
    open: Vec<Join>,
    retired: Vec<String>,
}

impl Default for Joins {
    fn default() -> Self {
        Self::new()
    }
}

impl Joins {
    const fn new() -> Self {
        Self {
            open: Vec::new(),
            retired: Vec::new(),
        }
    }

    fn of(&mut self, token: &str) -> Option<&mut Join> {
        self.open.iter_mut().find(|join| join.token == token)
    }

    fn free(&self, token: &str) -> Result<()> {
        if self.open.iter().any(|join| join.token == token) {
            return Err(CommandError::new(
                "menu.token",
                cannot(SHOWN, &format!("its token {token:?} is already in use")),
            ));
        }
        Ok(())
    }

    fn open(&mut self, token: &str) -> Result<()> {
        self.free(token)?;
        self.open.push(Join::new(token.to_string()));
        Ok(())
    }

    fn ended(&self, token: &str) -> bool {
        self.open
            .iter()
            .any(|join| join.token == token && join.ended)
    }

    fn end(&mut self, token: &str) -> std::result::Result<Vec<Out>, String> {
        let late = self.retired.iter().any(|retired| retired == token);
        self.retired.retain(|retired| retired != token);
        let Some(join) = self.of(token) else {
            if late {
                return Ok(Vec::new());
            }
            return Err(format!(
                "webboard: the menu {token:?} ended, but no menu of that token is open; nothing is sent"
            ));
        };
        let outs = join.end();
        if !outs.is_empty() {
            self.open
                .retain(|join| !join.done() && (join.token == token || !join.ended));
        }
        Ok(outs)
    }

    fn retire(&mut self, token: &str) -> std::result::Result<Vec<Out>, String> {
        let outs = self.end(token)?;
        if !outs.is_empty() {
            self.retired.push(token.to_string());
            let over = self.retired.len().saturating_sub(RETIRED);
            self.retired.drain(..over);
        }
        Ok(outs)
    }

    fn choose(&mut self, token: &str, id: &str) -> std::result::Result<Vec<Out>, String> {
        let Some(join) = self.of(token) else {
            return Err(format!(
                "webboard: the row {id:?} of the menu {token:?} was chosen after the menu was withdrawn, replaced or finished; the choice is dropped"
            ));
        };
        let outs = join.choose(id);
        self.open.retain(|join| !join.done());
        Ok(outs)
    }
}

fn left_behind(e: &CommandError) -> bool {
    matches!(e.code.as_str(), "menu.not_shown" | "menu.stopped")
}

fn unwithdrawn(token: &str, e: &CommandError, w: &CommandError) -> String {
    format!(
        "webboard: the menu {token:?} was not shown ({}: {}) and could not be withdrawn: {}: {}",
        e.code, e.message, w.code, w.message
    )
}

async fn displayed(shown: Receiver<()>, wait: Duration) -> Result<()> {
    super::blocking("menu_show", "menu.stopped", move || {
        shown.recv_timeout(wait).map_err(|e| match e {
            RecvTimeoutError::Timeout => not_shown(&format!(
                "UIKit did not display it within {} ms",
                wait.as_millis()
            )),
            RecvTimeoutError::Disconnected => {
                not_shown("it was closed or replaced before UIKit displayed it")
            }
        })
    })
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Show;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dismiss;

impl Asked for Show {
    const CMD: &'static str = "menu_show";
    const STOPPED: &'static str = "menu.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "menu.off_main",
            cannot(SHOWN, "WebBoard tried to show it off the main thread"),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "menu.no_controller",
            cannot(SHOWN, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "menu.unreachable",
            cannot(SHOWN, &format!("the window could not be reached: {e}")),
        )
    }
}

impl Asked for Dismiss {
    const CMD: &'static str = "menu_dismiss";
    const STOPPED: &'static str = "menu.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "menu.off_main",
            cannot(
                DISMISSED,
                "WebBoard tried to dismiss it off the main thread",
            ),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "menu.no_controller",
            cannot(DISMISSED, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "menu.unreachable",
            cannot(DISMISSED, &format!("the window could not be reached: {e}")),
        )
    }
}

#[cfg(target_os = "ios")]
mod uikit {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSObject, NSString};
    use objc2_ui_kit::{
        UIAction, UIButton, UIContextMenuConfiguration, UIContextMenuInteraction,
        UIContextMenuInteractionAnimating, UIControl, UIMenu, UIMenuElement, UIMenuElementState,
        UIMenuOptions, UIResponder, UIView, UIViewController,
    };
    use tauri::{Emitter, EventTarget};
    use webboard_core::error::Result;

    use super::super::main_thread::report;
    use super::{
        busy, emit_fault, no_interaction, no_view, Anchor, Joins, MenuAsk, MenuRow, MenuSection,
        Out, GONE, IN_USE, NO_VIEW, NO_WEB_VIEW,
    };

    pub(super) struct Ivars {
        token: String,
        window: tauri::WebviewWindow,
    }

    define_class!(
        #[unsafe(super(UIButton, UIControl, UIView, UIResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WBMenuAnchor"]
        #[ivars = Ivars]
        pub(super) struct MenuAnchor;

        impl MenuAnchor {
            #[unsafe(method(contextMenuInteraction:willDisplayMenuForConfiguration:animator:))]
            fn will_display(
                &self,
                interaction: &UIContextMenuInteraction,
                configuration: &UIContextMenuConfiguration,
                animator: Option<&ProtocolObject<dyn UIContextMenuInteractionAnimating>>,
            ) {
                unsafe {
                    let _: () = msg_send![
                        super(self),
                        contextMenuInteraction: interaction,
                        willDisplayMenuForConfiguration: configuration,
                        animator: animator
                    ];
                }
                displayed(&self.ivars().token);
            }

            #[unsafe(method(contextMenuInteraction:willEndForConfiguration:animator:))]
            fn will_end(
                &self,
                interaction: &UIContextMenuInteraction,
                configuration: &UIContextMenuConfiguration,
                animator: Option<&ProtocolObject<dyn UIContextMenuInteractionAnimating>>,
            ) {
                unsafe {
                    let _: () = msg_send![
                        super(self),
                        contextMenuInteraction: interaction,
                        willEndForConfiguration: configuration,
                        animator: animator
                    ];
                }
                match animator {
                    Some(animator) => {
                        let anchor = self.retain();
                        let done = RcBlock::new(move || finish(&anchor));
                        animator.addCompletion(&done);
                    }
                    None => finish(self),
                }
            }
        }
    );

    impl MenuAnchor {
        fn new(main: MainThreadMarker, ivars: Ivars, frame: CGRect) -> Retained<Self> {
            let this = main.alloc::<Self>().set_ivars(ivars);
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
    }

    struct Live {
        anchor: Retained<MenuAnchor>,
        shown: Option<Sender<()>>,
    }

    impl Live {
        fn token(&self) -> &str {
            &self.anchor.ivars().token
        }
    }

    struct Store {
        live: Option<Live>,
        joins: Joins,
    }

    thread_local! {
        static STORE: RefCell<Store> = const {
            RefCell::new(Store {
                live: None,
                joins: Joins::new(),
            })
        };
    }

    fn with_store<T>(work: impl FnOnce(&mut Store) -> T) -> Result<T> {
        STORE
            .try_with(|store| {
                store
                    .try_borrow_mut()
                    .map(|mut store| work(&mut store))
                    .map_err(|_| busy(IN_USE))
            })
            .map_err(|_| busy(GONE))?
    }

    fn emit(window: &tauri::WebviewWindow, outs: Vec<Out>) {
        outs.iter().for_each(|out| {
            let (name, payload) = out.event();
            let sent = window.emit_to(EventTarget::webview_window(window.label()), name, payload);
            report(sent.err().map(|e| emit_fault(out, e)));
        });
    }

    fn joined(
        window: &tauri::WebviewWindow,
        outs: Result<std::result::Result<Vec<Out>, String>>,
        what: &str,
    ) {
        match outs {
            Ok(Ok(outs)) => emit(window, outs),
            Ok(Err(dropped)) => report(Some(dropped)),
            Err(e) => report(Some(format!(
                "webboard: {what} but could not be joined: {}: {}",
                e.code, e.message
            ))),
        }
    }

    fn displayed(token: &str) {
        let shown = with_store(|store| {
            store
                .live
                .as_mut()
                .filter(|live| live.token() == token)
                .map(|live| live.shown.take())
        });
        match shown {
            Ok(Some(Some(shown))) => {
                if shown.send(()).is_err() {
                    report(Some(format!(
                        "webboard: the menu {token:?} was displayed after menu_show stopped waiting; it is withdrawn"
                    )));
                    report(withdraw(token).err().map(|e| {
                        format!(
                            "webboard: the menu {token:?} could not be withdrawn: {}: {}",
                            e.code, e.message
                        )
                    }));
                }
            }
            Ok(Some(None)) => report(Some(format!(
                "webboard: the menu {token:?} was displayed a second time"
            ))),
            Ok(None) => report(Some(format!(
                "webboard: the menu {token:?} was displayed after it was replaced or withdrawn"
            ))),
            Err(e) => report(Some(format!(
                "webboard: the menu {token:?} was displayed but could not say so: {}: {}",
                e.code, e.message
            ))),
        }
    }

    fn finish(anchor: &MenuAnchor) {
        anchor.removeFromSuperview();
        let Ivars { token, window } = anchor.ivars();
        let outs = with_store(|store| {
            if store
                .live
                .as_ref()
                .is_some_and(|live| live.token() == token)
            {
                store.live = None;
            }
            store.joins.end(token)
        });
        if let Err(e) = &outs {
            report(Some(format!(
                "webboard: the menu {token:?} ended but could not join its choice, so only its end is sent: {}: {}",
                e.code, e.message
            )));
            emit(
                window,
                vec![Out::Ended {
                    token: token.clone(),
                }],
            );
            return;
        }
        joined(window, outs, &format!("the menu {token:?} ended"));
    }

    fn chosen(window: &tauri::WebviewWindow, token: &str, id: &str) {
        joined(
            window,
            with_store(|store| store.joins.choose(token, id)),
            &format!("the row {id:?} of the menu {token:?} was chosen"),
        );
    }

    fn action(
        main: MainThreadMarker,
        window: &tauri::WebviewWindow,
        token: &str,
        row: &MenuRow,
    ) -> Retained<UIMenuElement> {
        let (window, token, id) = (window.clone(), token.to_string(), row.id.clone());
        let handler = RcBlock::new(move |_: NonNull<UIAction>| chosen(&window, &token, &id));
        let action = unsafe {
            UIAction::actionWithTitle_image_identifier_handler(
                &NSString::from_str(&row.title),
                None,
                None,
                RcBlock::as_ptr(&handler),
                main,
            )
        };
        if row.checked {
            action.setState(UIMenuElementState::On);
        }
        Retained::into_super(action)
    }

    fn rows(
        main: MainThreadMarker,
        window: &tauri::WebviewWindow,
        token: &str,
        section: &MenuSection,
    ) -> Vec<Retained<UIMenuElement>> {
        section
            .rows
            .iter()
            .map(|row| action(main, window, token, row))
            .collect()
    }

    fn inline(
        main: MainThreadMarker,
        window: &tauri::WebviewWindow,
        token: &str,
        section: &MenuSection,
    ) -> Retained<UIMenuElement> {
        let children = rows(main, window, token, section);
        Retained::into_super(UIMenu::menuWithTitle_image_identifier_options_children(
            &NSString::from_str(section.title.as_deref().unwrap_or_default()),
            None,
            None,
            UIMenuOptions::DisplayInline,
            &NSArray::from_retained_slice(&children),
            main,
        ))
    }

    fn menu(
        main: MainThreadMarker,
        window: &tauri::WebviewWindow,
        token: &str,
        sections: &[MenuSection],
    ) -> Retained<UIMenu> {
        let children = match sections {
            [only] if only.title.is_none() => rows(main, window, token, only),
            _ => sections
                .iter()
                .map(|section| inline(main, window, token, section))
                .collect(),
        };
        UIMenu::menuWithChildren(&NSArray::from_retained_slice(&children), main)
    }

    fn rect(anchor: &Anchor) -> CGRect {
        CGRect::new(
            CGPoint::new(anchor.x, anchor.y),
            CGSize::new(anchor.width, anchor.height),
        )
    }

    fn retire(old: Live) {
        let Ivars { token, window } = old.anchor.ivars();
        match with_store(|store| store.joins.ended(token)) {
            Ok(true) => {}
            Ok(false) => match old.anchor.contextMenuInteraction() {
                Some(interaction) => interaction.dismissMenu(),
                None => report(Some(format!(
                    "webboard: the menu {token:?} was replaced or withdrawn, but {}",
                    no_interaction().message
                ))),
            },
            Err(e) => report(Some(format!(
                "webboard: the menu {token:?} was replaced or withdrawn without a dismissal: {}: {}",
                e.code, e.message
            ))),
        }
        old.anchor.removeFromSuperview();
        joined(
            window,
            with_store(|store| store.joins.retire(token)),
            &format!("the menu {token:?} was replaced or withdrawn"),
        );
    }

    pub(super) fn present(
        controller: &UIViewController,
        web: Option<&UIView>,
        ask: MenuAsk,
        window: tauri::WebviewWindow,
        shown: Sender<()>,
    ) -> Result<()> {
        let main = MainThreadMarker::from(controller);
        let Some(view) = controller.view() else {
            return Err(no_view(NO_VIEW));
        };
        let Some(web) = web else {
            return Err(no_view(NO_WEB_VIEW));
        };
        let MenuAsk {
            token,
            anchor,
            sections,
        } = ask;
        let old = with_store(|store| store.joins.free(&token).map(|()| store.live.take()))??;
        if let Some(old) = old {
            retire(old);
        }
        let frame = view.convertRect_fromView(rect(&anchor), Some(web));
        let menu = menu(main, &window, &token, &sections);
        let button = MenuAnchor::new(
            main,
            Ivars {
                token: token.clone(),
                window,
            },
            frame,
        );
        button.setHidden(true);
        button.setMenu(Some(&menu));
        button.setShowsMenuAsPrimaryAction(true);
        view.addSubview(&button);
        let kept = with_store(|store| {
            store.joins.open(&token).map(|()| {
                store.live = Some(Live {
                    anchor: button.clone(),
                    shown: Some(shown),
                })
            })
        })
        .and_then(|opened| opened);
        if let Err(e) = kept {
            button.removeFromSuperview();
            return Err(e);
        }
        button.performPrimaryAction();
        Ok(())
    }

    pub(super) fn withdraw(token: &str) -> Result<()> {
        let old = with_store(|store| {
            if store
                .live
                .as_ref()
                .is_some_and(|live| live.token() == token)
            {
                store.live.take()
            } else {
                None
            }
        })?;
        if let Some(old) = old {
            retire(old);
        }
        Ok(())
    }

    pub(super) fn dismiss(token: &str) -> Result<()> {
        let anchor = with_store(|store| {
            store
                .live
                .as_ref()
                .filter(|live| live.token() == token && !store.joins.ended(token))
                .map(|live| live.anchor.clone())
        })?;
        let Some(anchor) = anchor else {
            return Ok(());
        };
        let Some(interaction) = anchor.contextMenuInteraction() else {
            return Err(no_interaction());
        };
        interaction.dismissMenu();
        Ok(())
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn menu_show(window: tauri::WebviewWindow, menu: MenuAsk) -> Result<()> {
    validate(&menu)?;
    let token = menu.token.clone();
    let (shown, display) = std::sync::mpsc::channel();
    let owner = window.clone();
    let shown = match super::main_thread::run_with_view(&window, Show, move |controller, web| {
        uikit::present(controller, web, menu, owner, shown)
    })
    .await
    {
        Ok(()) => displayed(display, super::main_thread::MAIN_THREAD_WAIT).await,
        Err(e) => Err(e),
    };
    let Err(e) = shown else {
        return Ok(());
    };
    if !left_behind(&e) {
        return Err(e);
    }
    let named = token.clone();
    let withdrawn = super::main_thread::run(&window, Show, move |_| uikit::withdraw(&named)).await;
    super::main_thread::report(withdrawn.err().map(|w| unwithdrawn(&token, &e, &w)));
    Err(e)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn menu_dismiss(window: tauri::WebviewWindow, token: String) -> Result<()> {
    dismissable(&token)?;
    super::main_thread::run(&window, Dismiss, move |_| uikit::dismiss(&token)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::main_thread::dropped;
    use serde_json::json;
    use std::sync::mpsc;

    fn ask(value: serde_json::Value) -> MenuAsk {
        serde_json::from_value(value).expect("a well-formed menu")
    }

    fn row(id: &str, title: &str) -> serde_json::Value {
        json!({ "id": id, "title": title, "checked": false })
    }

    fn with_sections(sections: serde_json::Value) -> serde_json::Value {
        json!({
            "token": "m1",
            "anchor": { "x": 10.0, "y": 20.0, "width": 44.0, "height": 30.0 },
            "sections": sections
        })
    }

    fn with_anchor(anchor: serde_json::Value) -> MenuAsk {
        let mut value = with_sections(json!([{ "title": null, "rows": [row("a", "A")] }]));
        value["anchor"] = anchor;
        ask(value)
    }

    fn refused(menu: MenuAsk) -> CommandError {
        validate(&menu).expect_err("the menu is refused")
    }

    #[test]
    fn a_menu_of_the_more_button_is_valid() {
        let menu = ask(with_sections(json!([
            { "title": "Zoom", "rows": [
                { "id": "zoom-W", "title": "Week", "checked": true },
                row("zoom-M", "Month")
            ] },
            { "title": null, "rows": [row("today", "Go to today"), row("settings", "Settings")] }
        ])));
        assert_eq!(validate(&menu), Ok(()));
        assert!(menu.sections[0].rows[0].checked);
        assert_eq!(
            menu.anchor,
            Anchor {
                x: 10.0,
                y: 20.0,
                width: 44.0,
                height: 30.0
            }
        );
    }

    #[test]
    fn a_zero_sized_anchor_is_valid() {
        let menu = with_anchor(json!({ "x": -5.0, "y": 0.0, "width": 0.0, "height": 0.0 }));
        assert_eq!(validate(&menu), Ok(()));
    }

    #[test]
    fn an_empty_token_is_refused() {
        let mut menu = ask(with_sections(
            json!([{ "title": null, "rows": [row("a", "A")] }]),
        ));
        menu.token = String::new();
        assert_eq!(
            refused(menu),
            CommandError::new(
                "menu.token",
                "The menu cannot be shown: its token is empty."
            )
        );
        assert_eq!(
            dismissable(""),
            Err(CommandError::new(
                "menu.token",
                "The menu cannot be dismissed: its token is empty."
            ))
        );
        assert_eq!(dismissable("m1"), Ok(()));
    }

    #[test]
    fn an_anchor_that_is_not_finite_or_has_a_negative_size_is_refused() {
        let cases: [(Anchor, &str); 6] = [
            (
                Anchor {
                    x: f64::NAN,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                "its anchor's x is NaN, not a finite number",
            ),
            (
                Anchor {
                    x: 0.0,
                    y: f64::INFINITY,
                    width: 1.0,
                    height: 1.0,
                },
                "its anchor's y is inf, not a finite number",
            ),
            (
                Anchor {
                    x: 0.0,
                    y: 0.0,
                    width: f64::NEG_INFINITY,
                    height: 1.0,
                },
                "its anchor's width is -inf, not a finite number",
            ),
            (
                Anchor {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: f64::NAN,
                },
                "its anchor's height is NaN, not a finite number",
            ),
            (
                Anchor {
                    x: 0.0,
                    y: 0.0,
                    width: -1.0,
                    height: 1.0,
                },
                "its anchor's width is -1, which is negative",
            ),
            (
                Anchor {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: -0.5,
                },
                "its anchor's height is -0.5, which is negative",
            ),
        ];
        cases.iter().for_each(|(anchor, why)| {
            let mut menu = with_anchor(json!({ "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 }));
            menu.anchor = *anchor;
            assert_eq!(
                refused(menu),
                CommandError::new("menu.anchor", format!("The menu cannot be shown: {why}.")),
                "{anchor:?}"
            );
        });
    }

    #[test]
    fn rows_that_cannot_be_shown_are_refused() {
        let cases = [
            (json!([]), "it has no section"),
            (
                json!([{ "title": "Zoom", "rows": [] }]),
                "section 1 has no row",
            ),
            (
                json!([{ "title": null, "rows": [row("a", "A")] }, { "title": null, "rows": [] }]),
                "section 2 has no row",
            ),
            (
                json!([{ "title": null, "rows": [row(" ", "A")] }]),
                "the row \"A\" has an empty id",
            ),
            (
                json!([{ "title": null, "rows": [row("a", "")] }]),
                "the row with id \"a\" has an empty title",
            ),
            (
                json!([{ "title": null, "rows": [row("a", " \t")] }]),
                "the row with id \"a\" has an empty title",
            ),
            (
                json!([{ "title": "  ", "rows": [row("a", "A")] }]),
                "section 1 has an empty title",
            ),
            (
                json!([{ "title": "", "rows": [row("a", "A")] }]),
                "section 1 has an empty title",
            ),
            (
                json!([{ "title": "Zoom", "rows": [row("a", "A")] }, { "title": null, "rows": [row("b", "B"), row("a", "C")] }]),
                "the id \"a\" is used twice",
            ),
        ];
        cases.into_iter().for_each(|(sections, why)| {
            assert_eq!(
                refused(ask(with_sections(sections.clone()))),
                CommandError::new("menu.rows", format!("The menu cannot be shown: {why}.")),
                "{sections}"
            );
        });
    }

    #[test]
    fn an_unknown_or_missing_field_is_refused_at_every_level() {
        let good = with_sections(json!([{ "title": null, "rows": [row("a", "A")] }]));
        assert!(serde_json::from_value::<MenuAsk>(good.clone()).is_ok());
        let mut extra = good.clone();
        extra["extra"] = json!(1);
        let mut anchor = good.clone();
        anchor["anchor"]["z"] = json!(0.0);
        let mut section = good.clone();
        section["sections"][0]["options"] = json!("inline");
        let mut row_extra = good.clone();
        row_extra["sections"][0]["rows"][0]["image"] = json!("star");
        let mut no_checked = good.clone();
        no_checked["sections"][0]["rows"][0] = json!({ "id": "a", "title": "A" });
        let mut no_title = good;
        no_title["sections"][0] = json!({ "rows": [row("a", "A")] });
        [extra, anchor, section, row_extra, no_checked, no_title]
            .iter()
            .for_each(|bad| {
                assert!(
                    serde_json::from_value::<MenuAsk>(bad.clone()).is_err(),
                    "{bad} was accepted"
                )
            });
    }

    fn ended(token: &str) -> Out {
        Out::Ended {
            token: token.to_string(),
        }
    }

    fn chosen(token: &str, id: &str) -> Out {
        Out::Chosen {
            token: token.to_string(),
            id: id.to_string(),
        }
    }

    fn opened(tokens: &[&str]) -> Joins {
        let mut joins = Joins::default();
        tokens
            .iter()
            .for_each(|token| joins.open(token).expect("a fresh token"));
        joins
    }

    #[test]
    fn a_choice_before_the_end_is_sent_right_after_the_end() {
        let mut joins = opened(&["m1"]);
        assert_eq!(joins.choose("m1", "settings"), Ok(vec![]));
        assert_eq!(
            joins.end("m1"),
            Ok(vec![ended("m1"), chosen("m1", "settings")])
        );
    }

    #[test]
    fn a_choice_after_the_end_is_sent_at_once() {
        let mut joins = opened(&["m1"]);
        assert_eq!(joins.end("m1"), Ok(vec![ended("m1")]));
        assert!(joins.ended("m1"));
        assert_eq!(joins.choose("m1", "plan"), Ok(vec![chosen("m1", "plan")]));
    }

    #[test]
    fn a_second_end_sends_nothing() {
        let mut joins = opened(&["m1"]);
        assert_eq!(joins.end("m1"), Ok(vec![ended("m1")]));
        assert_eq!(joins.end("m1"), Ok(vec![]));
    }

    #[test]
    fn a_second_choice_is_ignored_before_and_after_the_end() {
        let mut joins = opened(&["m1", "m2"]);
        assert_eq!(joins.choose("m1", "a"), Ok(vec![]));
        assert_eq!(joins.choose("m1", "b"), Ok(vec![]));
        assert_eq!(joins.end("m1"), Ok(vec![ended("m1"), chosen("m1", "a")]));
        assert!(joins.choose("m1", "c").is_err());
        assert_eq!(joins.end("m2"), Ok(vec![ended("m2")]));
        assert_eq!(joins.choose("m2", "a"), Ok(vec![chosen("m2", "a")]));
        assert!(joins.choose("m2", "b").is_err());
    }

    #[test]
    fn a_replaced_menu_keeps_its_choice_when_the_choice_comes_first() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.choose("A", "settings"), Ok(vec![]));
        joins.open("B").expect("a fresh token");
        assert_eq!(
            joins.end("A"),
            Ok(vec![ended("A"), chosen("A", "settings")])
        );
        assert!(!joins.ended("B"));
        assert_eq!(joins.choose("B", "plan"), Ok(vec![]));
        assert_eq!(joins.end("B"), Ok(vec![ended("B"), chosen("B", "plan")]));
    }

    #[test]
    fn a_replaced_menu_keeps_its_choice_when_the_end_comes_first() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.end("A"), Ok(vec![ended("A")]));
        joins.open("B").expect("a fresh token");
        assert_eq!(
            joins.choose("A", "settings"),
            Ok(vec![chosen("A", "settings")])
        );
        assert!(!joins.ended("B"));
    }

    #[test]
    fn a_token_already_in_use_is_refused() {
        let mut joins = opened(&["m1"]);
        assert_eq!(
            joins.open("m1"),
            Err(CommandError::new(
                "menu.token",
                "The menu cannot be shown: its token \"m1\" is already in use."
            ))
        );
    }

    #[test]
    fn an_ended_menu_is_forgotten_once_a_later_menu_ends() {
        let mut joins = opened(&["A", "B"]);
        assert_eq!(joins.end("A"), Ok(vec![ended("A")]));
        assert_eq!(joins.end("B"), Ok(vec![ended("B")]));
        assert_eq!(
            joins.choose("A", "settings"),
            Err("webboard: the row \"settings\" of the menu \"A\" was chosen after the menu was withdrawn, replaced or finished; the choice is dropped".to_string())
        );
        assert_eq!(joins.choose("B", "plan"), Ok(vec![chosen("B", "plan")]));
    }

    #[test]
    fn an_unknown_menu_neither_ends_nor_chooses_and_says_so() {
        let mut joins = Joins::default();
        assert_eq!(
            joins.end("m1"),
            Err("webboard: the menu \"m1\" ended, but no menu of that token is open; nothing is sent".to_string())
        );
        assert!(joins.choose("m1", "a").is_err());
        assert!(!joins.ended("m1"));
    }

    #[test]
    fn a_retired_menu_finishes_quietly_once() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.choose("A", "settings"), Ok(vec![]));
        assert_eq!(
            joins.retire("A"),
            Ok(vec![ended("A"), chosen("A", "settings")])
        );
        assert_eq!(joins.end("A"), Ok(vec![]));
        assert!(joins.end("A").is_err());
    }

    #[test]
    fn a_retired_menu_that_is_forgotten_still_finishes_quietly() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.retire("A"), Ok(vec![ended("A")]));
        joins.open("B").expect("a fresh token");
        assert_eq!(joins.end("B"), Ok(vec![ended("B")]));
        assert_eq!(joins.end("A"), Ok(vec![]));
        assert!(joins.end("A").is_err());
    }

    #[test]
    fn an_unknown_menu_that_finishes_is_still_reported() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.retire("A"), Ok(vec![ended("A")]));
        assert_eq!(
            joins.end("Z"),
            Err("webboard: the menu \"Z\" ended, but no menu of that token is open; nothing is sent".to_string())
        );
    }

    #[test]
    fn a_retired_menu_that_had_already_ended_is_not_remembered() {
        let mut joins = opened(&["A"]);
        assert_eq!(joins.end("A"), Ok(vec![ended("A")]));
        assert_eq!(joins.retire("A"), Ok(vec![]));
        joins.open("B").expect("a fresh token");
        assert_eq!(joins.end("B"), Ok(vec![ended("B")]));
        assert!(joins.end("A").is_err());
    }

    #[test]
    fn the_retired_menus_are_bounded() {
        let tokens: Vec<String> = (0..=RETIRED).map(|n| format!("m{n}")).collect();
        let mut joins = Joins::default();
        tokens.iter().for_each(|token| {
            joins.open(token).expect("a fresh token");
            assert_eq!(joins.retire(token), Ok(vec![ended(token)]));
        });
        joins.open("last").expect("a fresh token");
        assert_eq!(joins.end("last"), Ok(vec![ended("last")]));
        assert!(joins.end(&tokens[0]).is_err());
        tokens[1..]
            .iter()
            .for_each(|token| assert_eq!(joins.end(token), Ok(vec![])));
    }

    #[test]
    fn a_free_token_is_checked_without_opening_it() {
        let mut joins = opened(&["m1"]);
        assert_eq!(
            joins.free("m1"),
            Err(CommandError::new(
                "menu.token",
                "The menu cannot be shown: its token \"m1\" is already in use."
            ))
        );
        assert_eq!(joins.free("m2"), Ok(()));
        assert!(joins.end("m2").is_err());
        assert!(joins.choose("m2", "a").is_err());
    }

    #[test]
    fn a_menu_that_was_not_shown_is_withdrawn() {
        assert!(left_behind(&not_shown("x")));
        assert!(left_behind(&dropped::<Show>()));
        assert!(!left_behind(&busy(IN_USE)));
        assert!(!left_behind(&no_view(NO_VIEW)));
        assert!(!left_behind(&Show.off_main()));
        assert_eq!(
            unwithdrawn(
                "m1",
                &not_shown("UIKit did not display it within 5000 ms"),
                &busy(IN_USE)
            ),
            "webboard: the menu \"m1\" was not shown (menu.not_shown: The menu cannot be shown: UIKit did not display it within 5000 ms.) and could not be withdrawn: menu.busy: The menu cannot be shown or dismissed: the main thread's menu store is already in use."
        );
    }

    #[test]
    fn the_events_carry_the_documented_payloads() {
        assert_eq!(
            Out::Ended {
                token: "m1".to_string()
            }
            .event(),
            ("menu-ended", json!({ "token": "m1" }))
        );
        assert_eq!(
            Out::Chosen {
                token: "m1".to_string(),
                id: "zoom-W".to_string()
            }
            .event(),
            ("menu-chosen", json!({ "token": "m1", "id": "zoom-W" }))
        );
        assert_eq!(
            emit_fault(
                &Out::Ended {
                    token: "m1".to_string()
                },
                "the window is gone"
            ),
            "webboard: could not emit menu-ended {\"token\":\"m1\"}: the window is gone"
        );
    }

    #[test]
    fn every_failure_has_its_own_code() {
        let errors = [
            Show.off_main(),
            Dismiss.off_main(),
            Show.no_controller(),
            Dismiss.unreachable("the event loop is gone"),
            dropped::<Show>(),
            dropped::<Dismiss>(),
            no_view(NO_WEB_VIEW),
            no_view(NO_VIEW),
            busy(IN_USE),
            busy(GONE),
            not_shown("x"),
            no_interaction(),
        ];
        assert_eq!(
            errors.clone().map(|e| e.code),
            [
                "menu.off_main",
                "menu.off_main",
                "menu.no_controller",
                "menu.unreachable",
                "menu.stopped",
                "menu.stopped",
                "menu.no_view",
                "menu.no_view",
                "menu.busy",
                "menu.busy",
                "menu.not_shown",
                "menu.no_interaction",
            ]
        );
        assert_eq!(
            errors.map(|e| e.message),
            [
                "The menu cannot be shown: WebBoard tried to show it off the main thread.",
                "The menu cannot be dismissed: WebBoard tried to dismiss it off the main thread.",
                "The menu cannot be shown: the window has no view controller.",
                "The menu cannot be dismissed: the window could not be reached: the event loop is gone.",
                "menu_show stopped: the main thread dropped it without a result",
                "menu_dismiss stopped: the main thread dropped it without a result",
                "The menu cannot be shown: the window has no web view.",
                "The menu cannot be shown: the view controller has no view.",
                "The menu cannot be shown or dismissed: the main thread's menu store is already in use.",
                "The menu cannot be shown or dismissed: the main thread's menu store is gone.",
                "The menu cannot be shown: x.",
                "The menu cannot be dismissed: its button has no menu interaction.",
            ]
        );
    }

    #[test]
    fn the_show_waits_for_uikit_to_display_the_menu() {
        let (sender, shown) = mpsc::channel();
        sender.send(()).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(displayed(shown, Duration::from_secs(5))),
            Ok(())
        );
    }

    #[test]
    fn a_menu_uikit_never_displays_is_not_shown() {
        let (_sender, shown) = mpsc::channel::<()>();
        assert_eq!(
            tauri::async_runtime::block_on(displayed(shown, Duration::from_millis(20))),
            Err(CommandError::new(
                "menu.not_shown",
                "The menu cannot be shown: UIKit did not display it within 20 ms."
            ))
        );
        let (sender, shown) = mpsc::channel::<()>();
        drop(sender);
        assert_eq!(
            tauri::async_runtime::block_on(displayed(shown, Duration::from_secs(5))),
            Err(CommandError::new(
                "menu.not_shown",
                "The menu cannot be shown: it was closed or replaced before UIKit displayed it."
            ))
        );
    }
}

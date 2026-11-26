use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use webboard_core::error::Result;
use webboard_core::CommandError;

use super::main_thread::Asked;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub image: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarState {
    pub selected: String,
    pub hidden: bool,
    pub tint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarAsk {
    pub tabs: Vec<Tab>,
    pub state: BarState,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Geometry {
    pub height: f64,
}

const INSTALLED: &str = "installed";
const SET: &str = "set";
const LAID_OUT: &str = "laid out";
const FEWEST: usize = 2;
const MOST: usize = 5;

const NO_VIEW: &str = "the view controller has no view";
const NOT_SHOWN: &str = "its view is in no window";
const NO_HOST_VIEW: &str = "the tab bar controller has no view";
const NO_CARRIER_VIEW: &str = "a tab's view controller has no view";
const OUT_OF_HOST: &str = "the tab bar's views are not on top of the web view";

fn cannot(verb: &str, why: &str) -> String {
    format!("The tab bar cannot be {verb}: {why}.")
}

fn bad_tabs(why: &str) -> CommandError {
    CommandError::new("tabbar.tabs", cannot(INSTALLED, why))
}

fn bad_selected(verb: &str, selected: &str) -> CommandError {
    CommandError::new(
        "tabbar.selected",
        cannot(
            verb,
            &format!("the selected tab {selected:?} is not one of its tabs"),
        ),
    )
}

fn bad_tint(verb: &str, tint: &str) -> CommandError {
    CommandError::new(
        "tabbar.tint",
        cannot(
            verb,
            &format!("the tint {tint:?} is not # and six hex digits"),
        ),
    )
}

fn not_phone() -> CommandError {
    CommandError::new(
        "tabbar.not_phone",
        cannot(INSTALLED, "the device is not an iPhone"),
    )
}

fn no_window(verb: &str, why: &str) -> CommandError {
    CommandError::new("tabbar.no_window", cannot(verb, why))
}

fn not_root() -> CommandError {
    CommandError::new(
        "tabbar.not_root",
        cannot(
            INSTALLED,
            "the window's root is not the web view's controller",
        ),
    )
}

fn no_image(name: &str) -> CommandError {
    CommandError::new(
        "tabbar.no_image",
        format!("The system image {name} does not exist."),
    )
}

fn no_height(height: f64) -> CommandError {
    CommandError::new(
        "tabbar.no_height",
        cannot(
            INSTALLED,
            &format!("the bar's height is {height} after layout, so everything was undone"),
        ),
    )
}

fn kept_flat(height: f64) -> CommandError {
    CommandError::new(
        "tabbar.no_height",
        format!(
            "The tab bar cannot be installed again: the bar that is already installed is {height} high after layout, and it stays installed."
        ),
    )
}

fn flat_shown(height: f64) -> CommandError {
    CommandError::new(
        "tabbar.no_height",
        cannot(
            LAID_OUT,
            &format!("its height is {height} while it is shown"),
        ),
    )
}

fn out_of_host(verb: &str) -> CommandError {
    let why = if verb == INSTALLED {
        format!("{OUT_OF_HOST}, so everything was undone")
    } else {
        OUT_OF_HOST.to_string()
    };
    CommandError::new("tabbar.order", cannot(verb, &why))
}

fn not_installed() -> CommandError {
    CommandError::new(
        "tabbar.not_installed",
        cannot(SET, "it is not installed yet"),
    )
}

fn mismatch() -> CommandError {
    CommandError::new(
        "tabbar.mismatch",
        cannot(INSTALLED, "it is already installed with other tabs"),
    )
}

fn gone(verb: &str) -> CommandError {
    CommandError::new(
        "tabbar.stopped",
        cannot(verb, "the main thread's tab bar store is gone"),
    )
}

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn tab_fault(n: usize, tab: &Tab) -> Option<String> {
    if blank(&tab.id) {
        Some(format!("tab {n} has an empty id"))
    } else if blank(&tab.title) {
        Some(format!("the tab {:?} has an empty title", tab.id))
    } else if blank(&tab.image) {
        Some(format!("the tab {:?} has an empty image", tab.id))
    } else {
        None
    }
}

fn tabs_fault(tabs: &[Tab]) -> Option<String> {
    let count = tabs.len();
    if !(FEWEST..=MOST).contains(&count) {
        let noun = if count == 1 { "tab" } else { "tabs" };
        return Some(format!("it has {count} {noun}, not {FEWEST} to {MOST}"));
    }
    if let Some(fault) = tabs
        .iter()
        .enumerate()
        .find_map(|(i, tab)| tab_fault(i + 1, tab))
    {
        return Some(fault);
    }
    let mut seen = HashSet::new();
    tabs.iter()
        .find(|tab| !seen.insert(tab.id.as_str()))
        .map(|tab| format!("the id {:?} is used twice", tab.id))
}

fn tint(text: &str) -> Option<[f64; 3]> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| {
        u8::from_str_radix(&hex[at..at + 2], 16)
            .ok()
            .map(|value| f64::from(value) / 255.0)
    };
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn rgb(verb: &str, text: &str) -> Result<[f64; 3]> {
    tint(text).ok_or_else(|| bad_tint(verb, text))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Applied {
    index: usize,
    hidden: bool,
    rgb: [f64; 3],
}

impl Applied {
    fn shown(self) -> Self {
        Self {
            hidden: false,
            ..self
        }
    }
}

fn applied(tabs: &[Tab], state: &BarState, verb: &str) -> Result<Applied> {
    let index = tabs
        .iter()
        .position(|tab| tab.id == state.selected)
        .ok_or_else(|| bad_selected(verb, &state.selected))?;
    Ok(Applied {
        index,
        hidden: state.hidden,
        rgb: rgb(verb, &state.tint)?,
    })
}

fn validate(ask: &BarAsk) -> Result<()> {
    if let Some(fault) = tabs_fault(&ask.tabs) {
        return Err(bad_tabs(&fault));
    }
    applied(&ask.tabs, &ask.state, INSTALLED).map(|_| ())
}

fn settable(state: &BarState) -> Result<()> {
    rgb(SET, &state.tint).map(|_| ())
}

fn installed_height(height: f64) -> Result<f64> {
    if height > 0.0 {
        Ok(height)
    } else {
        Err(no_height(height))
    }
}

fn reinstalled_height(height: Option<f64>) -> Result<f64> {
    match height {
        None => Err(no_window(INSTALLED, NO_HOST_VIEW)),
        Some(height) if height > 0.0 => Ok(height),
        Some(height) => Err(kept_flat(height)),
    }
}

const HALF_POINT: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Measure {
    Quiet,
    Send(f64),
    Flat(f64),
}

fn measure(hidden: bool, sent: f64, now: f64) -> Measure {
    if hidden {
        Measure::Quiet
    } else if now <= 0.0 {
        if sent > 0.0 {
            Measure::Flat(now)
        } else {
            Measure::Quiet
        }
    } else if (now - sent).abs() >= HALF_POINT {
        Measure::Send(now)
    } else {
        Measure::Quiet
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    Kept,
    Raise,
    Lost,
}

fn order_of(count: usize, veil: Option<usize>, held: bool) -> Order {
    match (veil, held) {
        (Some(veil), true) if veil + 1 == count => Order::Kept,
        (Some(_), true) => Order::Raise,
        _ => Order::Lost,
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Out {
    Picked { id: String, again: bool },
    Moved(Geometry),
    Fault(CommandError),
}

impl Out {
    fn event(&self) -> (&'static str, serde_json::Value) {
        match self {
            Out::Picked { id, again } => (
                "tabbar-picked",
                serde_json::json!({ "id": id, "again": again }),
            ),
            Out::Moved(geometry) => (
                "tabbar-geometry",
                serde_json::json!({ "height": geometry.height }),
            ),
            Out::Fault(e) => (
                "tabbar-fault",
                serde_json::json!({ "code": e.code, "message": e.message }),
            ),
        }
    }
}

fn emit_fault(out: &Out, e: impl std::fmt::Display) -> String {
    let (name, payload) = out.event();
    format!("webboard: could not emit {name} {payload}: {e}")
}

fn picked(tabs: &[Tab], index: Option<usize>, selected: usize) -> std::result::Result<Out, String> {
    index
        .and_then(|at| tabs.get(at).map(|tab| (at, tab)))
        .map(|(at, tab)| Out::Picked {
            id: tab.id.clone(),
            again: at == selected,
        })
        .ok_or_else(|| {
            "webboard: the tab bar asked to select a view controller that is not one of its tabs; nothing is sent and the selection stays".to_string()
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Install;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Set;

impl Asked for Install {
    const CMD: &'static str = "tabbar_install";
    const STOPPED: &'static str = "tabbar.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "tabbar.off_main",
            cannot(
                INSTALLED,
                "WebBoard tried to install it off the main thread",
            ),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "tabbar.no_controller",
            cannot(INSTALLED, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "tabbar.unreachable",
            cannot(INSTALLED, &format!("the window could not be reached: {e}")),
        )
    }

    fn stopped(why: &str) -> CommandError {
        CommandError::new(Self::STOPPED, cannot(INSTALLED, why))
    }
}

impl Asked for Set {
    const CMD: &'static str = "tabbar_set";
    const STOPPED: &'static str = "tabbar.stopped";

    fn off_main(self) -> CommandError {
        CommandError::new(
            "tabbar.off_main",
            cannot(SET, "WebBoard tried to set it off the main thread"),
        )
    }

    fn no_controller(self) -> CommandError {
        CommandError::new(
            "tabbar.no_controller",
            cannot(SET, "the window has no view controller"),
        )
    }

    fn unreachable(self, e: &str) -> CommandError {
        CommandError::new(
            "tabbar.unreachable",
            cannot(SET, &format!("the window could not be reached: {e}")),
        )
    }

    fn stopped(why: &str) -> CommandError {
        CommandError::new(Self::STOPPED, cannot(SET, why))
    }
}

#[cfg(target_os = "ios")]
mod uikit {
    use std::cell::{Cell, OnceCell};

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{
        define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_core_foundation::{CGPoint, CGRect};
    use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
    use objc2_ui_kit::{
        UIColor, UIDevice, UIEvent, UIImage, UIResponder, UITabBar, UITabBarController,
        UITabBarControllerDelegate, UITabBarItem, UIUserInterfaceIdiom, UIView, UIViewAutoresizing,
        UIViewController, UIWindow,
    };
    use tauri::{Emitter, EventTarget};
    use webboard_core::error::Result;
    use webboard_core::CommandError;

    use super::super::main_thread::report;
    use super::{
        applied, emit_fault, flat_shown, gone, installed_height, measure, mismatch, no_image,
        no_window, not_installed, not_phone, not_root, order_of, out_of_host, picked,
        reinstalled_height, Applied, BarAsk, BarState, Geometry, Measure, Order, Out, Tab,
        INSTALLED, LAID_OUT, NOT_SHOWN, NO_CARRIER_VIEW, NO_HOST_VIEW, NO_VIEW, SET,
    };

    pub(super) struct Ivars {
        window: tauri::WebviewWindow,
        tabs: Vec<Tab>,
        content: Retained<UIView>,
        veil: Retained<TabVeil>,
        sent: Cell<f64>,
        live: Cell<bool>,
        faulted: Cell<bool>,
    }

    define_class!(
        #[unsafe(super(UIView, UIResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WBTabVeil"]
        pub(super) struct TabVeil;

        impl TabVeil {
            #[unsafe(method_id(hitTest:withEvent:))]
            fn hit_test(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
                let hit: Option<Retained<UIView>> =
                    unsafe { msg_send![super(self), hitTest: point, withEvent: event] };
                hit.filter(|view| {
                    std::iter::successors(Some(view.clone()), |v| v.superview())
                        .any(|v| v.isKindOfClass(UITabBar::class()))
                })
            }
        }

        unsafe impl NSObjectProtocol for TabVeil {}
    );

    impl TabVeil {
        fn new(main: MainThreadMarker, frame: CGRect) -> Retained<Self> {
            let this = main.alloc::<Self>().set_ivars(());
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
    }

    define_class!(
        #[unsafe(super(UITabBarController, UIViewController, UIResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WBTabHost"]
        #[ivars = Ivars]
        pub(super) struct TabHost;

        impl TabHost {
            #[unsafe(method(viewDidLayoutSubviews))]
            fn view_did_layout_subviews(&self) {
                unsafe {
                    let _: () = msg_send![super(self), viewDidLayoutSubviews];
                }
                self.arrange();
            }
        }

        unsafe impl NSObjectProtocol for TabHost {}

        unsafe impl UITabBarControllerDelegate for TabHost {
            #[unsafe(method(tabBarController:shouldSelectViewController:))]
            fn should_select(
                &self,
                _controller: &UITabBarController,
                carrier: &UIViewController,
            ) -> bool {
                self.pick(carrier)
            }
        }
    );

    fn same<T>(a: &T, b: &T) -> bool {
        std::ptr::eq(a, b)
    }

    impl TabHost {
        fn new(main: MainThreadMarker, ivars: Ivars) -> Retained<Self> {
            let this = main.alloc::<Self>().set_ivars(ivars);
            unsafe { msg_send![super(this), init] }
        }

        fn send(&self, out: Out) -> bool {
            let window = &self.ivars().window;
            let (name, payload) = out.event();
            match window.emit_to(EventTarget::webview_window(window.label()), name, payload) {
                Ok(()) => true,
                Err(e) => {
                    report(Some(emit_fault(&out, e)));
                    false
                }
            }
        }

        fn fault(&self, e: CommandError) {
            let ivars = self.ivars();
            if !ivars.faulted.get() && self.send(Out::Fault(e)) {
                ivars.faulted.set(true);
            }
        }

        fn pick(&self, carrier: &UIViewController) -> bool {
            let index = self.viewControllers().and_then(|carriers| {
                carriers
                    .to_vec()
                    .iter()
                    .position(|known| same::<UIViewController>(known, carrier))
            });
            match picked(&self.ivars().tabs, index, self.selectedIndex()) {
                Ok(out) => self.send(out),
                Err(fault) => {
                    report(Some(fault));
                    false
                }
            }
        }

        fn order(&self, view: &UIView) -> Order {
            let Ivars { content, veil, .. } = self.ivars();
            let veil: &UIView = veil;
            let subviews = content.subviews().to_vec();
            let at = subviews
                .iter()
                .position(|known| same::<UIView>(known, veil));
            let held = view
                .superview()
                .is_some_and(|parent| same::<UIView>(&parent, veil));
            let order = order_of(subviews.len(), at, held);
            if order == Order::Raise {
                content.bringSubviewToFront(veil);
            }
            order
        }

        fn arrange(&self) {
            let ivars = self.ivars();
            let Some(view) = self.view() else {
                if ivars.live.get() {
                    self.fault(no_window(LAID_OUT, NO_HOST_VIEW));
                }
                return;
            };
            let order = self.order(&view);
            if !ivars.live.get() {
                return;
            }
            if order == Order::Lost {
                self.fault(out_of_host(LAID_OUT));
            }
            let sent = ivars.sent.get();
            match measure(
                self.isTabBarHidden(),
                sent,
                self.tabBar().frame().size.height,
            ) {
                Measure::Quiet => {}
                Measure::Send(height) => {
                    if self.send(Out::Moved(Geometry { height })) {
                        ivars.sent.set(height);
                    }
                }
                Measure::Flat(height) => {
                    ivars.sent.set(height);
                    self.fault(flat_shown(height));
                }
            }
        }

        fn apply(&self, applied: &Applied) {
            if self.selectedIndex() != applied.index {
                self.setSelectedIndex(applied.index);
            }
            if self.isTabBarHidden() != applied.hidden {
                self.setTabBarHidden(applied.hidden);
            }
            let [red, green, blue] = applied.rgb;
            let color = UIColor::colorWithRed_green_blue_alpha(red, green, blue, 1.0);
            unsafe { self.tabBar().setTintColor(Some(&color)) };
        }

        fn laid_out(&self) -> Option<(Retained<UIView>, f64)> {
            let view = self.view()?;
            view.layoutIfNeeded();
            let height = self.tabBar().frame().size.height;
            Some((view, height))
        }

        fn again(&self, tabs: &[Tab], applied: &Applied) -> Result<f64> {
            if self.ivars().tabs != tabs {
                return Err(mismatch());
            }
            self.ivars().faulted.set(false);
            self.apply(&applied.shown());
            let height = self.laid_out().map(|(_, height)| height);
            self.apply(applied);
            reinstalled_height(height)
        }
    }

    thread_local! {
        static HOST: OnceCell<Retained<TabHost>> = const { OnceCell::new() };
    }

    fn installed(verb: &str) -> Result<Option<Retained<TabHost>>> {
        HOST.try_with(|host| host.get().cloned())
            .map_err(|_| gone(verb))
    }

    fn keep(host: Retained<TabHost>) -> Result<()> {
        HOST.try_with(|kept| kept.set(host).map_err(|_| mismatch()))
            .map_err(|_| gone(INSTALLED))?
    }

    fn carrier(
        main: MainThreadMarker,
        tab: &Tab,
        image: &UIImage,
    ) -> Result<Retained<UIViewController>> {
        let carrier = UIViewController::new(main);
        let Some(view) = carrier.view() else {
            return Err(no_window(INSTALLED, NO_CARRIER_VIEW));
        };
        view.setBackgroundColor(Some(&UIColor::clearColor()));
        view.setUserInteractionEnabled(false);
        let item = UITabBarItem::initWithTitle_image_tag(
            main.alloc(),
            Some(&NSString::from_str(&tab.title)),
            Some(image),
            0,
        );
        unsafe { carrier.setTabBarItem(Some(&item)) };
        Ok(carrier)
    }

    fn rooted(screen: &UIWindow, controller: &UIViewController) -> bool {
        screen
            .rootViewController()
            .is_some_and(|root| same::<UIViewController>(&root, controller))
    }

    fn back(host: &TabHost, e: CommandError) -> CommandError {
        host.willMoveToParentViewController(None);
        host.ivars().veil.removeFromSuperview();
        host.removeFromParentViewController();
        e
    }

    pub(super) fn install(
        controller: &UIViewController,
        ask: BarAsk,
        window: tauri::WebviewWindow,
    ) -> Result<f64> {
        let main = MainThreadMarker::from(controller);
        if UIDevice::currentDevice(main).userInterfaceIdiom() != UIUserInterfaceIdiom::Phone {
            return Err(not_phone());
        }
        let BarAsk { tabs, state } = ask;
        let applied = applied(&tabs, &state, INSTALLED)?;
        if let Some(host) = installed(INSTALLED)? {
            return host.again(&tabs, &applied);
        }
        let Some(content) = controller.view() else {
            return Err(no_window(INSTALLED, NO_VIEW));
        };
        let Some(screen) = content.window() else {
            return Err(no_window(INSTALLED, NOT_SHOWN));
        };
        if !rooted(&screen, controller) {
            return Err(not_root());
        }
        let images = tabs
            .iter()
            .map(|tab| {
                UIImage::systemImageNamed(&NSString::from_str(&tab.image))
                    .ok_or_else(|| no_image(&tab.image))
            })
            .collect::<Result<Vec<_>>>()?;
        let carriers = tabs
            .iter()
            .zip(&images)
            .map(|(tab, image)| carrier(main, tab, image))
            .collect::<Result<Vec<_>>>()?;
        let flexible = UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight;
        let veil = TabVeil::new(main, content.bounds());
        veil.setAutoresizingMask(flexible);
        let host = TabHost::new(
            main,
            Ivars {
                window,
                tabs,
                content: content.clone(),
                veil: veil.clone(),
                sent: Cell::new(0.0),
                live: Cell::new(false),
                faulted: Cell::new(false),
            },
        );
        host.setViewControllers(Some(&NSArray::from_retained_slice(&carriers)));
        host.setDelegate(Some(ProtocolObject::from_ref(&*host)));
        host.apply(&applied.shown());
        let Some(frame) = host.view() else {
            return Err(no_window(INSTALLED, NO_HOST_VIEW));
        };
        content.addSubview(&veil);
        controller.addChildViewController(&host);
        frame.setBackgroundColor(Some(&UIColor::clearColor()));
        frame.setAutoresizingMask(flexible);
        frame.setFrame(veil.bounds());
        veil.addSubview(&frame);
        host.didMoveToParentViewController(Some(controller));
        let Some((view, measured)) = host.laid_out() else {
            return Err(back(&host, no_window(INSTALLED, NO_HOST_VIEW)));
        };
        let height = installed_height(measured).map_err(|e| back(&host, e))?;
        if host.order(&view) == Order::Lost {
            return Err(back(&host, out_of_host(INSTALLED)));
        }
        host.apply(&applied);
        host.ivars().sent.set(height);
        keep(host.clone()).map_err(|e| back(&host, e))?;
        host.ivars().live.set(true);
        host.send(Out::Moved(Geometry { height }));
        Ok(height)
    }

    pub(super) fn set(state: BarState) -> Result<()> {
        let Some(host) = installed(SET)? else {
            return Err(not_installed());
        };
        let applied = applied(&host.ivars().tabs, &state, SET)?;
        host.apply(&applied);
        Ok(())
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn tabbar_install(window: tauri::WebviewWindow, bar: BarAsk) -> Result<Geometry> {
    validate(&bar)?;
    let owner = window.clone();
    super::main_thread::run(&window, Install, move |controller| {
        uikit::install(controller, bar, owner)
    })
    .await
    .map(|height| Geometry { height })
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn tabbar_set(window: tauri::WebviewWindow, state: BarState) -> Result<()> {
    settable(&state)?;
    super::main_thread::run(&window, Set, move |_| uikit::set(state)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::main_thread::{dropped, unrun, MAIN_THREAD_WAIT};
    use serde_json::json;

    fn tab(id: &str) -> serde_json::Value {
        json!({ "id": id, "title": id.to_uppercase(), "image": format!("{id}.symbol") })
    }

    fn three() -> serde_json::Value {
        json!({
            "tabs": [
                { "id": "timeline", "title": "Timeline", "image": "calendar.day.timeline.left" },
                { "id": "board", "title": "Board", "image": "rectangle.split.3x1" },
                { "id": "list", "title": "List", "image": "list.bullet" }
            ],
            "state": { "selected": "timeline", "hidden": false, "tint": "#24E0FF" }
        })
    }

    fn ask(value: serde_json::Value) -> BarAsk {
        serde_json::from_value(value).expect("a well-formed tab bar")
    }

    fn with_tabs(tabs: serde_json::Value) -> BarAsk {
        let mut value = three();
        value["tabs"] = tabs;
        value["state"]["selected"] = json!("a");
        ask(value)
    }

    fn state(selected: &str, hidden: bool, tint: &str) -> BarState {
        BarState {
            selected: selected.to_string(),
            hidden,
            tint: tint.to_string(),
        }
    }

    #[test]
    fn the_three_phone_tabs_are_valid() {
        let bar = ask(three());
        assert_eq!(validate(&bar), Ok(()));
        assert_eq!(
            bar.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["timeline", "board", "list"]
        );
        assert_eq!(bar.state, state("timeline", false, "#24E0FF"));
        assert_eq!(
            applied(&bar.tabs, &bar.state, INSTALLED),
            Ok(Applied {
                index: 0,
                hidden: false,
                rgb: [36.0 / 255.0, 224.0 / 255.0, 1.0],
            })
        );
    }

    #[test]
    fn the_bar_is_measured_shown_whatever_the_state_asks() {
        let hidden = Applied {
            index: 2,
            hidden: true,
            rgb: [0.0, 0.0, 0.0],
        };
        assert_eq!(
            hidden.shown(),
            Applied {
                index: 2,
                hidden: false,
                rgb: [0.0, 0.0, 0.0],
            }
        );
        assert_eq!(hidden.shown().shown(), hidden.shown());
    }

    #[test]
    fn two_and_five_tabs_are_valid() {
        assert_eq!(validate(&with_tabs(json!([tab("a"), tab("b")]))), Ok(()));
        assert_eq!(
            validate(&with_tabs(json!([
                tab("a"),
                tab("b"),
                tab("c"),
                tab("d"),
                tab("e")
            ]))),
            Ok(())
        );
    }

    #[test]
    fn tabs_that_cannot_be_shown_are_refused() {
        let cases = [
            (json!([]), "it has 0 tabs, not 2 to 5"),
            (json!([tab("a")]), "it has 1 tab, not 2 to 5"),
            (
                json!([tab("a"), tab("b"), tab("c"), tab("d"), tab("e"), tab("f")]),
                "it has 6 tabs, not 2 to 5",
            ),
            (
                json!([tab("a"), { "id": " ", "title": "B", "image": "b" }]),
                "tab 2 has an empty id",
            ),
            (
                json!([tab("a"), { "id": "b", "title": "", "image": "b" }]),
                "the tab \"b\" has an empty title",
            ),
            (
                json!([tab("a"), { "id": "b", "title": "B", "image": " \t" }]),
                "the tab \"b\" has an empty image",
            ),
            (
                json!([tab("a"), tab("b"), tab("a")]),
                "the id \"a\" is used twice",
            ),
        ];
        cases.into_iter().for_each(|(tabs, why)| {
            assert_eq!(
                validate(&with_tabs(tabs.clone())),
                Err(CommandError::new(
                    "tabbar.tabs",
                    format!("The tab bar cannot be installed: {why}.")
                )),
                "{tabs}"
            );
        });
    }

    #[test]
    fn a_selected_tab_that_is_not_one_of_the_tabs_is_refused() {
        let mut bar = ask(three());
        bar.state.selected = "gantt".to_string();
        assert_eq!(
            validate(&bar),
            Err(CommandError::new(
                "tabbar.selected",
                "The tab bar cannot be installed: the selected tab \"gantt\" is not one of its tabs."
            ))
        );
        assert_eq!(
            applied(&bar.tabs, &state("Board", true, "#000000"), SET),
            Err(CommandError::new(
                "tabbar.selected",
                "The tab bar cannot be set: the selected tab \"Board\" is not one of its tabs."
            ))
        );
        assert_eq!(
            applied(&bar.tabs, &state("list", true, "#000000"), SET),
            Ok(Applied {
                index: 2,
                hidden: true,
                rgb: [0.0, 0.0, 0.0],
            })
        );
    }

    #[test]
    fn a_tint_that_is_not_a_hash_and_six_hex_digits_is_refused() {
        ["24E0FF", "#24E0F", "#24E0FFF", "#24E0FG", "", "#", "rgb(0,0,0)", "#24E0FF ", "#+4E0FF"]
            .iter()
            .for_each(|bad| {
                let mut bar = ask(three());
                bar.state.tint = bad.to_string();
                assert_eq!(
                    validate(&bar),
                    Err(CommandError::new(
                        "tabbar.tint",
                        format!("The tab bar cannot be installed: the tint {bad:?} is not # and six hex digits.")
                    )),
                    "{bad:?}"
                );
                assert_eq!(
                    settable(&state("board", false, bad)),
                    Err(CommandError::new(
                        "tabbar.tint",
                        format!("The tab bar cannot be set: the tint {bad:?} is not # and six hex digits.")
                    )),
                    "{bad:?}"
                );
            });
        assert_eq!(tint("#ffffff"), Some([1.0, 1.0, 1.0]));
        assert_eq!(tint("#FF0080"), Some([1.0, 0.0, 128.0 / 255.0]));
        assert_eq!(settable(&state("anything", true, "#24e0ff")), Ok(()));
    }

    #[test]
    fn an_unknown_or_missing_field_is_refused_at_every_level() {
        let good = three();
        assert!(serde_json::from_value::<BarAsk>(good.clone()).is_ok());
        let mut extra = good.clone();
        extra["badge"] = json!(1);
        let mut tab_extra = good.clone();
        tab_extra["tabs"][0]["badge"] = json!("3");
        let mut state_extra = good.clone();
        state_extra["state"]["minimise"] = json!(true);
        let mut no_hidden = good.clone();
        no_hidden["state"] = json!({ "selected": "timeline", "tint": "#24E0FF" });
        let mut no_image = good.clone();
        no_image["tabs"][1] = json!({ "id": "board", "title": "Board" });
        let mut no_state = good;
        no_state.as_object_mut().expect("an object").remove("state");
        [extra, tab_extra, state_extra, no_hidden, no_image, no_state]
            .iter()
            .for_each(|bad| {
                assert!(
                    serde_json::from_value::<BarAsk>(bad.clone()).is_err(),
                    "{bad} was accepted"
                )
            });
        assert!(serde_json::from_value::<BarState>(
            json!({ "selected": "list", "hidden": true, "tint": "#24E0FF", "again": true })
        )
        .is_err());
        assert!(serde_json::from_value::<BarState>(
            json!({ "selected": "list", "tint": "#24E0FF" })
        )
        .is_err());
        assert_eq!(
            serde_json::to_value(Geometry { height: 83.0 }).expect("a geometry"),
            json!({ "height": 83.0 })
        );
    }

    #[test]
    fn the_height_is_sent_once_it_moves_by_half_a_point_while_the_bar_shows() {
        assert_eq!(measure(false, 83.0, 83.0), Measure::Quiet);
        assert_eq!(measure(false, 83.0, 83.4), Measure::Quiet);
        assert_eq!(measure(false, 83.0, 83.5), Measure::Send(83.5));
        assert_eq!(measure(false, 83.0, 64.0), Measure::Send(64.0));
        assert_eq!(measure(false, 64.0, 83.0), Measure::Send(83.0));
        assert_eq!(measure(false, 83.0, 0.0), Measure::Flat(0.0));
        assert_eq!(measure(false, 0.0, 0.0), Measure::Quiet);
        assert_eq!(measure(false, 0.0, -1.0), Measure::Quiet);
        assert_eq!(measure(false, 0.0, 83.0), Measure::Send(83.0));
    }

    #[test]
    fn a_hidden_bar_is_not_measured() {
        assert_eq!(measure(true, 83.0, 0.0), Measure::Quiet);
        assert_eq!(measure(true, 83.0, 64.0), Measure::Quiet);
        assert_eq!(measure(true, 0.0, 83.0), Measure::Quiet);
    }

    #[test]
    fn an_install_needs_a_height_above_zero_and_a_reinstall_says_it_kept_the_bar() {
        assert_eq!(installed_height(83.0), Ok(83.0));
        assert_eq!(
            installed_height(0.0),
            Err(CommandError::new(
                "tabbar.no_height",
                "The tab bar cannot be installed: the bar's height is 0 after layout, so everything was undone."
            ))
        );
        assert_eq!(reinstalled_height(Some(64.0)), Ok(64.0));
        assert_eq!(
            reinstalled_height(Some(0.0)),
            Err(CommandError::new(
                "tabbar.no_height",
                "The tab bar cannot be installed again: the bar that is already installed is 0 high after layout, and it stays installed."
            ))
        );
        assert_eq!(
            reinstalled_height(None),
            Err(CommandError::new(
                "tabbar.no_window",
                "The tab bar cannot be installed: the tab bar controller has no view."
            ))
        );
    }

    #[test]
    fn the_veil_is_raised_when_not_topmost_and_lost_without_the_host_or_the_web_view() {
        assert_eq!(order_of(1, Some(0), true), Order::Kept);
        assert_eq!(order_of(3, Some(2), true), Order::Kept);
        assert_eq!(order_of(3, Some(1), true), Order::Raise);
        assert_eq!(order_of(3, Some(0), true), Order::Raise);
        assert_eq!(order_of(3, Some(2), false), Order::Lost);
        assert_eq!(order_of(3, Some(0), false), Order::Lost);
        assert_eq!(order_of(3, None, true), Order::Lost);
        assert_eq!(order_of(0, None, true), Order::Lost);
        assert_eq!(order_of(0, None, false), Order::Lost);
    }

    #[test]
    fn a_pick_names_the_tab_and_whether_it_was_selected() {
        let bar = ask(three());
        assert_eq!(
            picked(&bar.tabs, Some(1), 0),
            Ok(Out::Picked {
                id: "board".to_string(),
                again: false
            })
        );
        assert_eq!(
            picked(&bar.tabs, Some(2), 2),
            Ok(Out::Picked {
                id: "list".to_string(),
                again: true
            })
        );
        let lost = "webboard: the tab bar asked to select a view controller that is not one of its tabs; nothing is sent and the selection stays".to_string();
        assert_eq!(picked(&bar.tabs, None, 0), Err(lost.clone()));
        assert_eq!(picked(&bar.tabs, Some(3), 0), Err(lost));
    }

    #[test]
    fn the_events_carry_the_documented_payloads() {
        assert_eq!(
            Out::Picked {
                id: "board".to_string(),
                again: true
            }
            .event(),
            ("tabbar-picked", json!({ "id": "board", "again": true }))
        );
        assert_eq!(
            Out::Moved(Geometry { height: 83.0 }).event(),
            ("tabbar-geometry", json!({ "height": 83.0 }))
        );
        assert_eq!(
            Out::Fault(out_of_host(LAID_OUT)).event(),
            (
                "tabbar-fault",
                json!({
                    "code": "tabbar.order",
                    "message": "The tab bar cannot be laid out: the tab bar's views are not on top of the web view."
                })
            )
        );
        assert_eq!(
            emit_fault(&Out::Moved(Geometry { height: 64.0 }), "the window is gone"),
            "webboard: could not emit tabbar-geometry {\"height\":64.0}: the window is gone"
        );
    }

    fn every_error() -> Vec<CommandError> {
        vec![
            Install.off_main(),
            Set.off_main(),
            Install.no_controller(),
            Set.no_controller(),
            Install.unreachable("the event loop is gone"),
            Set.unreachable("the event loop is gone"),
            dropped::<Install>(),
            dropped::<Set>(),
            unrun::<Install>(MAIN_THREAD_WAIT),
            unrun::<Set>(MAIN_THREAD_WAIT),
            gone(INSTALLED),
            gone(SET),
            not_phone(),
            no_window(INSTALLED, NO_VIEW),
            no_window(INSTALLED, NOT_SHOWN),
            no_window(INSTALLED, NO_HOST_VIEW),
            no_window(INSTALLED, NO_CARRIER_VIEW),
            no_window(LAID_OUT, NO_HOST_VIEW),
            not_root(),
            no_image("calendar.day.timeline.left"),
            no_height(0.0),
            kept_flat(0.0),
            flat_shown(0.0),
            out_of_host(INSTALLED),
            out_of_host(LAID_OUT),
            not_installed(),
            mismatch(),
        ]
    }

    #[test]
    fn every_failure_has_its_own_code() {
        let errors = every_error();
        assert_eq!(
            errors.iter().map(|e| e.code.as_str()).collect::<Vec<_>>(),
            [
                "tabbar.off_main",
                "tabbar.off_main",
                "tabbar.no_controller",
                "tabbar.no_controller",
                "tabbar.unreachable",
                "tabbar.unreachable",
                "tabbar.stopped",
                "tabbar.stopped",
                "tabbar.stopped",
                "tabbar.stopped",
                "tabbar.stopped",
                "tabbar.stopped",
                "tabbar.not_phone",
                "tabbar.no_window",
                "tabbar.no_window",
                "tabbar.no_window",
                "tabbar.no_window",
                "tabbar.no_window",
                "tabbar.not_root",
                "tabbar.no_image",
                "tabbar.no_height",
                "tabbar.no_height",
                "tabbar.no_height",
                "tabbar.order",
                "tabbar.order",
                "tabbar.not_installed",
                "tabbar.mismatch",
            ]
        );
        assert_eq!(
            errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            [
                "The tab bar cannot be installed: WebBoard tried to install it off the main thread.",
                "The tab bar cannot be set: WebBoard tried to set it off the main thread.",
                "The tab bar cannot be installed: the window has no view controller.",
                "The tab bar cannot be set: the window has no view controller.",
                "The tab bar cannot be installed: the window could not be reached: the event loop is gone.",
                "The tab bar cannot be set: the window could not be reached: the event loop is gone.",
                "The tab bar cannot be installed: the main thread dropped it without a result.",
                "The tab bar cannot be set: the main thread dropped it without a result.",
                "The tab bar cannot be installed: the main thread did not run it within 5000 ms.",
                "The tab bar cannot be set: the main thread did not run it within 5000 ms.",
                "The tab bar cannot be installed: the main thread's tab bar store is gone.",
                "The tab bar cannot be set: the main thread's tab bar store is gone.",
                "The tab bar cannot be installed: the device is not an iPhone.",
                "The tab bar cannot be installed: the view controller has no view.",
                "The tab bar cannot be installed: its view is in no window.",
                "The tab bar cannot be installed: the tab bar controller has no view.",
                "The tab bar cannot be installed: a tab's view controller has no view.",
                "The tab bar cannot be laid out: the tab bar controller has no view.",
                "The tab bar cannot be installed: the window's root is not the web view's controller.",
                "The system image calendar.day.timeline.left does not exist.",
                "The tab bar cannot be installed: the bar's height is 0 after layout, so everything was undone.",
                "The tab bar cannot be installed again: the bar that is already installed is 0 high after layout, and it stays installed.",
                "The tab bar cannot be laid out: its height is 0 while it is shown.",
                "The tab bar cannot be installed: the tab bar's views are not on top of the web view, so everything was undone.",
                "The tab bar cannot be laid out: the tab bar's views are not on top of the web view.",
                "The tab bar cannot be set: it is not installed yet.",
                "The tab bar cannot be installed: it is already installed with other tabs.",
            ]
        );
    }

    #[test]
    fn every_message_is_a_sentence_ending_in_a_full_stop() {
        every_error().iter().for_each(|e| {
            assert!(
                e.message.ends_with('.') && e.message.starts_with(char::is_uppercase),
                "{}: {:?} is not a sentence ending in a full stop",
                e.code,
                e.message
            )
        });
    }
}

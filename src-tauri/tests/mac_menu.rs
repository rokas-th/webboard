#[cfg(target_os = "macos")]
mod mac {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};
    use tauri::menu::{Menu, MenuItemKind};
    use tauri::test::MockRuntime;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Node {
        id: String,
        kind: &'static str,
        title: String,
        key: String,
        modifiers: usize,
        children: Vec<Node>,
    }

    fn id_of(id: &str) -> String {
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            "<generated>".to_string()
        } else {
            id.to_string()
        }
    }

    fn kind_of(item: &MenuItemKind<MockRuntime>) -> &'static str {
        match item {
            MenuItemKind::MenuItem(_) => "item",
            MenuItemKind::Submenu(_) => "submenu",
            MenuItemKind::Predefined(_) => "predefined",
            MenuItemKind::Check(_) => "check",
            MenuItemKind::Icon(_) => "icon",
        }
    }

    fn walk(items: Vec<MenuItemKind<MockRuntime>>, native: &NSMenu) -> Vec<Node> {
        let count =
            usize::try_from(native.numberOfItems()).expect("a menu has a non-negative item count");
        assert_eq!(
            items.len(),
            count,
            "tauri and AppKit disagree on the number of items in a menu"
        );
        items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let at = isize::try_from(index).expect("a menu index fits an NSInteger");
                let ns = native
                    .itemAtIndex(at)
                    .expect("AppKit has an item at every index tauri lists");
                let children = match item.as_submenu() {
                    Some(sub) => walk(
                        sub.items().expect("a submenu lists its items"),
                        &ns.submenu()
                            .expect("AppKit has a submenu where tauri has one"),
                    ),
                    None => Vec::new(),
                };
                Node {
                    id: id_of(item.id().as_ref()),
                    kind: kind_of(item),
                    title: ns.title().to_string(),
                    key: ns.keyEquivalent().to_string(),
                    modifiers: ns.keyEquivalentModifierMask().0,
                    children,
                }
            })
            .collect()
    }

    fn native(app: &tauri::App<MockRuntime>, menu: Menu<MockRuntime>) -> Vec<Node> {
        app.handle()
            .set_menu(menu.clone())
            .expect("the menu becomes the app menu");
        let mtm = MainThreadMarker::new().expect("this test runs on the main thread");
        let main = NSApplication::sharedApplication(mtm)
            .mainMenu()
            .expect("NSApp has the menu as its main menu");
        walk(menu.items().expect("the menu lists its items"), &main)
    }

    pub fn run() {
        let app = tauri::test::mock_app();
        let default = native(
            &app,
            Menu::default(app.handle()).expect("tauri builds its default menu"),
        );
        let ours = native(
            &app,
            webboard_lib::menu::app_menu(app.handle()).expect("WebBoard builds its app menu"),
        );

        let default_quit = default
            .first()
            .and_then(|app_menu| app_menu.children.last())
            .expect("the default app submenu ends in an item")
            .clone();
        assert_eq!(
            (
                default_quit.kind,
                default_quit.key.as_str(),
                default_quit.modifiers
            ),
            ("predefined", "q", NSEventModifierFlags::Command.0),
            "the default app submenu no longer ends in the predefined ⌘Q Quit: {default_quit:?}"
        );

        let ours_quit = ours
            .first()
            .and_then(|app_menu| app_menu.children.last())
            .expect("WebBoard's app submenu ends in an item")
            .clone();
        assert_eq!(
            ours_quit,
            Node {
                id: webboard_lib::menu::QUIT_MENU_ID.to_string(),
                kind: "item",
                title: "Quit WebBoard".to_string(),
                key: "q".to_string(),
                modifiers: NSEventModifierFlags::Command.0,
                children: Vec::new(),
            },
            "WebBoard's Quit is not the custom ⌘Q item that closes the windows first"
        );

        let expected: Vec<Node> = default
            .iter()
            .enumerate()
            .map(|(index, submenu)| {
                if index == 0 {
                    let mut children = submenu.children.clone();
                    children.pop();
                    children.push(ours_quit.clone());
                    Node {
                        children,
                        ..submenu.clone()
                    }
                } else {
                    submenu.clone()
                }
            })
            .collect();
        assert_eq!(
            ours, expected,
            "WebBoard's app menu differs from tauri's default menu in more than the Quit item"
        );

        println!(
            "mac_menu: {} submenus, {} items match tauri's default menu apart from Quit",
            ours.len(),
            ours.iter()
                .map(|submenu| submenu.children.len())
                .sum::<usize>()
        );
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    mac::run();
}

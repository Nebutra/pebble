#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Runtime};

const OPEN_MENU_ID: &str = "pebble-tray-open";
const QUIT_MENU_ID: &str = "pebble-tray-quit";

pub fn install<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_MENU_ID, "Open Pebble", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("pebble-main-tray")
        .menu(&menu)
        .tooltip("Pebble")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            OPEN_MENU_ID => restore_main_window(app),
            // Why: tray Quit must enter the same renderer-owned unsaved-work guards as window Quit.
            QUIT_MENU_ID => {
                let _ = app.emit("pebble://tray-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn restore_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = crate::primary_window::webview_window(app) {
        crate::primary_window::restore_and_focus(&window);
    }
}

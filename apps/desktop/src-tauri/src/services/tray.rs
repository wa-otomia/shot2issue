//! System-tray icon + menu — the primary launch surface for a capture tool.
//!
//! Phase 3 installs the tray with its menu wired to the shell's window
//! openers; the "Capture now" item kicks the (stubbed) capture flow. Phase 4
//! fills in the capture behavior and any dynamic menu state.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Bring the hidden/minimized main window back to the foreground. The main
/// window is hidden (not closed) on CloseRequested, so `show()` makes it visible
/// again; `unminimize()` covers a minimized window (harmless no-op otherwise);
/// `set_focus()` raises it above other apps and gives it keyboard focus.
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let capture = MenuItemBuilder::with_id("tray-capture", "Capture now").build(app)?;
    let settings = MenuItemBuilder::with_id("tray-settings", "Settings\u{2026}").build(app)?;
    let updates = MenuItemBuilder::with_id("tray-check-update", "Check for Updates\u{2026}").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit shot2issue").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&capture)
        .item(&settings)
        .separator()
        .item(&updates)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("shot2issue")
        .menu(&menu)
        // Left-click should reveal the window (macOS/Windows/Linux convention),
        // not drop the context menu. Right-click still opens the menu below.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-capture" => {
                // The mandatory fallback trigger on native Wayland (where the
                // global hotkey can't register). Spawn so the menu callback
                // returns immediately; capture + overlay run off this thread.
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::services::hotkey::trigger_capture(&h).await;
                });
            }
            "tray-settings" => reveal_main(app),
            "tray-check-update" => crate::open_updater(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click (on release) reveals the main window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        });

    // Reuse the bundled app icon for the tray when available.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

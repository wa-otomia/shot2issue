//! System-tray icon + menu — the primary launch surface for a capture tool.
//!
//! Phase 3 installs the tray with its menu wired to the shell's window
//! openers; the "Capture now" item kicks the (stubbed) capture flow. Phase 4
//! fills in the capture behavior and any dynamic menu state.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

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
            "tray-settings" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "tray-check-update" => crate::open_updater(app),
            "tray-quit" => app.exit(0),
            _ => {}
        });

    // Reuse the bundled app icon for the tray when available.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

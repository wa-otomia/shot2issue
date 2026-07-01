mod commands;
mod services; // services/{capture,hotkey,tray,updates}.rs — sibling subsystems

use tauri::{Emitter, Manager, WindowEvent};

/// Open (or focus) a frameless rounded popup (updater / about) — copied from
/// curvault. The webview branches on window label (see main.tsx).
pub(crate) fn open_popup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    title: &str,
    w: f64,
    h: f64,
) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .center()
        .build();
}

pub(crate) fn open_updater<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    open_popup(app, "updater", "Software Update", 460.0, 560.0);
}
pub(crate) fn open_about<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    open_popup(app, "about", "About shot2issue", 520.0, 430.0);
}

fn build_menu<R: tauri::Runtime>(h: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let about = MenuItemBuilder::with_id("about", "About shot2issue").build(h)?;
    let check = MenuItemBuilder::with_id("check-update", "Check for Updates\u{2026}").build(h)?;
    // Recovery path for a hidden window when there is no system tray (some Linux
    // desktops): the window hides (not closes) on close, so without this menu
    // item a tray-less user could never get it back. Reveals the main window via
    // the same show+unminimize+focus the tray uses.
    let show_window = MenuItemBuilder::with_id("show-window", "Show Window").build(h)?;
    #[allow(unused_mut)]
    let mut app_sub = SubmenuBuilder::new(h, "shot2issue")
        .item(&about)
        .item(&check)
        .separator()
        .item(&show_window)
        .separator();
    #[cfg(target_os = "macos")]
    {
        app_sub = app_sub
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator();
    }
    let app_sub = app_sub.quit().build()?;
    let edit = SubmenuBuilder::new(h, "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    MenuBuilder::new(h).items(&[&app_sub, &edit]).build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Global hotkey: stock plugin works on Win/mac/X11; native Wayland is
        // unsupported (documented; the tray "Capture now" item is the fallback
        // there). The per-shortcut callback is registered in
        // `services::hotkey::register` via `on_shortcut`, so the builder needs
        // no global handler here (a `with_handler` would double-fire alongside
        // the per-shortcut one).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "about" => open_about(app),
            "check-update" => open_updater(app),
            // Menubar fallback to un-hide the main window on a tray-less desktop.
            "show-window" => services::tray::reveal_main(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        // Don't quit on close — hide to the tray so the global hotkey
                        // and "Capture now" keep working in the background. The tray's
                        // "Quit shot2issue" (and the macOS app-menu Quit) actually exit.
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Closing the editor ends the staging session and frees the
                    // staged image bytes (extension parity with the
                    // chrome.tabs.onRemoved cleanup).
                    "editor" => services::editor_stage::clear_pending_shots(),
                    // Cancelling the overlay drops the retained 4K frame.
                    "overlay" => services::capture::clear_last_frame(),
                    _ => {}
                }
            }
        })
        .setup(|app| {
            services::install_app_handle(app.handle().clone());
            services::tray::install(app.handle())?; // tray icon + menu (capture/settings/quit)
            // Defer global-shortcut registration OFF the main thread. On macOS every
            // plugin call blocks on a main-thread round-trip (run_main_thread!), and
            // setup() runs ON the main thread before the event loop is live — so
            // registering here stalls and Carbon never lands the hotkey. Spawning
            // lets setup() return so the loop starts draining the posted task.
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    services::hotkey::register_saved(&h); // read stored accelerator, register
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ---- hotkey ----
            commands::get_default_accelerator,
            commands::get_hotkey,
            commands::set_capture_hotkey,
            commands::trigger_capture,
            // ---- capture ----
            commands::capture_current_monitor,
            commands::list_displays,
            commands::get_overlay_shot,
            commands::list_windows,
            commands::capture_window,
            commands::crop_region,
            commands::mac_screen_recording_authorized,
            // ---- overlay ----
            commands::overlay_dismiss,
            // ---- editor staging ----
            commands::open_editor_with,
            commands::get_pending_shots,
            // ---- updates / windows (curvault) ----
            commands::check_for_updates,
            commands::open_updater_window,
            commands::open_about_window,
            // ---- Codex OAuth loopback ----
            commands::oauth_loopback_start,
            commands::oauth_loopback_wait,
            // ---- GitHub (web-session cookie) ----
            commands::github_login,
            commands::github_accounts,
            commands::github_logout,
            commands::github_upload_image,
            commands::github_create_issue,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS: clicking the dock icon fires Reopen (AppKit's
            // applicationShouldHandleReopen). No window/tray event covers it, so
            // reveal the hidden main window here. Gated to macOS since Reopen
            // only exists/fires there; the else arm silences unused-var warnings.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}

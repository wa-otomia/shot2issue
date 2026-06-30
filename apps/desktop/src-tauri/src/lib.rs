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

/// Build (or focus) the capture HUD: a borderless, transparent, always-on-top
/// window covering one display. Returns false on native Wayland where
/// positioning / raising is unsupported (caller falls back to in-window crop).
pub(crate) fn open_overlay<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    display: &services::capture::Display,
) -> bool {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if services::capture::is_wayland() {
        return false;
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.show();
        let _ = win.set_focus();
        return true;
    }
    let built = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .position(display.x as f64, display.y as f64)
        .inner_size(display.width as f64, display.height as f64)
        .focused(true)
        .build();
    built.is_ok()
}

fn build_menu<R: tauri::Runtime>(h: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let about = MenuItemBuilder::with_id("about", "About shot2issue").build(h)?;
    let check = MenuItemBuilder::with_id("check-update", "Check for Updates\u{2026}").build(h)?;
    #[allow(unused_mut)]
    let mut app_sub = SubmenuBuilder::new(h, "shot2issue")
        .item(&about)
        .item(&check)
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
        .plugin(
            // Global hotkey: stock plugin works on Win/mac/X11; native Wayland
            // is unsupported (documented). The handler emits an event AND
            // kicks off the capture flow from Rust.
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("hotkey://fired", ());
                        services::capture::begin_capture_flow(app);
                    }
                })
                .build(),
        )
        .menu(build_menu)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "about" => open_about(app),
            "check-update" => open_updater(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("app://close", ());
                }
            }
        })
        .setup(|app| {
            services::install_app_handle(app.handle().clone());
            services::tray::install(app.handle())?; // tray icon + menu (capture/settings/quit)
            services::hotkey::register_saved(app.handle()); // read stored accelerator, register
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_screen_under_cursor,
            commands::list_displays,
            commands::list_windows,
            commands::capture_window,
            commands::mac_screen_recording_authorized,
            commands::open_overlay,
            commands::close_overlay,
            commands::get_hotkey,
            commands::set_hotkey,
            commands::check_for_updates,
            commands::open_updater_window,
            commands::open_about_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

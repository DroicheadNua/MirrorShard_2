// wayland_nvidia.rs
use gtk::prelude::*;

pub fn force_paint_gl_context(window: &gtk::ApplicationWindow) {
    if window.is_realized() {
        create_gl_context(window);
    } else {
        window.connect_realize(create_gl_context);
    }
}

fn create_gl_context(window: &gtk::ApplicationWindow) {
    let Some(gdk_window) = window.window() else {
        return;
    };
    if let Err(error) = gdk_window.create_gl_context() {
        eprintln!("MirrorShard: GL context creation failed: {error}");
    }
}

/// 生成した WebviewWindow に対して、Nvidia+Wayland環境でのError 71対策を適用する。
/// 対象外の環境では何もしない。ウィンドウ生成箇所すべてから呼ぶこと。
#[cfg(target_os = "linux")]
fn apply_wayland_nvidia_workaround(window: &tauri::WebviewWindow) {
    if !is_nvidia_gpu() || !is_wayland_session() {
        return;
    }
    if let Ok(gtk_window) = window.gtk_window() {
        wayland_nvidia::force_paint_gl_context(&gtk_window);
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_wayland_nvidia_workaround(_window: &tauri::WebviewWindow) {}

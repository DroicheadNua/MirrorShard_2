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

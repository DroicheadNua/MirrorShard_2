# Running MirrorShard 2 on Linux

Starting from v0.3.0, Linux binaries for MirrorShard 2 were discontinued.  
As of v1.7.0, distribution has been **resumed on an experimental basis**.

Due to environment-dependent issues in Linux GUI systems—especially those related to WebKitGTK (used by Tauri)—Linux support had been unstable.  
However, by disabling WebKitGTK hardware acceleration, the application now runs on environments where it previously failed, including systems with NVIDIA GPUs and Wayland-based desktops.

That said, the Linux version still has some limitations (see below).

The previous version (Electron-based) is also available for Linux:  
https://github.com/DroicheadNua/MirrorShard

---

## Limitations

The following features are **not available** on Linux:

- Markdown / HTML preview
- Typewriter sound
- Spotlight mode

---

### Different Specifications

Starting with version 1.8.0, SillyTavern (Ctrl+Shift+J) and OpenCode (Ctrl+Shift+K) can now be launched using keyboard shortcuts.

However, unlike the Windows and macOS versions, which run in a dedicated window (WebView), the Linux version launches in the default browser.

---

## Known Issues

The following issues have been observed during testing:

- Rendering artifacts may appear when using a transparent background  
  (cleared after redraw, e.g., scrolling; does not occur with opaque backgrounds)

- Environment-dependent: Search functionality in the chat window may not work as expected (search engine may block requests)

### MX Linux (X11 / Xfce)
- Inline input does not work; IME falls back to over-the-spot mode  
  (composition text is shown in the IME window instead of the editor)

### Fedora (Wayland / GNOME, VM)
- Window resize cursor does not change when hovering over edges  
  (resizing is still possible, but less intuitive)

---

## Distribution Formats

Only the following formats are provided:

- `.deb` (x64)
- `.rpm` (x64)
- `.deb` (arm64)

For other distributions (e.g., Arch Linux), please build from source.

---

## Building from Source

If you understand the above limitations and still want to use MirrorShard 2 on your environment, please build it from source.

### Requirements

- Rust (Cargo)
- Node.js & pnpm
- WebKitGTK development libraries  
  (e.g., `libwebkit2gtk-4.0-dev` on Debian-based systems)

For Tauri and Rust setup, refer to the official documentation:  
https://v2.tauri.app/start/prerequisites/

```
# Clone repository
git clone https://github.com/DroicheadNua/MirrorShard_2.git
cd MirrorShard_2

# Install dependencies
pnpm install

# Build (release mode)
pnpm tauri build

After a successful build, installers will be generated under:

src-tauri/target/release/bundle/
```

🎵 BGM Feature and Performance

The behavior and memory usage of the BGM feature differ by OS:

Windows / macOS
Audio files (mp3/wav/ogg) are streamed from disk
Minimal memory usage
Linux (including Raspberry Pi)
Due to platform limitations, audio is fully loaded into memory
Higher memory usage when BGM is enabled

On low-spec environments (e.g., Raspberry Pi), disabling BGM is recommended if memory usage becomes an issue.

## NixOS Support (Build & Execution)

Detailed instructions and troubleshooting steps for developing, building, and running MirrorShard 2 under NixOS (including Wayland-based desktop environments).

### 1. Entering the Development Environment (nix-shell)

A `shell.nix` is provided in the repository root. This allows you to load all necessary dependencies (Node.js, pnpm, Rust, WebKitGTK, GStreamer, glib-networking, etc.) into an isolated development shell without installing them system-wide.

In your terminal, navigate to the repository root and run:

nix-shell

If this is your first time, initialize the Rust toolchain and add it to your PATH inside the shell:

rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"

Once the environment is initialized, you can proceed with standard build and run commands:

```
# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build the release binary
pnpm tauri build
```

2. Troubleshooting (NixOS-Specific Workarounds)
① AppImage build fails due to linuxdeploy missing /usr/bin/xdg-open

NixOS does not have a traditional /usr/bin FHS structure. This can cause the Tauri AppImage bundler to fail.
To bypass this, enable envfs in your /etc/nixos/configuration.nix and rebuild your system:

services.envfs.enable = true;

② AI chat/connections fail with TypeError: Load failed (TLS/HTTPS Issues)

Under NixOS, the WebKitGTK browser engine might fail to resolve secure HTTPS handshakes to external APIs (such as Mistral or OpenRouter) because it cannot locate system SSL certificates or the glib-networking TLS module.

To resolve this globally for all GUI launches, add the following environment.extraInit block to your /etc/nixos/configuration.nix, rebuild, and reboot (or re-login):

```
# Export essential environment variables for all GUI and terminal sessions
environment.extraInit = ''
  # Map the glib-networking path for secure TLS handshakes in WebKitGTK
  export GIO_EXTRA_MODULES=$GIO_EXTRA_MODULES:${pkgs.glib-networking}/lib/gio/modules

  # Expose system SSL certificate bundles for HTTPS requests
  export SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt
  export NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt

  # Map GStreamer plugins globally for typewriter and BGM audio playback
  export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0"
'';
```

③ Window resizing/popup issues under Virtualization (VirtualBox/UTM)

If you experience layout corruption, un-draggable windows, or broken popup menus under Wayland virtualization, force the X11 compatibility layer (Xwayland).
Uncomment the following line in src-tauri/src/lib.rs and rebuild:

std::env::set_var("GDK_BACKEND", "x11");

Note: Under mature Wayland compositors (such as KDE Plasma 6), window dragging, resizing, and popups will function perfectly even with this X11 backend fallback active.
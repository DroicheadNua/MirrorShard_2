# Linux Support & Troubleshooting Guide

MirrorShard 2 natively supports Linux (x86_64 / ARM64). This document details Linux-specific behaviors, performance optimizations, known limitations, and build instructions.

In earlier versions, several features were restricted due to WebKitGTK and Tauri compatibility issues. Most of these have been resolved in recent updates. However, certain edge cases remain depending on your Linux environment.

---

## ⚡️ GPU Compositing & Performance

MirrorShard automatically optimizes its rendering pipeline depending on your system configuration (GPU drivers and desktop compositors).

* **Automatic GPU Compositing (High Performance)**  
  For Intel / AMD GPUs (Mesa drivers) or Smithay-based compositors (Niri / COSMIC / DriftWM), GPU compositing is enabled automatically. This significantly reduces CPU usage and delivers smooth, flicker-free rendering with transparent windows and visual effects.
* **Automatic Safety Fallback**  
  For NVIDIA GPUs (under non-Smithay compositors) or Virtual Machines (UTM / VirtualBox / QEMU), GPU compositing is automatically disabled (`WEBKIT_DISABLE_COMPOSITING_MODE=1`) to prevent Wayland protocol crashes (`Error 71`) and rendering artifacts.
* **Manual Override**  
  If you encounter rendering issues, you can force-disable GPU compositing by running `MIRRORSHARD_DISABLE_COMPOSITING=1 mirrorshard2` in your terminal.

### Restricted Features (When GPU Compositing is Disabled)
When GPU compositing is disabled, the following features will be hidden/unavailable:
* Live Markdown / HTML Preview
* Typing Sound Effects
* Spotlight Mode

### 🎨 Rendering & Linux-Specific Quirks

When GPU compositing is disabled, the following minor quirks may occur:

* **Ghosting on Semi-Transparent Backgrounds**: If window background transparency is enabled, character ghosting may appear during editing. Scrolling will force a re-render and clear it (this does not occur if the background is opaque).
* **Copy Limitation in Sub-Windows**: Due to multi-window IPC constraints on Linux, copying text inside sub-windows (such as the Settings modal) may be restricted (pasting remains functional).
* **AI Search Restrictions**: Depending on your Linux environment and search engine policies, the Web Search feature in the AI Chat window may be blocked or restricted.
* **Resize Cursor Shape (Wayland)**: On certain Wayland environments (GNOME, KDE), hovering over window edges may not change the cursor to the resize arrow. (Window resizing via dragging still works normally. In KDE, `Super + Right-Click Drag` is also available).
* **Window Dragging Workaround**: If dragging the titlebar does not move the window on your compositor, use standard Linux shortcuts: `Alt + Left-Click Drag` or `Super + Left-Click Drag`.
* **Text Selection via Dragging**: In some virtualized or Wayland environments, mouse drag selection may fail. Use `Click start point ➔ Hold Shift + Click end point` to select text cleanly.
* **Scroll Direction Inversion**: In rare cases, dragging the scrollbar thumb may invert direction.

---

## Specification Differences on Linux

* **External Tools (SillyTavern & OpenCode)**: Unlike Windows/macOS where SillyTavern (`Ctrl+Shift+J`) and OpenCode (`Ctrl+Shift+K`) launch in dedicated embedded WebViews, Linux launches them in your system's default browser.
* **Vertical Preview Background**: In Light Mode, the vertical preview background is set to a fixed sepia color (`#eae3d2`) on Linux to prevent asset loading failures.

---

## 🖋 Japanese & CJK Input (IME) Specifications

* **Inline Composition on Wayland**: Under Wayland environments (Niri / GNOME / COSMIC, etc.), `GTK_IM_MODULE=wayland` is applied automatically, enabling smooth native inline CJK input (Fcitx5 / IBus).
* **Over-the-spot Fallback (X11 / Legacy)**: In X11 environments or certain legacy setups, text composition falls back to "Over-the-spot" input (floating candidate window).

---

## 🎵 Background Music (BGM) Streaming

* Powered by a native Rust audio engine (`rodio`), BGM streaming is fully supported on Linux (including Raspberry Pi) with minimal RAM overhead (~1-2MB).

---

## 📦 Vivliostyle DTP Typesetting & PDF Export

* This feature requires **Node.js (npm / npx)** and **Google Chrome (or Chromium)** installed on your system.
* On NixOS, ensure `pkgs.chromium` is installed and `PUPPETEER_EXECUTABLE_PATH` is configured properly (refer to `flake.nix`).

---

## Distribution Formats

Pre-built binaries are provided for `.deb` (x86_64), `.rpm` (x86_64), and `.deb` (ARM64 for Raspberry Pi). For other distributions, please build from source using the steps below.

## Building from Source

### Prerequisites
* Rust (Cargo)
* Node.js & pnpm
* WebKitGTK Development Libraries (`libwebkit2gtk-4.0-dev` on Debian/Ubuntu)

Refer to the official Tauri v2 prerequisites guide:  
https://v2.tauri.app/start/prerequisites/

```bash
# Clone repository
git clone https://github.com/DroicheadNua/MirrorShard_2.git
cd MirrorShard_2

# Install dependencies
pnpm install

# Build release binary
pnpm tauri build
```
Upon successful build, installer packages will be generated under `src-tauri/target/release/bundle/`.

---

## NixOS Support (Flakes & Build Guide)

Detailed instructions for building, running, and troubleshooting MirrorShard 2 on NixOS.

### 1. Developer Shell (`nix develop`)

You can enter a fully configured virtual development environment containing all dependencies (Node.js, pnpm, Rust, WebKitGTK, GStreamer, glib-networking, GTK/GSettings schemas) using `flake.nix` without modifying your system configuration:

```bash
git add flake.nix
nix develop
```

On first launch inside the shell, set the stable Rust toolchain:

```bash
rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"
```

Inside the shell, you can develop and build normally:

```bash
pnpm install
pnpm tauri dev   # Live preview / dev mode
pnpm tauri build # Release build
```

---

### 2. Clean System Package Wrapping (`nix build path:.`)

Running raw compiled binaries outside `nix develop` on NixOS can cause GTK layout breakage or API connection failures due to NixOS path isolation.

To create a fully self-contained wrapper binary with all Nix library paths baked in:

```bash
# 1. Complete "pnpm tauri build" inside "nix develop"
# 2. Exit the dev shell, and run the following in a standard terminal:
nix build path:.
```

This generates a `./result` directory containing an isolated wrapper binary (`./result/bin/mirrorshard2`) that launches instantly without system path dependencies.

To integrate with your desktop launcher, create `~/.local/share/applications/mirrorshard2.desktop`:

```desktop
[Desktop Entry]
Type=Application
Name=MirrorShard 2
Exec=/absolute/path/to/MirrorShard_2/result/bin/mirrorshard2 %F
Icon=/absolute/path/to/MirrorShard_2/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;
MimeType=text/plain;
```

---

### 3. NixOS Troubleshooting

#### ① AppImage Build Crash (`linuxdeploy` fails finding `/usr/bin/xdg-open`)
Add the following to `/etc/nixos/configuration.nix` and rebuild:
```nix
services.envfs.enable = true;
```

#### ② Window Rendering Artifacts under Virtualization (VirtualBox / UTM)
If window rendering artifacts occur under virtualized GPUs, force X11 compatibility mode by uncommenting the following line in `src-tauri/src/lib.rs` and rebuilding:
```rust
std::env::set_var("GDK_BACKEND", "x11");
```

#### ③ Resource Path Resolution in Nix Store (Default BGM / Backgrounds)
In isolated Nix Store paths, default BGM or background image asset resolution may fail.
* **Vertical Preview**: Default light mode background is automatically locked to Sepia (`#eae3d2`). (Vertical EPUB/HTML export from the vertical preview window is not supported on NixOS).
* **Manual Asset Selection**: You can manually load default BGM/background assets via the Settings file picker by navigating directly to the Nix Store resource directory (`/nix/store/...-mirrorshard2/bin/resources/`).

---

## Using under Niri (Wayland Tiling Window Manager)

Under tiling window managers like Niri, sub-windows (Vertical Preview, AI Chat, Vivliostyle) tile automatically into columns by default.

To fix preview widths or force specific sub-windows to float automatically, add the following `window-rule` blocks to `~/.config/niri/config.kdl`:

```kdl
// Example config for ~/.config/niri/config.kdl

// 1. Lock Vertical Preview column width
window-rule {
    match app-id="com.DroicheadNua.mirrorshard2" title="^Preview"
    default-column-width 600
}

// 2. Open AI Chat window as floating by default
window-rule {
    match app-id="com.DroicheadNua.mirrorshard2" title="^AI Chat"
    open-floating true
    default-floating-width 640
    default-floating-height 800
}
```
```

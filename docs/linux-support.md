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

Also, for the Linux version, the background of the vertical text preview (in Light Mode) is a solid sepia color rather than the standard background image (since it may not load properly depending on the environment).  

---

## Known Issues on Linux

Due to the varying specifications of different Linux distributions, desktop environments (Wayland / X11), and system architectures, you may encounter the following behaviors or limitations.

### 🖋 Japanese Input (IME) Limitations
* **Fallback to Over-the-spot Input**: Depending on your input method framework (Fcitx5 / IBus) and desktop environment, inline text composition may not function directly inside the editor canvas. In many Linux environments, composition text will be rendered via a floating "Over-the-spot" candidate window instead.  
  *Note: A relatively stable inline composition experience has been confirmed under GNOME + IBus environments.*  
* **Duplicate Text Rendering**: In some Linux desktop environments, inline composition text and the floating Over-the-spot window may render simultaneously.

### 🪟 Window Control and Interaction Limitations
* **Unchanging resize cursors**: On Wayland environments (e.g., GNOME or KDE), hovering the cursor over the edge of the window might not change it to a "resize arrow" cursor. *(Note: Even if the cursor does not change, you can still resize the window by dragging the edges. On KDE, resizing with `Super` + Right Drag also works perfectly).*
* **Window movement workarounds**: If dragging the custom title bar to move the window does not work in your environment, please use standard Linux shortcuts such as `Alt` + Left Drag (or `Super` + Left Drag) to move the window.
* **Drag selection issues**: In certain environments (especially virtual machines or Wayland environments), selecting text by dragging the mouse may not work. You can work around this by `Clicking the start point` ➔ `Holding Shift and clicking the end point`.
* **Inverted scroll direction**: In rare cases, dragging the scrollbar may move the content in the opposite direction.

### 🎨 Rendering and Other Issues
* **Ghosting with translucent backgrounds**: If the application background is set to be translucent, residual text ghosting may occur. Scrolling or forcing a redraw will clear it. (This does not happen when the background is fully opaque).
* **Copy restriction in settings**: Due to multi-window limitations, copying text within the settings window may be disabled (pasting is still supported).
* **Search errors in the chat window**: Depending on your environment or search engine restrictions, the Web search functionality within the AI chat window may be blocked.

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



## NixOS Support (Building and Running MirrorShard 2)

Detailed instructions for developing, building, and running MirrorShard 2 on NixOS (and Wayland desktop environments), along with troubleshooting steps for NixOS-specific limitations.

### 1. Development and Build Environment (`nix develop`)

NixOS allows you to boot a temporary, self-contained development environment using the provided `flake.nix` in the repository root, without modifying your global system configuration. This automatically loads all necessary dependencies (Node.js, pnpm, Rust, WebKitGTK, GStreamer, glib-networking, GTK/GSettings schemas, etc.).

Run the following commands in your terminal at the repository root:

```bash
# Ensure flake.nix is tracked by Git, then start the development shell
git add flake.nix
nix develop
```

For first-time setup inside the shell, enable the stable Rust toolchain and configure your PATH:

```bash
rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"
```

Once the environment is ready, you can install dependencies and build or run the application as usual inside this shell:

```bash
# Install dependencies
pnpm install

# Run in development mode (with hot reloading)
pnpm tauri dev

# Build the release binary
pnpm tauri build
```

---

### 2. Clean Integration and System Execution (`nix build`)

If you run the compiled raw binary directly from outside the development shell (e.g., via desktop application launchers, keyboard shortcuts, or a standard terminal), the application will fail to load GTK themes, system fonts (GSettings schemas), or SSL certificates due to NixOS's file isolation. This can cause the GUI layout to break or API connections to fail.

To resolve this cleanly without polluting your global system configuration (`configuration.nix`), you can package the application with all its required environment variables pre-embedded using `nix build`.

1. Complete the standard build (`pnpm tauri build`) inside the development shell (`nix develop`).
2. Exit the development shell, and run the following build command using the raw directory path:
   ```bash
   nix build path:.
   ```

Once the build completes, a `./result` directory (symbolic link) will appear in your project root. The executable in this directory is a completely self-contained wrapper that **runs instantly with no delay** and loads all assets correctly.

To launch the application seamlessly from desktop environment launchers, create or edit `~/.local/share/applications/mirrorshard2.desktop` with the following content:

```desktop
[Desktop Entry]
Type=Application
Name=MirrorShard 2
# Point directly to the wrapped binary generated by nix build (instant launch with no latency)
Exec=/absolute/path/to/MirrorShard_2/result/bin/mirrorshard2 %F
Icon=/absolute/path/to/MirrorShard_2/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;
MimeType=text/plain;
```
*Note: Replace `/absolute/path/to/...` with the actual absolute path of your project directory.*

---

### 3. Troubleshooting (NixOS-Specific Issues)

#### ① AppImage build fails because linuxdeploy cannot find `/usr/bin/xdg-open`

Since NixOS does not conform to the standard FHS (Filesystem Hierarchy Standard) directory structure and lacks a global `/usr/bin` directory by default, the Tauri AppImage builder (linuxdeploy) may fail with an error. 

To resolve this, enable `envfs` by adding the following to your `/etc/nixos/configuration.nix` and rebuilding your system:

```nix
services.envfs.enable = true;
```

#### ② Windowing inconsistencies or rendering glitches in virtual machines or certain Nvidia+Wayland setups

If you encounter rendering glitches, window resizing issues, or misplaced popup menus under Wayland—particularly on certain virtual GPUs or Nvidia drivers—forcing the X11 compatibility layer (Xwayland) can resolve them.

Uncomment the following line in `src-tauri/src/lib.rs` and rebuild the application:

```rust
std::env::set_var("GDK_BACKEND", "x11");
```

*Note: Forcing X11 (Xwayland) will still function correctly under modern Wayland environments (such as KDE Plasma or Niri), including window resizing and popup positioning.*

#### ③ Limitations of Default Backgrounds and BGM in NixOS

In isolated filesystem environments like NixOS (Nix store), the application may fail to resolve the default paths for the standard background images and BGM files at startup.

* **Vertical Preview Background**:
  To prevent rendering inconsistencies, the default vertical preview background is automatically set to an eye-friendly "sepia color (#eae3d2)" on Linux.
  Additionally, NixOS does not support exporting from the vertical-writing preview screen (vertical-writing EPUB or HTML output); the export will fail. 
* **If you wish to use the default BGM or backgrounds**:
  You can still use them by manually browsing and loading the actual files from the application's resources directory within the Nix store (e.g., `/nix/store/...-mirrorshard2/bin/resources/`) using the file picker in the settings menu.


## Usage with Niri (Wayland Tiling Window Manager)

In tiling window manager environments like Niri, sub-windows (such as the Vertical Preview or AI Chat) are automatically arranged as tiled columns by default.

If you wish to set a fixed width for the preview or force specific sub-windows to open as floating windows by default, please add the following `window-rule` configurations to your `~/.config/niri/config.kdl`:

```kdl
// Configuration example for ~/.config/niri/config.kdl

// 1. Fix the column width for the Vertical Preview
window-rule {
    // For English UI : title="^Preview"
    // For Japanese UI: title="^プレビュー"
    match app-id="com.DroicheadNua.mirrorshard2" title="^Preview"
    default-column-width 600
}

// 2. Open the AI Chat window as a floating window by default
window-rule {
    // For English UI : title="^AI Chat"
    // For Japanese UI: title="^AIチャット"
    match app-id="com.DroicheadNua.mirrorshard2" title="^AI Chat"
    open-floating true
    default-floating-width 640
    default-floating-height 800
}
```

* **Automatic GPU Compositing**:  
  Previously on Linux (especially under Wayland or with NVIDIA graphics cards), GPU compositing frequently caused rendering glitches and had to be force-disabled. However, testing confirmed that GPU compositing runs smoothly under NixOS + Niri + GTX 1050Ti.  
  Accordingly, MirrorShard now automatically detects the Niri compositor (`NIRI_SOCKET`) and enables WebKitGTK GPU compositing. This significantly reduces CPU load and delivers smooth, flicker-free rendering with transparent windows and visual effects.  
  *Note: If you experience any rendering issues on your specific GPU/driver setup, you can manually force-disable GPU compositing by launching via terminal or desktop launcher with `MIRRORSHARD_DISABLE_COMPOSITING=1 mirrorshard2`.*

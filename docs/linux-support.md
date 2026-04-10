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
- SillyTavern integration
- OpenCode integration
- Typewriter sound
- Spotlight mode

---

## Known Issues

The following issues have been observed during testing:

### MX Linux (X11 / Xfce)
- Inline input does not work; IME falls back to over-the-spot mode  
  (composition text is shown in the IME window instead of the editor)

### Fedora (Wayland / GNOME, VM)
- Inline input works, but rendering artifacts may appear when using a transparent background  
  (cleared after redraw, e.g., scrolling; does not occur with opaque backgrounds)
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

```bash
# Clone repository
git clone https://github.com/DroicheadNua/MirrorShard_2.git
cd MirrorShard_2

# Install dependencies
pnpm install

# Build (release mode)
pnpm tauri build

After a successful build, installers will be generated under:

src-tauri/target/release/bundle/

🎵 BGM Feature and Performance

The behavior and memory usage of the BGM feature differ by OS:

Windows / macOS
Audio files (mp3/wav/ogg) are streamed from disk
Minimal memory usage
Linux (including Raspberry Pi)
Due to platform limitations, audio is fully loaded into memory
Higher memory usage when BGM is enabled

On low-spec environments (e.g., Raspberry Pi), disabling BGM is recommended if memory usage becomes an issue.


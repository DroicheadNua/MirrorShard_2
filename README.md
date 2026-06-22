[日本語](README-ja.md) | **English**

<details>
<summary><b>⚠️ [Windows] Important Notice: Missing first keystroke during IME input (Click to expand)</b></summary>

**[Windows] Known Issue: Missing first keystroke during IME input**
On Windows, users typing in languages that require an IME (Japanese, Chinese, etc.) may experience an issue where the first keystroke of a full-width space or composition is ignored. 
This is an OS-side rendering bug caused by a conflict between a recent WebView2 update and certain graphics drivers (especially NVIDIA).

Please try the following solutions:

**Solution 1: Update Graphics Drivers (Recommended)**
Update your NVIDIA or other graphics drivers to the latest version and restart your PC. In most cases, this completely resolves the issue.

**Solution 2: Use an Older WebView2 Runtime (If Solution 1 fails)**
If you cannot update your drivers or the issue persists, you can bypass the bug by forcing the app to run with an older, stable version of WebView2:
1. Download `MirrorShard_2.bat` attached to this release.
2. Go to the [Microsoft WebView2 Page](https://developer.microsoft.com/microsoft-edge/webview2/) and scroll to the bottom. Under **Fixed Version**, download version `148.0.3967.96` (Choose **x64** for most PCs, or **ARM64** for Surface/ARM devices).
3. Extract the `.cab` file and rename the extracted folder to `webview2_fixed`.
4. Place both `MirrorShard_2.bat` and the `webview2_fixed` folder in the same directory as the app's `.exe`.
5. Double-click `MirrorShard_2.bat` to launch the app using the bug-free runtime.

</details>
<br>

# MirrorShard 2

**MirrorShard — An Open-Source AI-Powered Integrated Writing Environment**

> From idea graph to structured draft — in one AI-powered outliner.

>💡 Use powerful AI features for free — no subscription required.

![MirrorShard_2 Key Visual](screenshots/ScreenShot-en2.jpg)

---

## ✨ Highlights

- 🧠 AI-powered writing, editing, and idea generation  
- 🌐 Supports multiple AI providers (Gemini, Groq, Mistral, Cohere)  
- 🖼️ **Generate images from text using Stable Diffusion**  
- 💬 AI chat with optional image generation (SD Link / Mistral Agents)  
- ✍️ Convert text into image prompts automatically  
- 📂 Works with both cloud AI and local AI  
- 💡 Designed for **free usage (no subscription required)**  

### 🖼️ AI Image Generation

Turn your ideas into images — AI writes the prompt for you.

- Generate images from selected text  
- Ask for images directly in AI chat  
- Works with Stable Diffusion (local) or Mistral Agents (cloud)  

---

## 🎥 Demo

Videos below demonstrate the English UI.

Watch MirrorShard in action:

### 🧠 Idea Expansion

https://github.com/user-attachments/assets/e19ec70f-4132-4859-8c04-04a1d44b9b06

### ✍️ Send to Editor

https://github.com/user-attachments/assets/fd28d3cb-3e05-4efb-8bd1-f551d77f3c31

### 🖼️ AI Image Generation(Stable Diffusion / SD-Link)

https://github.com/user-attachments/assets/d8be1190-e2af-4fd4-aa27-73a6fd11a349

---

## 🚀 Getting Started

New users should begin here:

👉 [docs/quick_guide.md](docs/quick_guide.md)

---

## 💡 Free AI Usage Guide

Learn how to use MirrorShard with **no cost**:

👉 [docs/free-ai-guide.md](docs/free-ai-guide.md)

---

## ✨ What is MirrorShard?

MirrorShard is an AI-powered outliner that transforms fragmented ideas into structured writing.

Generate ideas, connect them, and turn them into a draft — all in one place.

---

## 🚀 Core Workflow

1. Generate ideas (AI Free Association)
2. Connect them (Missing Link / Node Alchemy)
3. Convert to structured text (Send to Editor)
4. Continue writing with AI assistance

---

## ⚡ Why MirrorShard?

* Combines brainstorming, outlining, and writing
* Graph → Markdown pipeline
* Lightweight (<10MB, Tauri-based)
* Built for actual writing, not just note-taking

---

## 📦 Download

👉 [Latest Release](https://github.com/DroicheadNua/MirrorShard_2/releases/latest)

Prebuilt binaries are available for Windows, macOS, and Linux.

---

## 📚 Documentation

Full feature list and usage:

👉 [docs/features.md](docs/features.md)

---

## 📰 Media Coverage

Featured on **Mado no Mori (Impress Watch)**
https://forest.watch.impress.co.jp/docs/news/2091824.html

---

## ⚠️ Known Issues

See details on the Releases page.

---

## ⚠️ Notes

* UTF-8 (without BOM) is strongly recommended
* Some encodings may cause garbled text or data loss

👉 See details: [docs/notes.md](docs/notes.md)

---

## 📝 License

MIT License

---

## 👤 Author

Copyright (c) 2025–2026 DroicheadNua
Email: [mirrorshard.dev@gmail.com](mailto:mirrorshard.dev@gmail.com)
X: @mirrorshard_dev
GitHub: https://github.com/DroicheadNua/MirrorShard_2

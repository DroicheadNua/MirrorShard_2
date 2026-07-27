# Troubleshooting & FAQ

### Q. I’m not sure how to use the app.

**A.** Press **F1** to open the shortcut list and operation guide.

---

### Q. The macOS version won’t launch. I see a message like “MirrorShard is damaged and can’t be opened.”

**A.**

This happens because MirrorShard is not notarized by Apple, so macOS Gatekeeper blocks it as an unidentified app.

**Solution 1: Allow manually from System Settings (Recommended)**
*(May not work on some macOS versions)*

1. Double-click `MirrorShard.app` in the Applications folder.
2. When the error appears, click **OK**.
3. Go to:
   **Apple Menu → System Settings → Privacy & Security**
4. Scroll down and find the message:
   *“MirrorShard was blocked to protect your Mac.”*
5. Click **Open Anyway**.

After this, the app will be whitelisted and can be opened normally.

---

**Solution 2: Remove quarantine via Terminal (More reliable)**

If the above option doesn’t appear:

1. Open **Terminal**
2. Run the following command:

```
xattr -d com.apple.quarantine
```

3. Then drag & drop `MirrorShard 2.app` into the Terminal window
   (this ensures the correct path is used)

Or manually:

```
xattr -d com.apple.quarantine "/Applications/MirrorShard 2.app"
```

4. Press Enter

If no message appears, it succeeded.

---

**Alternative cause (rare): conflict with old version**

If you previously installed the Electron version of MirrorShard:

1. Delete the old `MirrorShard.app`
2. Re-download MirrorShard 2
3. Launch it via **Right-click → Open** on first run

---

### Q. Japanese IME behavior is strange (e.g., the first keystroke of a full-width space disappears).

**A.** This may be a rendering issue caused by a compatibility glitch between Windows Update (WebView2) and graphics drivers (especially NVIDIA).

#### Solution 1: Update Graphics Drivers (Recommended)
Update your graphics driver (NVIDIA / AMD / Intel) to the latest version and restart your PC.

#### Solution 2: Apply a Fixed WebView2 Runtime
1. Create a batch file named `MirrorShard_2.bat` in the same directory as `mirrorshard2.exe` with the following content:
   ```
   @echo off
   cd /d "%~dp0"
   set WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=%~dp0webview2_fixed
   start "" "mirrorshard2.exe"
   ```
2. Download fixed WebView2 runtime CAB file (e.g. `148.0.3967.96`) from Microsoft, extract it, and rename the folder to `webview2_fixed`.
3. Place `webview2_fixed` in the same directory as `mirrorshard2.exe` and launch via `MirrorShard_2.bat`.

---

### Q. The text is garbled or unreadable.

**A.** The file may use an unsupported encoding.
To avoid corruption, close the file **without saving**.
See *notes-ja.md → Encoding* for details.

---

### Q. Keyboard shortcuts don’t work or conflict with the OS.

**A.** Some Linux desktop environments override certain shortcuts (e.g., Ctrl+H).
Please either:

* Change the OS shortcut settings
* Or use the UI buttons instead

---

### Q. Pressing F1/F2 triggers media keys instead.

**A.** Your function keys may be locked.

Try:

* **Fn + Esc** (common)
* **Fn + W** (varies by device)

Check your keyboard/manual if needed.

---

### Q. Changing the background color has no effect.

**A.** Disable the background image.
If an image is set, it overrides the background color.

---

### Q. Can I use cloud sync or multiple devices?

**A.** MirrorShard does not include built-in cloud sync, but works well with external services.

**Simple method:**
Save files inside a synced folder such as:

* iCloud Drive
* Google Drive
* OneDrive

**Advanced method (recommended for power users):**
Use version control tools like Git (e.g., GitHub Desktop).

This allows:

* Backup
* Version history
* Reliable multi-device sync

---

### Q. Why does the file “creation date” change when I overwrite a file?

**A.** This is due to **atomic saving**, a safety feature.

MirrorShard saves files like this:

1. Writes data to a temporary file
2. Replaces the original file with it

This prevents corruption in case of crashes or power loss.

Because of this, the OS treats it as a “new file,” so the creation date updates.

---

### Q. Can I preserve the original creation date?

**A.** Not directly.

If needed:

* Keep a backup copy
* Or record the creation date inside the document

---

## AI-related

### Q. Why doesn’t MirrorShard auto-complete text in real time?

**A.**

MirrorShard is designed with the philosophy:

> *“AI is a tool — the user should always remain in control.”*

Unlike many AI editors:

* It does **not** monitor text in the background
* It does **not** send data automatically

AI is only triggered when you explicitly request it.

**Benefits:**

* You keep full control of your thinking process
* No unwanted AI interference
* No unintended data transmission

Trade-off:

* Responses may take a few seconds

---

### Q. AI responses are cut off midway.

**A.** This usually happens when the **max response length is too small**.

Increase the response length in settings.

For reasoning models (e.g., Gemini Flash / Thinking models):
→ Recommended: **3000–5000 tokens or more**

---

## Terminal

### Q. Running `pnpm dev` causes MODULE_NOT_FOUND (Windows)

**A.** This is due to symlink resolution issues.

Create `.npmrc` in your project root:

```
node-linker=hoisted
```

Then:

1. Delete `node_modules`
2. Run `pnpm install` again

---

### Q. PowerShell says script execution is disabled (Windows)

**A.** This is due to Windows execution policy restrictions.

Options:

* Use Git Bash (`bin/bash.exe`) in settings
* Or change PowerShell execution policy

(Refer to Microsoft documentation)

---

### Q. The AI Agent's Web Search fails or returns an error on Linux.

**A.** Due to DuckDuckGo's strict anti-bot measures, requests from Linux environments (which have specific TLS/OpenSSL fingerprints) are currently being blocked. (It works fine on Windows).
We are planning to integrate a stable Search API (like Tavily API) in the next update. We apologize for the inconvenience and appreciate your patience.

## OpenCode

### Q. OpenCode doesn’t launch (Ctrl+Shift+K)

**A.** Check your environment variables.
OpenCode may not be added to your system PATH.

---

## SillyTavern

### Q. The browser opens automatically on launch

**A.** Edit `config.yaml` in the SillyTavern folder:

```
browserLaunch:
  enabled: false
```

---

## Other

### Q. Why does the code editor support Rust but not C++ or Java?

**A.** Because about 9% of MirrorShard is written in Rust.

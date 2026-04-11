# MirrorShard 2 v1.7.0 User Manual

## Keyboard Shortcuts

This application allows you to perform almost all operations using keyboard shortcuts.

---

### ◯ File Operations

New File     Ctrl + N (Cmd + N) Create a new tab
Open File    Ctrl + O (Cmd + O) Open the file selection dialog
Open Folder of Current File Ctrl + Shift + O (Cmd + Shift + O) Open the folder containing the currently selected file
Save File    Ctrl + S (Cmd + S) Overwrite the current file
Quit Application Ctrl + Q (Cmd + Q) Exit the application

---

### ◯ View

Show Shortcut List F1 Open the shortcut list
AI Chat Window  Ctrl + Shift + A (Cmd + Shift + A) Open the AI chat window
Idea Processor  Ctrl + I (Cmd + I) Open the Idea Processor
Toggle Dark Mode Ctrl + T (Cmd + T) Switch between light and dark mode
Markdown/HTML Preview Ctrl + M (Cmd + M) Open the preview window
Code Editor Mode Ctrl + K (Cmd + K) Switch to code editor mode
Toggle ZEN Mode Ctrl + Shift + C (Cmd + Shift + C) Hide all UI except the text area
Vertical Writing Preview Ctrl + P (Cmd + P) Open vertical writing preview
Toggle Spotlight Mode Ctrl + L (Cmd + L) Blur everything except the current section
Minimize Window Ctrl + H (Cmd + H) Minimize the window
Toggle Fullscreen F11 (Cmd + Ctrl + F) Toggle fullscreen mode

Switch Document Ctrl + Tab
Switch Document (Reverse) Ctrl + Shift + Tab Switch between open documents
  ※ You can also use mouse back/forward buttons if available

Snow Effect  Ctrl + Shift + E Toggle snowfall effect on/off

Open OpenCode Ctrl + Shift + K Launch OpenCode (must be installed)
Open SillyTavern Ctrl + Shift + J Launch SillyTavern (must be installed)

---

### ◯ Edit / Settings

Increase Font Size Ctrl + + (Cmd + +) Increase font size
  ※ Numpad "+" may not work in the main window

Decrease Font Size Ctrl + - (Cmd + -) Decrease font size

Reset Font Size Ctrl + 0 (Cmd + 0) Reset to default (16pt)
  ※ Numpad "0" may not work

Switch Font Ctrl + Shift + F (Cmd + Shift + F)
 Cycle through: sans-serif → monospace → serif
 (The actual fonts depend on your system)

Play / Stop BGM Ctrl + Shift + P (Cmd + Shift + P)
Toggle Typing Sound Ctrl + Shift + T (Cmd + Shift + T)

Settings F2 Open settings window

Open Terminal Ctrl + @
Open Terminal in Current File Location Ctrl + Shift + @

Export Ctrl + E (Cmd + E) Open export window

---

### ◯ Basic Editing

Undo Ctrl + Z (Cmd + Z)
Redo Ctrl + Y (Cmd + Shift + Z)

Cut Ctrl + X (Cmd + X)
Copy Ctrl + C (Cmd + C)
Paste Ctrl + V (Cmd + V)
Select All Ctrl + A (Cmd + A)

Find / Replace Ctrl + F (Cmd + F)

Go to Start of Document Ctrl + ↑ (Cmd + ↑)
Go to End of Document Ctrl + ↓ (Cmd + ↓)

AI Generate / Code Completion Alt + Enter (Option + Enter)
 Generate text continuation or complete code from the cursor position

AI Insert Text Alt + Shift + Enter (Option + Shift + Enter)
 Insert AI-generated text based on surrounding context

Cancel AI Task ESC Stop AI generation

Simple Formatter (Code Editor Mode only) Alt + Shift + F
 Format indentation across the entire file

---

## Context Menu

* Open Recent Files

* Open File

* Save File

* Save As

* Undo

* Redo

* Cut

* Copy

* Paste

* Select All

* Count Characters in Selection

* AI: Translate
   Translate the selected text using AI

* AI: Summarize
   Summarize the selected text using AI
   A dialog will appear where you can specify the target length

* AI: Rewrite
   Rewrite the selected text using AI

* Import Gemini Logs
   Import conversation logs from Gemini

* Open Terminal Here
   Open a terminal in the same directory as the current file

* Open Folder Here
   Open the folder containing the current file

---

## Search Window

Press **Ctrl + F** (Cmd + F on Mac) to open the search window.

### Fields

* **Find**
   Enter the keyword to search for

* **Replace**
   Enter the replacement text

---

### Navigation

* **Next / Previous**
   Jump to the next or previous match

* **All**
   Select all matches

---

### Shortcuts

* Next  F3 (Mac: Cmd + G)
* Previous Shift + F3 (Mac: Cmd + Shift + G)

---

### Replace

* **Replace / Replace All**
   Replace the current match / all matches

---

### Options

* **Match Case**
   Case-sensitive search (e.g., "Book" ≠ "book")

* **Regexp**
   Enable regular expression search
   (e.g., `^#` to match headings at the beginning of a line)

* **Whole Word (by word)**
   Match only complete words
   (e.g., searching "cat" will not match "category")

---

### Close

Press **ESC** or click the **× button** to close the search panel.

---

## How to Use AI Features

MirrorShard includes several types of AI-powered features:

* **Integrated AI features** used within the main editor
* **AI Chat Window**, which opens in a separate window
* **Four AI features built into the Idea Processor**
* **OpenCode** (external tool integration)
* **SillyTavern** (external tool integration)

For detailed instructions, please refer to:
**AI Feature Guide (ai-guide.md)**

---

## Idea Processor

The Idea Processor is a feature designed to help you visually organize your thoughts, similar to a mind map.

You can freely place ideas as nodes on a canvas, connect them, and develop them into larger structures. It is useful for tasks such as plot planning, organizing character relationships, brainstorming, and more.

For detailed instructions, please refer to:
**Idea Processor Guide (idea-processor.md)**

---

## Export

You can open the export window by pressing **Ctrl + E (Cmd + E on Mac)**.

This window supports **horizontal (left-to-right) export only**.
If you want to export vertical writing, please use the **Vertical Writing Preview**.

---

### Features and Options

* **Print / Save as PDF**
   Export the document as a PDF file or print it using your printer.
   Ruby annotations are supported.

* **Save as DOCX (Word)**
   Export the document as a DOCX file (horizontal layout).
   ※ Requires Pandoc. See **Pandoc Setup Guide (pandoc-guide.md)** for installation.

* **Save as HTML**
   Export the document as an HTML file (horizontal layout).

* **Save as EPUB**
   Export the document as an EPUB file (horizontal layout).

---

### Formatting Options

* **Font**
   Select from Serif, Sans-serif, or Monospace

* **Font Size**
   Adjust the font size

* **Line Spacing**
   Adjust the line spacing

---

## Vertical Writing Preview

This is a vertical writing preview that supports **Aozora Bunko-style ruby annotations**.

You can also export your document in vertical format (**HTML / EPUB**) from this view.

※ Pandoc is required for vertical export.
 See **Pandoc Setup Guide (pandoc-guide.md)** for installation instructions.

※ Direct printing or PDF export in vertical writing is **not supported**.
 To print or save as PDF, export as HTML and open it in a web browser.

---

### Features and Controls

* **Export**
   Export the document in vertical format (HTML / EPUB)
   Ruby annotations are supported

* **Refresh**
   Update the preview

* **Always on Top**
   Keep the preview window always on top

---

## Markdown / HTML Preview

Open the preview window using the UI button or by pressing **Ctrl + M (Cmd + M on Mac)**.

You can switch between **Markdown mode** and **HTML mode** using the dropdown menu at the top.

---

### Features and Controls

* **Zoom**
   Use **Ctrl + Mouse Wheel** or **Ctrl + +/-** to zoom in/out
   Press **Ctrl + 0** to reset

* **Outline Synchronization**
   Clicking an item in the editor’s outline will automatically scroll the preview to the corresponding section

* **Copy as HTML Source**
   Copy the currently displayed content, including HTML tags, to the clipboard
   Useful for blogging or web publishing

* **Save as HTML**
   Save the current preview as an HTML file

* **Open DevTools**
   Open developer tools

* **Open in Browser**
   Open the current file in your default web browser (e.g., Chrome, Edge)
   ※ Please save the file before using this feature

* **Always on Top**
   Keep the preview window always on top

* **Refresh (Ctrl + R)**
   Update the preview

---

### Specifications and Limitations

* **Layout Accuracy**
   The preview uses a lightweight browser engine, so some layouts may not render correctly
   (e.g., legacy CSS or layouts requiring specific screen widths)
   Use **“Open in Browser”** for accurate rendering

* **Link Behavior**
   Clicking links in the preview:
   ・Web links (http/https) open in your default browser
   ・Local file links open as a new tab in MirrorShard

* **External Scripts**
   For security reasons (CSP), external JavaScript and CSS are restricted

* **Large Text Files**
   When previewing text exceeding 50,000 characters, only the beginning portion is displayed to maintain performance

* **Code Blocks**
   Very long or complex code blocks may not render correctly in Markdown mode
   In such cases, using **Code Editor Mode (Ctrl + K)** is recommended

---

### Previewing Web Frameworks (Astro / Next.js, etc.)

The HTML preview is designed for **static HTML files**.

Dynamic path resolution used in frameworks like Astro or React
(e.g., root-based paths to the `public` folder or `import` statements)
may not work correctly in the preview
(e.g., images not displaying, links not working).

For such projects, it is recommended to:

1. Open the built-in terminal (**Ctrl + @**)
2. Run a local development server (e.g., `npm run dev`)
3. View the result in a web browser

---

## Code Editor Mode

You can switch to Code Editor Mode by pressing **Ctrl + K (Cmd + K on Mac)**.

This is a simple code editor with support for the following languages:
**HTML / CSS / JavaScript / TypeScript / Markdown / Rust / Python**

In addition to syntax highlighting, the following features are available:

* Auto Indent
* Code Folding
* Auto Close Brackets
* Keyword Completion (basic auto-complete)

---

### Simple Formatter (Alt + Shift + F)

Automatically formats indentation across the entire file
(Available only in Code Editor Mode)

※ Internally, this feature performs a “Select All → Format” operation.
After execution, using **Undo** may temporarily return the text to a fully selected state.
This is expected behavior.

---

### AI Code Completion (Alt + Enter)

Press **Alt + Enter** in Code Editor Mode to generate code using AI.

For more details, please refer to:
**AI Feature Guide (ai-guide.md)**

---

## Built-in Terminal

Press **Ctrl + @** to open or close a semi-transparent terminal window within the editor.

This is useful for running Git commands or working with Node.js projects while writing.

---

### Features

* **Shell**
   On Windows, PowerShell (or Git Bash) is used.
   On macOS / Linux, the default system shell is used.
   You can change the shell path in the settings.

 ※ To use Git Bash, specify: `bin\bash.exe`
 ※ When using Git Bash, errors may occur due to compatibility issues with `pnpm` symbolic links.
  See the FAQ for workarounds.

* **Open Terminal Here**
   Right-click a tab and select **“Open Terminal Here”** to open the terminal in the same directory as the current file

* **Font Synchronization**
   The font settings from Code Editor Mode are also applied to the terminal

* **Exit Command**
   Type `exit` to close the terminal window

---

## OpenCode

If OpenCode is installed, it can be launched in a separate window using **Ctrl + Shift + K**.

OpenCode is an open-source AI coding agent.
For usage instructions, please refer to the OpenCode documentation.

※ This feature assumes that OpenCode is installed in a standard system path.

---

## SillyTavern

If SillyTavern is installed, it can be launched in a separate window using **Ctrl + Shift + J**.

SillyTavern is an AI chat interface specialized for roleplay.
It can also be used to support novel writing by allowing you to:

* Store detailed character profiles (including images and expressions)
* Have AI roleplay as your characters in chat form

For usage instructions, please refer to the SillyTavern documentation.

※ It is recommended to set the following in `config.yaml` inside the SillyTavern folder:

```
browserLaunch:
  enabled: false
```

Without this setting, the same interface may open both in your default browser and in the editor window simultaneously.

---

## Status Bar

The status bar at the bottom of the screen displays the following information (from left to right):

* Current outline item
* Path of the currently opened file
* Cursor position (line : column) / total number of lines
* Total character count
* Encoding and line ending of the current file
* Current date and time

---

## Settings

Open the settings window by pressing **F2** or clicking the gear icon at the top of the screen.

---

### ■ General

#### Editor Settings

* **Maximum Editor Width**
   Set the maximum width of the editor area

* **Line Height**
   Adjust line spacing

* **Editor Side Margins**
   Adjust left and right margins of the editor

* **Japanese Line Breaking Rules (Kinsoku Shori)**
   Adjust the strictness of Japanese line-breaking rules

* **Background Image**
   Load a custom background image
   ※ Available in light mode only

* **BGM**
   Load custom background music

* **Word Wrap**
   Enable or disable word wrapping for Western text

* **Font**
   Load and select fonts from your system

* **Pandoc Path**
   Specify the path to Pandoc
   If installed normally, this can be left empty
   Pandoc is required for vertical export

---

#### Editor Appearance

You can freely customize the editor’s appearance, including:

* Background color
* Transparency
* Blur (glass effect) intensity

You can also select preset themes from **Theme Presets**, such as:

* Default
* Paper
* Tokyo Night

In addition, you can create, save, and delete your own custom themes.

---

### ■ AI Settings

#### Cloud AI

* **Gemini API Key**
   Enter your Gemini API key to enable interaction with Gemini

* **Gemini Model**
   Select the Gemini model
   ※ Depending on the model and pricing plan, usage fees may apply

* **Groq API Key**
   Enter your Groq API key to enable interaction with Groq

* **Enable Groq**
   Toggle whether Groq appears in the AI selector

* **Groq Model**
   Select the Groq model
   ※ Depending on the model and pricing plan, usage fees may apply

※ Cohere and Mistral settings are similar to Groq

---

#### Local LLM

* **Endpoint URL**
   Specify the API endpoint URL of the LLM
   You can load default values for LM Studio, Ollama, and koboldcpp from the dropdown menu

* **Model Name**
   Specify the model name
   Required for Ollama
   Ignored in LM Studio (the model is selected within LM Studio itself)

---

#### SillyTavern Path (Folder)

* Specify the installation folder of SillyTavern

---

#### Behavior

* **Max Output Tokens**
   Set the maximum length of AI responses
   (Approx. 1 Japanese character ≈ 2 tokens)

 ※ When using models like Gemini 2.5, additional tokens may be consumed internally for reasoning
  It is recommended to set a higher value

* **AI Association Response Length**
   Set the maximum response length for AI Free Association in the Idea Processor

* **Context Length**
   Set the length of context sent to the AI

* **AI Thinking Effect**
   Toggle visual effects (overlay) while the AI is generating a response

* **System Prompt**
   Set the system prompt

---

#### User Profile

* **Name**
   Set the user name displayed in the chat

* **Icon**
   Set the user icon displayed in the chat

---

#### AI Profile

* **Name**
   Set the AI name displayed in the chat

* **Icon**
   Set the AI icon displayed in the chat

---

### ■ Code Editor

#### Code Editor Settings

* **Syntax Highlight Language**
   Specify the language used for syntax highlighting in Code Editor Mode
   Normally detected automatically based on file extension

 Currently supported languages:
 **HTML / CSS / JavaScript / TypeScript / Markdown / Rust / Python**

* **Font**
   Set the font used in Code Editor Mode

* **Font Size**
   Set the font size used in Code Editor Mode

* **Word Wrap**
   Enable or disable line wrapping within the editor

---

#### Markdown Preview

* **Hard Breaks**
   Configure Markdown hard break behavior

---

#### Terminal Settings

* **Shell Path**
   Specify the shell to use
   If left empty:
   ・Windows: PowerShell
   ・macOS / Linux: Default system shell

 ※ To use Git Bash, specify: `bin\bash.exe`

* **Startup Directory**
   Set the default directory when opening the terminal
   If left empty, the user’s home directory is used

---

## Limitations on Linux

Some features are currently unavailable in the Linux version.

For details, please refer to:
**linux-support.md**

---








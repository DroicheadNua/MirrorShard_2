# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.10.0] - 2026-05-30

### Added
    Added native support for OpenRouter.

    Added web search support via Tavily API and redesigned the search feature UI.

### Changed
    Improved the scrolling behavior in the main editor's side pane and the settings window.

### Fixed
    Updated the default Gemini preset from gemini-3.1-flash-lite-preview to gemini-3.1-flash-lite (due to the deprecation of the preview model).

    Fixed an issue where the scrollbar in the settings window interfered with window dragging.

    

## [1.9.0] - 2026-5-6  

### Added  
- Integrated Rig (a Rust-based agent framework) as the backend.  
By integrating with the headless browser "Obscura" (https://github.com/h4ckf0r0day/obscura), users can perform web searches using any AI (including local ones).  
 - * Specify the path to the Obscura executable file in the settings screen and enable the "Search" button in the chat screen to launch it (*Cohere and Cerebras are not supported)  
- Added support for new AI providers: Cerebras API  
- Added support for stable-diffusion.cpp  

### Changed    
 

### Fixed   


## [1.8.0] - 2026-4-27  

### Added  
- **Stable Diffusion integration (Ctrl+Shift+W)**  
  - Supports AUTOMATIC1111, Forge, and Forge Neo (ComfyUI not supported)  
  - Generate images directly from AI chat or editor text  
  - Automatically sends prompts to Stable Diffusion via API and displays results in-app  

- **AI-powered image generation (Chat)**  
  - When "SD Link" is enabled, the AI generates structured prompts and triggers image generation  
  - Generated images are saved to a user-defined folder and displayed in the chat  

- **AI-powered image generation (Editor)**  
  - Generate images from selected text  
  - AI converts text into prompts and inserts image links at the cursor position  

- Added minimize and maximize buttons to the built-in terminal  

- Added "Generate Image Prompt" to the editor AI menu (right-click on selected text)  


### Changed  
- Multiple terminal instances can now run simultaneously  
- Improved SillyTavern launch process  
- Added option to show/hide terminal when launching SillyTavern (Windows only)  


### Fixed  
- Fixed an issue where clicking URLs in the AI chat window caused navigation inside the app  
  - Links now open in the default browser  


## [1.7.1] - 2026-4-14  

### Changed
- Optimized build configuration

### Fixed
- Fixed an issue where language settings were not correctly applied to some windows on Windows
- Minor documentation updates


## [1.7.0] - 2026-04-12

### Added

* Added i18n support and implemented an English UI (switchable from settings)
* Resumed distribution of Linux and Raspberry Pi builds
* Added support for new AI providers: Cohere and Mistral (available in main editor, AI chat, and idea processor)
* Added Gemini models: Gemini 3.1 Flash-Lite Preview and Gemini 3 Flash Preview (default set to 3.1 Flash-Lite Preview)
* Added English documentation

### Changed

* Expanded AI translation feature in the main editor from EN↔JA only to support arbitrary languages
* Disabled some features on Linux (OpenCode integration, SillyTavern integration, Spotlight mode, typing sound, Markdown/HTML preview) due to instability
* Enabled auto-save for AI chat
* AI chat: input field now regains focus after receiving a response

### Fixed

* Fixed an issue where user-defined system prompts were not applied in AI features (main editor and idea processor)
* Fixed Linux startup process; now works conditionally on NVIDIA GPUs and Wayland environments (see docs/linux-support-ja.md for details)
* Fixed invalid default value for Groq model
* Fixed overly tight line spacing in AI chat window

---

## [1.6.0] - 2026-03-29

### Added

* Implemented SillyTavern integration (launch with Ctrl+Shift+J if installed)
* Added "IP Missing Link" AI feature to idea processor (generates bridging content between linked nodes)
* Added "Node Alchemy" AI feature to idea processor (generates new nodes based on selected nodes)

### Changed

* Removed ruby conversion in Markdown preview
* Removed kimi-k2-instruct-0905 from model list due to deprecation
* Refactored documentation in preparation for internationalization

### Fixed

* Fixed duplication issue in AI Free Association when no truncation occurred
* Fixed processing for new file creation and Send to Editor

---

## [1.5.0] - 2026-03-22

### Added

* Added support for Groq API
* Added DOCX export to export window
* Implemented OpenCode integration (launches `opencode serve` with Ctrl+Shift+K if globally installed)
* Added "Template Completion" AI feature to idea processor

### Fixed

* Added missing `html lang="ja"` in some windows
* Fixed font configuration issues

---

## [1.4.1] - 2026-03-16

### Fixed

* Fixed node position calculation not considering zoom (idea processor)
* Fixed display issue for English node titles (idea processor)

---

## [1.4.0] - 2026-03-14

### Added

* Implemented idea processor (feature parity with Electron version nearly complete)
* Added ruby/dash/ellipsis insert buttons and moved undo/redo to outline pane
* Added "Missing Link Completion" AI feature to main editor

### Changed

* Idea processor updates:

  * Node background color changes only when group is selected
  * Enabled printing
  * Added dedicated AI selector
  * Renamed "Chain of Thought" → "AI Free Association"
  * Synced light mode UI with main editor
* Added koboldcpp default endpoint to Local LLM dropdown
* Made AI context length configurable

### Fixed

* Fixed issue allowing typing during AI generation
* Fixed OS shortcut handling in subwindows

---

## [1.3.0] - 2026-03-02

### Changed

* Made settings window resizable
* Added toggle for Markdown hard breaks
* Auto-hide Markdown frontmatter
* Update previews on save
* Renamed docs files to English (to avoid encoding issues)

### Fixed

* Fixed unintended indentation when opening terminal
* Fixed scrollbar color mismatch in AI chat

---

## [1.2.0] - 2026-02-22

### Added

* Added word wrap setting for code editor mode
* Added simple formatter (Alt+Shift+F)
* Added "Open Folder Here" to context menu
* Added shortcut for "Open Terminal Here"

### Changed

* Updated Tauri (2.9.3 → 2.10.2)
* Adjusted macOS fullscreen behavior (Simple Fullscreen)
* Replaced BGM with original track and optimized assets (~50% size reduction)
* Optimized startup process
* Included background images in theme presets
* Made code editor background opaque

### Fixed

* Fixed Spotlight mode issues
* Improved selection behavior on macOS
* Fixed syntax highlight initialization issue
* Fixed mode restore issue on exit

---

## [1.1.0] - 2026-02-15

### Added

* Added AI writing feature (Alt+Enter)
* Added AI actions (summarize/rewrite/translate) via context menu
* Added AI code completion
* Added color picker and background customization
* Added user theme management
* Added terminal (Ctrl+@)
* Added "Open Terminal Here"
* Added character count for selection
* Added snowfall effect

### Changed

* Enabled local image support in preview
* Enabled DevTools for preview
* AI chat now restores previous session
* Unified AI chat color scheme

### Fixed

* Fixed auto-indent in code editor
* Improved search panel colors

---

## [1.0.0] - 2026-02-07 (Initial Release)

### Added

* Markdown/HTML preview (Ctrl+M)
* Vertical writing export (EPUB/HTML via Pandoc)
* Always-on-top vertical preview
* Code editor mode

### Changed

* Show full outline text on hover
* Set minimum window size for subwindows

### Fixed

* Disabled default context menu in some subwindows
* Fixed BGM pause issue
* Minor color fixes

---

## [0.5.0] - 2026-01-31

### Added

* AI chat window (Gemini + local LLM support)
* Gemini log import
* Shortcut list window (F1)

---

## [0.4.0] - 2026-01-24

### Added

* ZEN mode
* Vertical preview with ruby support
* Export (PDF/HTML/EPUB, horizontal only)
* Adjustable editor margins

### Fixed

* Fixed fullscreen exit issue
* Fixed blur effect initialization
* Improved Windows settings UI
* Fixed IME underline issue on Windows

---

## [0.3.0] - 2026-01-17

### Added

* Transparent window & UI customization
* Enhanced status bar
* Expanded settings (fonts, word wrap)

### Changed

* Adjusted settings UI layout

### Fixed

* Fixed unintended cursor movement when switching tabs with mouse buttons

---

## [0.2.0] - 2025-12-02

### Added

* Tab cycling
* Typing sound
* Spotlight mode
* Recent files menu
* Atomic save
* Settings window

### Changed

* Optimized startup process
* Improved initialization flow

### Fixed

* Fixed undo/redo cursor jump
* Fixed "Save As" behavior
* Fixed highlight sync issue
* Fixed file opening issue on macOS

---

## [0.1.0] - 2025-11-22

* Initial Beta release
* Migrated from Electron to Tauri
* Improved startup speed and reduced memory/binary size
* Redesigned UI

// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use epub_builder::{EpubBuilder, EpubContent, ReferenceType, ZipLibrary};
use font_kit::source::SystemSource;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_cli::CliExt;
use tauri_plugin_window_state::{Builder, StateFlags};

// PTYの入力側を保持する構造体
struct TerminalState {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}
// --- FileEntry構造体の定義 ---
#[derive(serde::Serialize, Clone)] // Cloneを追加すると後で便利
struct FileEntry {
    name: String,
    path: PathBuf,
    is_dir: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    content: String,
    encoding: String,
    line_ending: String,
}
#[derive(serde::Deserialize)]
struct EpubSection {
    title: String,
    content: String,
}
// Mutexでラップして、スレッドセーフにする
struct InitialFile(Mutex<Option<String>>);
// 2回目に開かれたファイルパスを保持するための状態
struct SecondInstanceFile(Mutex<Option<String>>);
// ★ Mac用のファイルパス保持場所
struct MacFileBuffer(Mutex<Option<String>>);
// --- Tauriコマンドの定義 ---

#[tauri::command]
fn set_simple_fullscreen(window: tauri::WebviewWindow, enable: bool) {
    // macOSではSimple Fullscreen、他では通常のFullscreenとして振る舞う
    let _ = window.set_simple_fullscreen(enable);
}

#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.label() != "markdown" {
        return;
    }
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

// 1. Terminalを開くコマンド
#[tauri::command]
async fn open_terminal_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("terminal") {
        // すでに存在する場合は閉じる。
        // close() の結果を待たずに、既存のインスタンスを葬る
        let _ = window.close();
    } else {
        // ウィンドウ作成（設定は他と同じ）
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "terminal",
            tauri::WebviewUrl::App("terminal.html".into()),
        )
        .title("")
        .inner_size(640.0, 480.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .visible(false)
        .devtools(false);

        #[cfg(any(windows, target_os = "macos"))]
        let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![],
            state: None,
            radius: Some(24.0),
            color: None,
        });

        #[cfg(debug_assertions)]
        let _ = builder.devtools(true).build();
        #[cfg(not(debug_assertions))]
        let _ = builder.build();
    }
}

// 2. PTY初期化 (terminal.ts から呼ばれる)
#[tauri::command]
fn init_pty(
    app: AppHandle,
    state: State<TerminalState>,
    rows: u16,
    cols: u16,
    shell_path: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    // 新しい PTY を作る前に、既存の状態を確実にクリアする
    {
        let mut w = state.writer.lock().unwrap();
        *w = None;
    }
    {
        let mut m = state.master.lock().unwrap();
        *m = None;
    }
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // シェルの決定
    let cmd = if let Some(path) = shell_path {
        if path.is_empty() {
            default_shell()
        } else {
            path
        }
    } else {
        default_shell()
    };

    let mut cmd_builder = CommandBuilder::new(cmd);

    // CWDの設定
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd_builder.cwd(dir);
        }
    }

    // 環境変数の設定 (文字化け対策などで重要)
    if cfg!(target_os = "windows") {
        cmd_builder.env("TERM", "cygwin");
    } else {
        cmd_builder.env("TERM", "xterm-256color");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd_builder)
        .map_err(|e| e.to_string())?;

    // 1. Writerの取得 (Masterから)
    // take_writer は &mut self を取るので、先に reader をクローンするか、順序に注意
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // 2. Readerの取得 (★修正: SlaveではなくMasterから取得)
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // ----------------

    // Stateに保存
    *state.writer.lock().unwrap() = Some(writer);
    *state.master.lock().unwrap() = Some(pair.master);

    // 読み取りスレッド開始
    let app_clone = app.clone();

    thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_clone.emit("terminal-data", output);
                }
                _ => {
                    // 自動で閉じようとせず、単にループを抜けてスレッドを終了させる
                    println!("PTY Reader thread finished.");
                    break;
                }
            }
        }
    });

    // プロセス終了監視スレッド
    let app_clone_exit = app.clone();
    thread::spawn(move || {
        // child.wait() はプロセスが終了するまでここでブロック（待機）する
        let _ = child.wait();

        println!("Shell process exited!");

        // 終了したらフロントエンドに通知してウィンドウを閉じさせる
        if let Some(window) = app_clone_exit.get_webview_window("terminal") {
            let _ = window.emit("terminal-exit", ());
        }
    });

    Ok(())
}

// 3. 入力送信
#[tauri::command]
fn write_pty(state: State<TerminalState>, data: String) {
    if let Some(writer) = state.writer.lock().unwrap().as_mut() {
        let _ = write!(writer, "{}", data);
    }
}

// 4. リサイズ
#[tauri::command]
fn resize_pty(state: State<TerminalState>, rows: u16, cols: u16) {
    if let Some(master) = state.master.lock().unwrap().as_mut() {
        let _ = master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

// デフォルトシェル判定
fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        match std::env::var("SHELL") {
            Ok(s) => s,
            Err(_) => "/bin/zsh".to_string(),
        }
    }
}

#[tauri::command]
fn open_in_browser(path: String) {
    // システムのデフォルトブラウザでパス（ファイル）を開く
    let _ = opener::open(path);
}

#[tauri::command]
async fn open_idea_processor(app: AppHandle) {
    if app.get_webview_window("idea_processor").is_some() {
        app.get_webview_window("idea_processor")
            .unwrap()
            .close()
            .unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "idea_processor",
        tauri::WebviewUrl::App("idea_processor.html".into()),
    )
    .title("Idea Processor")
    .inner_size(640.0, 640.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .visible(false)
    .devtools(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let window = builder.build().unwrap();
    window.show().unwrap();
    window.set_focus().unwrap();
}

#[tauri::command]
async fn open_markdown_preview(app: AppHandle) {
    if app.get_webview_window("markdown").is_some() {
        app.get_webview_window("markdown").unwrap().close().unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "markdown",
        tauri::WebviewUrl::App("markdown.html".into()),
    )
    .title("Markdown Preview")
    .inner_size(640.0, 640.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .visible(false)
    .devtools(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let _ = builder.devtools(true).build();
    #[cfg(not(debug_assertions))]
    let _ = builder.build();
}

#[tauri::command]
async fn export_with_pandoc(
    app: AppHandle,
    source_content: String, // エディタから受け取ったMarkdownテキスト
    output_path: String,
    format: String, // "pdf", "epub", "html"
    is_vertical: bool,
    pandoc_path_setting: Option<String>,
    metadata: serde_json::Value, // title, authorなど
) -> Result<(), String> {
    // 1. Pandocのパス決定 (設定値 -> デフォルト探索)
    let pandoc_exe = resolve_pandoc_path(pandoc_path_setting);
    if pandoc_exe.is_none() {
        return Err("Pandoc not found. Please install Pandoc or set path in settings.".to_string());
    }
    let pandoc_exe = pandoc_exe.unwrap();

    // 2. 一時ファイルの準備
    let temp_dir = std::env::temp_dir();
    let input_md = temp_dir.join("mirrorshard_input.md");

    // Markdownの前処理（ルビ変換など）はフロントエンド（TS）で済ませてから
    // ここに渡す。今回は source_content をそのまま書き込む
    fs::write(&input_md, &source_content).map_err(|e| e.to_string())?;

    // 3. コマンド構築
    let mut cmd = Command::new(&pandoc_exe);
    cmd.arg(&input_md);

    // 共通オプション
    cmd.arg("--standalone");

    // メタデータ設定
    if let Some(title) = metadata.get("title").and_then(|v| v.as_str()) {
        cmd.arg("--metadata").arg(format!("title={}", title));
    }
    if let Some(author) = metadata.get("author").and_then(|v| v.as_str()) {
        cmd.arg("--metadata").arg(format!("author={}", author));
    }

    let cover_image = metadata.get("cover").and_then(|v| v.as_str());

    cmd.arg("--metadata").arg("lang=ja-JP");

    // フォーマット別処理
    match format.as_str() {
        "epub" => {
            cmd.arg("-o").arg(&output_path);
            if is_vertical {
                cmd.arg("--css").arg(resolve_resource_path(
                    &app,
                    "resources/styles/epubvertical.css",
                )?);
                cmd.arg("--metadata").arg("page-progression-direction=rtl");
            }

            if let Some(cover) = cover_image {
                if !cover.is_empty() {
                    cmd.arg(format!("--epub-cover-image={}", cover));
                }
            }
        }

        "html" => {
            cmd.arg("-o").arg(&output_path);
            // ★ HTMLの場合はリソース埋め込みが必須 (画像やCSSを1ファイルにするため)
            cmd.arg("--embed-resources");
            cmd.arg("--standalone");

            if is_vertical {
                // HTMLプレビュー用の縦書きCSSを適用
                cmd.arg("--css").arg(resolve_resource_path(
                    &app,
                    "resources/styles/vertical.css",
                )?);
            }
        }
        _ => return Err("Unsupported format".to_string()),
    }
    // 実行
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute pandoc: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Pandoc Error: {}", stderr))
    }
}

// ヘルパー: リソースパスの解決
fn resolve_resource_path(app: &AppHandle, path_str: &str) -> Result<String, String> {
    app.path()
        .resolve(path_str, tauri::path::BaseDirectory::Resource)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ヘルパー: Pandocパス探索
fn resolve_pandoc_path(setting: Option<String>) -> Option<String> {
    if let Some(p) = setting {
        if !p.is_empty() && Path::new(&p).exists() {
            return Some(p);
        }
    }

    // デフォルト探索
    let candidates = if cfg!(target_os = "windows") {
        vec![
            r"C:\Program Files\Pandoc\pandoc.exe",
            r"C:\Program Files (x86)\Pandoc\pandoc.exe",
            // LocalAppDataなども必要なら追加
        ]
    } else {
        vec!["/usr/bin/pandoc", "/usr/local/bin/pandoc"]
    };

    for path in candidates {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    // PATH環境変数頼み
    // (RustのCommandはPATHを見るので、単に "pandoc" を返して試すのもあり)
    Some("pandoc".to_string())
}

#[tauri::command]
async fn export_epub(
    path: String,
    title: String,
    author: String,
    cover_path: Option<String>,
    sections: Vec<EpubSection>,
) -> Result<(), String> {
    let css = {
        // ★ 横書き用CSS
        r#"
        body { font-family: serif; line-height: 1.8; margin: 0; padding: 0; }
        p { margin: 0; }
        h1, h2, h3 { margin-bottom: 1em; } 
        img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
        .cover { height: 100%; width: 100%; display: flex; align-items: center; justify-content: center; }
        .title-page { text-align: center; margin-top: 30%; }
        "#
    };

    let mut builder = EpubBuilder::new(ZipLibrary::new().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    builder
        .metadata("author", &author)
        .map_err(|e| e.to_string())?;
    builder
        .metadata("title", &title)
        .map_err(|e| e.to_string())?;
    builder.metadata("lang", "ja").map_err(|e| e.to_string())?;

    builder
        .add_resource("style.css", css.as_bytes(), "text/css")
        .map_err(|e| e.to_string())?;

    // --- 表紙 (Cover) ---
    if let Some(cp) = &cover_path {
        let mime = if cp.to_lowercase().ends_with(".png") {
            "image/png"
        } else {
            "image/jpeg"
        };
        let file = fs::File::open(cp).map_err(|e| format!("Failed to open cover image: {}", e))?;

        builder
            .add_cover_image("images/cover.jpg", file, mime)
            .map_err(|e| format!("Failed to add cover image: {}", e))?;

        let cover_xhtml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>Cover</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div class="cover"><img src="images/cover.jpg" alt="Cover" /></div>
</body>
</html>"#;
        builder
            .add_content(
                EpubContent::new("cover.xhtml", cover_xhtml.as_bytes())
                    .title("表紙")
                    .reftype(ReferenceType::Cover),
            )
            .map_err(|e| e.to_string())?;
    }

    // --- ★ 2. タイトルページ (Title Page) の追加 ---
    // 表紙の次、本文の前に「書名と著者名」のページを挿入します
    let title_xhtml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>{}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div class="title-page">
    <h1>{}</h1>
    <p>{}</p>
  </div>
</body>
</html>"#,
        title, title, author
    );

    builder
        .add_content(
            EpubContent::new("title_page.xhtml", title_xhtml.as_bytes())
                .title("扉") // 目次上の表示（必要なら）
                .reftype(ReferenceType::TitlePage), // TitlePageとしてマーク
        )
        .map_err(|e| e.to_string())?;

    // --- 本文 (Content) ---
    for (index, section) in sections.iter().enumerate() {
        if section.content.trim().is_empty() {
            continue;
        }

        let xhtml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head>
<title>{}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
{}
</body>
</html>"#,
            section.title, section.content
        );

        let filename = format!("page_{}.xhtml", index + 1);

        builder
            .add_content(
                EpubContent::new(filename, xhtml.as_bytes())
                    .title(&section.title)
                    .reftype(ReferenceType::Text),
            )
            .map_err(|e| e.to_string())?;
    }

    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    builder.generate(&mut file).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_system_fonts() -> Result<Vec<String>, String> {
    // この処理は重いので、asyncで実行してメインスレッドをブロックしないようにする
    let source = SystemSource::new();
    let fonts = source.all_families().map_err(|e| e.to_string())?;

    // 重複を削除してソート
    let mut font_list = fonts;
    font_list.sort();
    font_list.dedup();

    Ok(font_list)
}

#[tauri::command]
fn get_mac_file_event(state: State<MacFileBuffer>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_shortcut(app: AppHandle) {
    if app.get_webview_window("shortcut").is_some() {
        app.get_webview_window("shortcut").unwrap().close().unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "shortcut",
        tauri::WebviewUrl::App("shortcut.html".into()),
    )
    .title("Shortcuts")
    .inner_size(640.0, 480.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .visible(false)
    .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let window = builder.build().unwrap();
    #[cfg(target_os = "macos")]
    {
        let _ = window.eval("document.body.classList.add('is-mac');");
    }
    window.show().unwrap();
    window.set_focus().unwrap();
}

#[tauri::command]
async fn open_ai_chat(app: AppHandle) {
    if app.get_webview_window("ai_chat").is_some() {
        app.get_webview_window("ai_chat").unwrap().close().unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "ai_chat",
        tauri::WebviewUrl::App("ai_chat.html".into()),
    )
    .title("AI Chat")
    .inner_size(400.0, 600.0)
    .min_inner_size(400.0, 480.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .visible(false)
    .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let window = builder.build().unwrap();

    window.show().unwrap();
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) {
    // 既に開いているかチェック
    if app.get_webview_window("settings").is_some() {
        app.get_webview_window("settings").unwrap().close().unwrap();
        return;
    }

    // 新しいウィンドウをビルド
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "settings", // taiconf.jsonで定義したラベルと同じ名前
        tauri::WebviewUrl::App("settings.html".into()), // taiconf.jsonで定義したURLと同じ
    )
    .title("設定")
    .transparent(true)
    .inner_size(640.0, 820.0)
    .min_inner_size(400.0, 400.0)
    .resizable(true)
    .decorations(false)
    .visible(false)
    .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![
            tauri::window::Effect::HudWindow, // For macOS
            tauri::window::Effect::Acrylic,   // For Windows
        ],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let window = builder.build().unwrap();

    window.show().unwrap();
    window.set_focus().unwrap();
}

#[tauri::command]
async fn open_export_window(app: AppHandle) {
    if app.get_webview_window("export").is_some() {
        app.get_webview_window("export").unwrap().close().unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "export",
        tauri::WebviewUrl::App("export.html".into()),
    )
    .title("エクスポート / 印刷")
    .inner_size(800.0, 900.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .visible(false)
    .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![
            tauri::window::Effect::HudWindow,
            tauri::window::Effect::Acrylic,
        ],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let window = builder.build().unwrap();

    window.show().unwrap();
}

#[tauri::command]
async fn open_preview_window(app: AppHandle) {
    // 既に開いているかチェック
    if app.get_webview_window("preview").is_some() {
        app.get_webview_window("preview").unwrap().close().unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "preview",
        tauri::WebviewUrl::App("preview.html".into()),
    )
    .title("プレビュー")
    .transparent(true)
    .inner_size(600.0, 480.0)
    .min_inner_size(600.0, 480.0)
    .resizable(true)
    .decorations(false)
    .visible(false)
    .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![],
        state: None,
        radius: Some(24.0),
        color: None,
    });

    #[cfg(debug_assertions)]
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
}

// --- フロントエンドからの問い合わせに応えるコマンド ---
#[tauri::command]
fn get_second_instance_file(state: State<SecondInstanceFile>) -> Option<String> {
    // .take()で、一度読み出したら空にする
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn get_initial_file(state: State<InitialFile>) -> Option<String> {
    // stateの中身をロックし、.take()で値を取り出す (一度しか読み出せないようにする)
    state.0.lock().unwrap().take()
}

// ★ アプリを終了させるためだけのコマンド
#[tauri::command]
async fn force_close_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn list_files(dir_path: String) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = match fs::read_dir(dir_path) {
        Ok(reader) => reader,
        Err(e) => return Err(e.to_string()),
    };

    for entry in read_dir {
        if let Ok(entry) = entry {
            let path = entry.path();
            let name = entry.file_name().into_string().unwrap_or_default();

            // .gitや.vscodeのような隠しディレクトリ/ファイルは除外する (オプション)
            if !name.starts_with('.') {
                entries.push(FileEntry {
                    name,
                    is_dir: path.is_dir(),
                    path,
                });
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
async fn read_file(path: String) -> Result<FileData, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

    // 1. BOM付きUTF-8のチェック
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let content = std::str::from_utf8(&bytes[3..])
            .map_err(|e| e.to_string())?
            .to_string();
        let line_ending = if content.contains("\r\n") {
            "CRLF"
        } else {
            "LF"
        };
        return Ok(FileData {
            content,
            encoding: "UTF-8".to_string(),
            line_ending: line_ending.to_string(),
        });
    }

    // 2. BOMなしUTF-8のチェック (encoding_rsを使用)
    let (cow, _encoding_used, had_errors) = UTF_8.decode(&bytes);
    if !had_errors {
        let content = cow.into_owned();
        let line_ending = if content.contains("\r\n") {
            "CRLF"
        } else {
            "LF"
        };
        return Ok(FileData {
            content,
            encoding: "UTF-8".to_string(),
            line_ending: line_ending.to_string(),
        });
    }

    // 3. Shift_JISのチェック
    let (cow, _encoding_used, had_errors) = SHIFT_JIS.decode(&bytes);
    if !had_errors {
        let content = cow.into_owned();
        let line_ending = if content.contains("\r\n") {
            "CRLF"
        } else {
            "LF"
        };
        return Ok(FileData {
            content,
            encoding: "Shift_JIS".to_string(),
            line_ending: line_ending.to_string(),
        });
    }

    // 4. ★★★ それ以外はエラーとして弾く ★★★
    // 無理やり開いてデータ破壊するリスクを避ける
    Err("Unsupported encoding detected. MirrorShard only supports UTF-8 and Shift_JIS.".to_string())
}

#[tauri::command]
async fn write_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let path = Path::new(&path);
    // 一時ファイル用のパスを生成 (例: file.md -> file.tmp)
    let temp_path = path.with_extension("tmp");

    // 1. ファイルの内容をバイトデータに変換
    let bytes = if encoding == "Shift_JIS" {
        let (cow, ..) = encoding_rs::SHIFT_JIS.encode(&content);
        cow.into_owned()
    } else {
        content.into_bytes()
    };

    // 2. 一時ファイルに書き込む
    fs::write(&temp_path, &bytes).map_err(|e| e.to_string())?;

    // 3. 一時ファイルをリネームして、元のファイルをアトミックに上書きする
    fs::rename(&temp_path, path).map_err(|e| {
        // もしリネームに失敗したら、後始末として一時ファイルを削除しようと試みる
        let _ = fs::remove_file(&temp_path);
        e.to_string()
    })?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cli::init())
        .manage(MacFileBuffer(Mutex::new(None)))
        .manage(InitialFile(Mutex::new(None))) // 最初の起動用
        .manage(SecondInstanceFile(Mutex::new(None))) // 2回目以降の起動用
        .manage(TerminalState {
            writer: Arc::new(Mutex::new(None)),
            master: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            // ---  起動時引数を解析し、状態に書き込む ---
            if let Ok(matches) = app.cli().matches() {
                if let Some(path_arg) = matches.args.get("filePath") {
                    if let Some(path) = &path_arg.value.as_str() {
                        // State<InitialFile> を使って、管理下の状態にアクセス
                        let state: State<InitialFile> = app.state();
                        *state.0.lock().unwrap() = Some(path.to_string());
                    }
                }
            }
            // メインウィンドウのスタイルをMac用に強制設定
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                // プレビューウィンドウと同じ設定を適用
                let _ = window.set_title_bar_style(tauri::TitleBarStyle::Transparent);
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("Second instance opened with argv: {:?}", argv); // デバッグ用ログ
            if let Some(path) = argv.get(1) {
                // ★イベントを送るのではなく、状態にパスを書き込む
                let state: State<SecondInstanceFile> = app.state();
                *state.0.lock().unwrap() = Some(path.clone());
                let _ = app.emit("open-file-from-os", path);
            }
            // 既存のウィンドウにフォーカスを当てる
            if let Some(window) = app.get_webview_window("main") {
                window.unminimize().unwrap();
                window.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // メインウィンドウが閉じられようとした時だけ、フロントに問い合わせる
                if window.label() == "main" {
                    api.prevent_close();
                    window.emit("tauri://ask-before-close", ()).unwrap();
                }
            }
        })
        .plugin(
            Builder::new()
                .with_state_flags(
                    StateFlags::POSITION | // 位置は保存
                    StateFlags::SIZE, // サイズは保存
                                      // StateFlags::MAXIMIZED |// 最大化状態は保存しない
                                      // StateFlags::FULLSCREEN, // フルスクリーン状態は保存しない
                                      // VISIBLE を除外することで、表示状態は保存・復元されなくなる
                )
                // .with_denylist(&["settings"])
                // 設定ウィンドウも可変にしたのでサイズを保存
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // ★★★ すべてのコマンドをここに登録 ★★★
            list_files,
            read_file,
            write_file,
            force_close_app,
            get_initial_file,
            get_second_instance_file,
            open_settings_window,
            open_preview_window,
            open_export_window,
            read_binary_file,
            get_mac_file_event,
            get_system_fonts,
            export_epub,
            open_ai_chat,
            open_shortcut,
            export_with_pandoc,
            open_markdown_preview,
            open_idea_processor,
            open_in_browser,
            open_terminal_window, // ウィンドウを開く
            init_pty,             // PTYを開始する
            write_pty,            // 入力を送る
            resize_pty,           // サイズ変更
            toggle_devtools,
            set_simple_fullscreen,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            // ★ Macの関連付け起動イベント
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                if let Some(url) = urls.first() {
                    if let Ok(path_buf) = url.to_file_path() {
                        if let Some(path_str) = path_buf.to_str() {
                            // 1. 起動済みならイベントで通知
                            let _ = _app_handle.emit("open-file-from-os", path_str);
                            // 2. 未起動ならStateに保存 (後でフロントエンドが取りに来る)
                            let state: State<MacFileBuffer> = _app_handle.state();
                            *state.0.lock().unwrap() = Some(path_str.to_string());
                        }
                    }
                }
            }
            _ => {}
        });
}

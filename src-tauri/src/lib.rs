// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use epub_builder::{EpubBuilder, EpubContent, ReferenceType, ZipLibrary};
use font_kit::source::SystemSource;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_cli::CliExt;
use tauri_plugin_window_state::{Builder, StateFlags};

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
    .resizable(false)
    .decorations(false)
    .visible(false);
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
    .visible(false);
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
    .resizable(true)
    .decorations(false)
    .visible(false);
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
                .with_denylist(&["settings"])
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

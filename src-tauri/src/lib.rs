// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WindowEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{Builder, StateFlags};
use tauri_plugin_cli::CliExt;

// --- FileEntry構造体の定義 ---
#[derive(serde::Serialize, Clone)] // Cloneを追加すると後で便利
struct FileEntry {
    name: String,
    path: PathBuf,
    is_dir: bool,
}
#[derive(serde::Serialize)]
struct FileData {
    content: String,
    encoding: String,
    line_ending: String,
}
// Mutexでラップして、スレッドセーフにする
struct InitialFile(Mutex<Option<String>>);
// 2回目に開かれたファイルパスを保持するための状態
struct SecondInstanceFile(Mutex<Option<String>>);

// --- Tauriコマンドの定義 ---

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
        let content = std::str::from_utf8(&bytes[3..]).map_err(|e| e.to_string())?.to_string();
        let line_ending = if content.contains("\r\n") { "CRLF" } else { "LF" };
        return Ok(FileData { content, encoding: "UTF-8".to_string(), line_ending: line_ending.to_string() });
    }

    // 2. BOMなしUTF-8のチェック (encoding_rsを使用)
    let (cow, _encoding_used, had_errors) = UTF_8.decode(&bytes);
    if !had_errors {
        let content = cow.into_owned();
        let line_ending = if content.contains("\r\n") { "CRLF" } else { "LF" };
        return Ok(FileData { content, encoding: "UTF-8".to_string(), line_ending: line_ending.to_string() });
    }

    // 3. Shift_JISのチェック
    let (cow, _encoding_used, had_errors) = SHIFT_JIS.decode(&bytes);
    if !had_errors {
        let content = cow.into_owned();
        let line_ending = if content.contains("\r\n") { "CRLF" } else { "LF" };
        return Ok(FileData { content, encoding: "Shift_JIS".to_string(), line_ending: line_ending.to_string() });
    }

    // 4. ★★★ それ以外はエラーとして弾く ★★★
    // 無理やり開いてデータ破壊するリスクを避ける
    Err("Unsupported encoding detected. MirrorShard only supports UTF-8 and Shift_JIS.".to_string())
}

#[tauri::command]
async fn write_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = if encoding == "Shift_JIS" {
        let (cow, _encoding_used, _had_errors) = SHIFT_JIS.encode(&content);
        cow.into_owned()
    } else {
        content.into_bytes() // UTF-8として扱う
    };
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_file_as(app: tauri::AppHandle, content: String) {
    app.dialog()
        .file()
        .add_filter("Text Document", &["txt", "md"])
        .set_file_name("Untitled.txt")
        .save_file(move |file_path| {
            if let Some(path) = file_path {
                if let Err(e) = std::fs::write(path.to_string(), &content) {
                    eprintln!("Failed to save file: {}", e.to_string());
                    app.dialog()
                        .message(format!("Failed to save file: {}", e.to_string()))
                        .title("Error")
                        .show(|_| {});
                }
            }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
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
            }
            // 既存のウィンドウにフォーカスを当てる
            if let Some(window) = app.get_webview_window("main") {
                window.unminimize().unwrap();
                window.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                // フロントエンドに「終了しようとしてるよ」と通知するだけ
                window.emit("tauri://on-close-requested", ()).unwrap();
            }
            _ => {}
        })
        .plugin(
            Builder::new()
                .with_state_flags(
                    StateFlags::POSITION | // 位置は保存
                StateFlags::SIZE |     // サイズは保存
                StateFlags::MAXIMIZED |// 最大化状態は保存
                StateFlags::FULLSCREEN, // フルスクリーン状態は保存
                                                            // VISIBLE を除外することで、表示状態は保存・復元されなくなる
                )
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // ★★★ すべてのコマンドをここに登録 ★★★
            list_files,
            read_file,
            write_file,
            save_file_as,
            force_close_app,
            get_initial_file,
            get_second_instance_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

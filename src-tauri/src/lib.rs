// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{Builder, StateFlags};

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

// --- Tauriコマンドの定義 ---

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

    // 1. まずUTF-8としてデコードを試みる
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

    // 2. UTF-8で失敗したら、Shift_JISとしてデコードを試みる
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

    // どちらも失敗した場合
    Err("Failed to decode file with UTF-8 or Shift_JIS.".to_string())
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
            force_close_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use std::fs;
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

// --- FileEntry構造体の定義 ---
#[derive(serde::Serialize, Clone)] // Cloneを追加すると後で便利
struct FileEntry {
    name: String,
    path: PathBuf,
    is_dir: bool,
}

// --- Tauriコマンドの定義 ---

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
async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_file_as(app: tauri::AppHandle, content: String) {
    // ... (前回成功したsave_file_asの実装) ...
    app.dialog().file().save_file(move |file_path| {
        if let Some(path) = file_path {
            if let Err(e) = std::fs::write(path.to_string(), &content) {
                // .to_string() が正解でしたね！
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
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // ★★★ すべてのコマンドをここに登録 ★★★
            list_files,
            read_file,
            write_file,
            save_file_as,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use epub_builder::{EpubBuilder, EpubContent, ReferenceType, ZipLibrary};
use font_kit::source::SystemSource;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_cli::CliExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{Builder, StateFlags};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

struct OpenCodeProcess(Mutex<Option<Child>>);

struct SillyTavernProcess(Mutex<Option<Child>>);

// PTYの入力側を保持する構造体
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

struct TerminalState(Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
struct TerminalPayload {
    id: String,
    data: String,
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
// Mac用のファイルパス保持場所
struct MacFileBuffer(Mutex<Option<String>>);
// --- Tauriコマンドの定義 ---

#[tauri::command]
async fn start_sd_port_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let addr = "127.0.0.1:7860";
        for _ in 0..300 {
            if std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                std::time::Duration::from_millis(500),
            )
            .is_ok()
            {
                // opener プラグインを使用してブラウザを開く
                let _ = app
                    .opener()
                    .open_url("http://127.0.0.1:7860", Option::<String>::None);
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

#[tauri::command]
fn launch_stable_diffusion_external(sd_path: String) -> Result<(), String> {
    // 受け取るのはディレクトリのパス (sdDir)
    let base_path = std::path::Path::new(&sd_path);
    if !base_path.exists() {
        return Err("ERR_SD_PATH_NOT_FOUND".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let is_forge = base_path.join("run.bat").exists();
        let batch_file = if is_forge {
            "run.bat"
        } else {
            "webui-user.bat"
        };

        let wrapper_name = "mirrorshard_launcher.bat";
        let wrapper_path = base_path.join(wrapper_name);

        let bat_content = format!(
            "@echo off\r\n\
             title Stable Diffusion (MirrorShard)\r\n\
             cd /d \"{}\"\r\n\
             set SD_WEBUI_RESTARTING=1\r\n\
             call {} --api\r\n\
             echo.\r\n\
             echo [MirrorShard] Stable Diffusion process ended.\r\n\
             pause",
            base_path.display(),
            batch_file
        );

        std::fs::write(&wrapper_path, bat_content)
            .map_err(|e| format!("Failed to create launcher: {}", e))?;

        // explorer.exe 経由で呼び出す（uv エラー回避）
        std::process::Command::new("explorer.exe")
            .arg(wrapper_path.to_str().unwrap())
            .spawn()
            .map_err(|e| format!("Failed to launch SD via explorer: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    // Mac/Linux　念のため残しておく
    {
        // Forge Neo は webui-user.sh、本家は webui.sh
        let sh_file = if base_path.join("webui-user.sh").exists() {
            "./webui-user.sh"
        } else if base_path.join("webui.sh").exists() {
            "./webui.sh"
        } else if base_path.join("webui/webui.sh").exists() {
            "./webui/webui.sh"
        } else {
            "./webui.sh" // フォールバック
        };

        // Mac/Linuxでは現状、標準ターミナルを出すのが難しいため
        // バックグラウンドで起動し、ブラウザが開くのを待つ形に
        std::process::Command::new("sh") // 明示的に sh で叩くのが確実
            .env("SD_WEBUI_RESTARTING", "1") // ブラウザ抑制
            .arg(sh_file)
            .arg("--api")
            .current_dir(base_path)
            .spawn()
            .map_err(|e| format!("Failed to launch SD: {}", e))?;
    }

    Ok(())
}

// 共通のツリーキルヘルパー関数
fn kill_child_tree(child: &mut Child) {
    let _pid = child.id();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // /F (強制) /T (ツリー全体) に加え、
        // 万が一のために python.exe 自体を狙い撃ちするのではなく、
        // このプロセスグループに属するものをすべて殺す
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &_pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = child.kill();
}

// --- nodeのパスを解決するヘルパー (Mac/Linux用) ---
#[cfg(not(target_os = "windows"))]
fn resolve_node_path() -> String {
    {
        // 1. nodebrew のパスを動的に生成
        if let Ok(home) = std::env::var("HOME") {
            let nodebrew_node = format!("{}/.nodebrew/current/bin/node", home);
            if std::path::Path::new(&nodebrew_node).exists() {
                return nodebrew_node;
            }
        }

        // 2. Homebrew (Apple Silicon) の標準パス
        let brew_node = "/opt/homebrew/bin/node";
        if std::path::Path::new(brew_node).exists() {
            return brew_node.to_string();
        }

        // 3. Intel Mac / 旧標準パス
        let intel_node = "/usr/local/bin/node";
        if std::path::Path::new(intel_node).exists() {
            return intel_node.to_string();
        }
    }

    // 見つからない場合や Windows はデフォルトに期待
    "node".to_string()
}

#[tauri::command]
async fn open_silly_tavern(
    app: tauri::AppHandle,
    state: tauri::State<'_, SillyTavernProcess>,
    st_path_setting: Option<String>,
    enable_st_terminal: bool,
) -> Result<String, String> {
    // 1. トグル処理
    if let Some(win) = app.get_webview_window("silly_tavern") {
        let _ = win.close();
        // 以前のプロセスを殺す
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }
        return Ok("closed".to_string());
    }

    // 2. パス判定
    let st_path = st_path_setting.unwrap_or_default();
    if st_path.is_empty() || !std::path::Path::new(&st_path).exists() {
        return Err("ERR_ST_PATH_NOT_FOUND".to_string());
    }

    // 3. ウィンドウを「即座に」作成
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "silly_tavern",
        tauri::WebviewUrl::App("loading.html".into()), // 共通ロード画面
    )
    .title("SillyTavern (Loading...)")
    .inner_size(1200.0, 900.0)
    // ★ Mac特有のIME変換確定誤爆を防ぐスクリプトをここで注入
    .initialization_script(
        r#"
        let isComposing = false;
        document.addEventListener('compositionstart', () => { isComposing = true; }, true);
        document.addEventListener('compositionend', () => { setTimeout(() => { isComposing = false; }, 50); }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && isComposing) {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, true);
    "#,
    );

    // Windows/Mac用の視覚効果 (必要であれば)
    #[cfg(target_os = "windows")]
    {
        builder = builder.theme(Some(tauri::Theme::Dark));
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    // 4. サーバープロセス起動
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }

        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "node server.js"]);
            if !enable_st_terminal {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x08000000);
            }
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = std::process::Command::new(resolve_node_path());
            c.arg("server.js");
            c
        };

        cmd.current_dir(&st_path);
        // Windowsかつターミナル非表示のときは出力をnullに捨ててバッファ詰まりを防止
        if cfg!(target_os = "windows") {
            if !enable_st_terminal {
                cmd.stdout(std::process::Stdio::null());
                cmd.stderr(std::process::Stdio::null());
            }
        }

        let child = cmd.spawn().map_err(|e| format!("ERR_ST_SPAWN:{}", e))?;
        *lock = Some(child);
    }

    // 5. バックグラウンド監視
    let window_clone = window.clone();
    std::thread::spawn(move || {
        let addr = "127.0.0.1:8000";
        for _ in 0..150 {
            // 約30秒
            if std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                std::time::Duration::from_millis(200),
            )
            .is_ok()
            {
                // 準備ができたらリダイレクト
                let _ = window_clone.eval("window.location.href = 'http://127.0.0.1:8000'");
                let _ = window_clone.set_title("SillyTavern");
                return;
            }
            if window_clone.is_closable().is_err() {
                return;
            } // 窓が閉じられたら監視終了
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });

    Ok("opened".to_string())
}

#[tauri::command]
async fn open_opencode(app: AppHandle, state: State<'_, OpenCodeProcess>) -> Result<(), String> {
    // ウィンドウを閉じる際のトグル処理
    if let Some(win) = app.get_webview_window("opencode") {
        let _ = win.close();
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            println!("Stopping OpenCode server tree (PID: {})...", child.id());
            kill_child_tree(&mut child);
        }
        return Ok(());
    }

    // サーバー起動
    {
        let mut lock = state.inner().0.lock().unwrap();

        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(["/C", "set BROWSER=true && opencode serve --port 4096"]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x08000000); // 窓を出さない
            }
            c
        } else {
            // Mac用の修正:
            // 1. Homebrewの標準パス (Apple Silicon / Intel両対応) を確認
            let brew_path = "/opt/homebrew/bin/opencode";
            let intel_path = "/usr/local/bin/opencode";

            let final_cmd = if std::path::Path::new(brew_path).exists() {
                brew_path
            } else if std::path::Path::new(intel_path).exists() {
                intel_path
            } else {
                "opencode" // どちらにもなければPATHに賭ける
            };

            println!("Mac: {} を起動します", final_cmd);
            let mut c = Command::new(final_cmd);
            c.args(["serve", "--port", "4096"]);
            c.env("BROWSER", "true");

            // 開発中は Stdio::inherit() に
            #[cfg(debug_assertions)]
            c.stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit());

            c
        };

        // 入出力を完全に「虚無」に捨ててバッファ詰まりを防ぐ
        let child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("ERR_OPENCODE_SPAWN:{}", e))?;

        *lock = Some(child);
        std::thread::sleep(std::time::Duration::from_millis(2000));
    }

    // 5. ウィンドウ生成
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "opencode",
        tauri::WebviewUrl::External("http://127.0.0.1:4096".parse().unwrap()),
    )
    .title("OpenCode - AI Coding Assistant")
    .inner_size(1100.0, 850.0)
    .decorations(true);

    let window = builder.build().map_err(|e| e.to_string())?;
    window.show().unwrap();

    Ok(())
}

#[tauri::command]
async fn force_save_file(path: String, content: Vec<u8>) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;

    let mut file = File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(&content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn force_save_chat_log(path: String, content: String) -> Result<(), String> {
    use std::fs;
    // Rust側から直接書き込む（WebViewの制限を受けない）
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

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
async fn open_terminal_window(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let input_id = id.unwrap_or_else(|| "main".to_string());

    // 1. 最終的な「ユニークなセッションID」を決定する
    let session_id = if input_id == "sd" {
        "terminal_sd".to_string()
    } else {
        // 通常のターミナルの場合は、呼び出すたびに完全に固有のIDを作る
        format!(
            "terminal_main_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        )
    };

    // 2. ラベルとセッションIDを同一にする
    let label = &session_id;

    // SD用(固定ID)の場合のみ、既に開いていればフォーカス
    if input_id == "sd" {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
            return Ok(());
        }
    }

    // 3. URLパラメータにも「ユニークなID」を渡す
    let url = format!("terminal.html?id={}", session_id);
    let builder = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title(if input_id == "sd" {
            "Stable Diffusion Console"
        } else {
            "Terminal"
        })
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
    let _ = builder.devtools(true).build().map_err(|e| e.to_string())?;
    #[cfg(not(debug_assertions))]
    let _ = builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

// 2. PTY初期化 (terminal.ts から呼ばれる)
#[tauri::command]
fn init_pty(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    rows: u16,
    cols: u16,
    shell_path: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    // 新しい PTY を作る前に、既存の状態を確実にクリアする
    {
        let mut sessions = state.0.lock().unwrap();
        sessions.remove(&id);
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
    // 優先順位: 1. SD専用(Windows) 2. ユーザー設定 3. システムデフォルト
    let cmd = if id == "terminal_sd" && cfg!(target_os = "windows") {
        "cmd.exe".to_string()
    } else if let Some(path) = shell_path {
        if path.is_empty() {
            default_shell()
        } else {
            path
        }
    } else {
        default_shell()
    };

    let mut cmd_builder = CommandBuilder::new(&cmd); // &cmd にして所有権エラー回避

    // システムの環境変数をすべて引き継ぐ
    for (key, val) in std::env::vars() {
        cmd_builder.env(key, val);
    }

    // Windows 向けの「生命維持」用変数の強制上書き
    if cfg!(target_os = "windows") {
        // uv が外部プロセスを起動するのに必須のパスを確実に含める
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system_32 = format!("{}\\System32", system_root);

        cmd_builder.env("SystemRoot", &system_root);
        cmd_builder.env("COMSPEC", format!("{}\\cmd.exe", system_32));

        // PATH に System32 が含まれていない場合、uv は os error 2 を吐く
        if let Ok(current_path) = std::env::var("PATH") {
            if !current_path.contains(&system_32) {
                cmd_builder.env("PATH", format!("{};{}", current_path, system_32));
            }
        }

        // 文字化け対策（TERMは cygwin より xterm の方が現代的なツールと相性が良い場合がある）
        cmd_builder.env("TERM", "xterm");
    } else {
        cmd_builder.env("TERM", "xterm-256color");
        // Mac/Linux向け：日本語化け対策
        cmd_builder.env("LANG", "ja_JP.UTF-8");
        cmd_builder.env("LC_ALL", "ja_JP.UTF-8");
    }

    // CWDの設定
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd_builder.cwd(dir);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd_builder)
        .map_err(|e| e.to_string())?;

    // 1. Writerの取得 (Masterから)
    // take_writer は &mut self を取るので、先に reader をクローンするか、順序に注意
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // 2. Readerの取得 (SlaveではなくMasterから取得)
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // セッションの保存
    {
        let mut sessions = state.0.lock().unwrap();
        sessions.insert(
            id.clone(),
            PtySession {
                writer,
                master: pair.master,
            },
        );
    }

    // 読み取りスレッド開始
    let app_clone = app.clone();
    let id_for_read = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_clone.emit(
                        "terminal-data",
                        TerminalPayload {
                            id: id_for_read.clone(),
                            data: output,
                        },
                    );
                }
                _ => break,
            }
        }
    });

    // プロセス終了監視スレッド
    let app_clone_exit = app.clone();
    let id_for_exit = id.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app_clone_exit.emit("terminal-exit", id_for_exit);
    });

    Ok(())
}

// 3. 入力送信
#[tauri::command]
fn write_pty(state: State<TerminalState>, id: String, data: String) {
    let mut sessions = state.0.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        let _ = write!(session.writer, "{}", data);
    }
}

// 4. リサイズ
#[tauri::command]
fn resize_pty(state: State<TerminalState>, id: String, rows: u16, cols: u16) {
    let mut sessions = state.0.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        let _ = session.master.resize(PtySize {
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
        // macOSはzsh, Linuxはbashが一般的
        let fallback = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };

        match std::env::var("SHELL") {
            Ok(s) if !s.is_empty() => s,
            _ => fallback.to_string(),
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

// --- DOCX内のXMLを書き換えてルビを適用する関数 ---
fn apply_ruby_to_docx(file_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(file_path);
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    // メモリ上に新しいZipを作成するためのバッファ
    let mut buffer = Vec::new();
    {
        let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buffer));

        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().to_string();
            let options = SimpleFileOptions::default()
                .compression_method(file.compression())
                .unix_permissions(file.unix_mode().unwrap_or(0o644));

            writer
                .start_file(name.clone(), options)
                .map_err(|e| e.to_string())?;

            if name == "word/document.xml" {
                // 本文XMLの場合、中身を書き換える
                let mut content = String::new();
                file.read_to_string(&mut content)
                    .map_err(|e| e.to_string())?;

                // 共通のルビ用OpenXMLテンプレート（フォント指定なしのクリーンな構造）
                let ruby_xml = r#"</w:t></w:r><w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="12"/><w:hpsRaise w:val="21"/><w:hpsBaseText w:val="21"/><w:lid w:val="ja-JP"/></w:rubyPr><w:rt><w:r><w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr><w:t>$2</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>$1</w:t></w:r></w:rubyBase></w:ruby></w:r><w:r><w:t xml:space="preserve">"#;

                // 1. 【明示的ルビ】半角「|」または全角「｜」が付いているパターン
                // 最初の [\|｜] はキャプチャしない（置換結果に残さない）ため、縦棒は完全に消滅します。
                let re_explicit = Regex::new(r"[\|｜]([^《<]+)《([^》>]+)》").unwrap();
                content = re_explicit.replace_all(&content, ruby_xml).to_string();

                // 2. 【暗黙的ルビ】漢字に直接《》が付いているパターン
                // 上の処理で明示的ルビは既にXML化されているので、残ったものだけが安全に処理されます。
                let re_implicit = Regex::new(r"([\p{sc=Han}]+)《([^》>]+)》").unwrap();
                content = re_implicit.replace_all(&content, ruby_xml).to_string();

                writer
                    .write_all(content.as_bytes())
                    .map_err(|e| e.to_string())?;
            } else {
                // それ以外のファイルはそのままコピー
                let mut data = Vec::new();
                file.read_to_end(&mut data).map_err(|e| e.to_string())?;
                writer.write_all(&data).map_err(|e| e.to_string())?;
            }
        }
        writer.finish().map_err(|e| e.to_string())?;
    }

    // 元のファイルを新しいバッファの内容で上書き
    let mut out_file = File::create(path).map_err(|e| e.to_string())?;
    out_file.write_all(&buffer).map_err(|e| e.to_string())?;

    Ok(())
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
        return Err("ERR_PANDOC_NOT_FOUND".to_string());
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
        "docx" => {
            cmd.arg("-o").arg(&output_path);
        }
        _ => return Err("ERR_UNSUPPORTED_FORMAT".to_string()),
    }
    // 実行
    let output = cmd.output().map_err(|e| format!("ERR_PANDOC_EXEC:{}", e))?;

    if output.status.success() {
        if format == "docx" {
            println!("Applying ruby surgical transformation to DOCX...");
            apply_ruby_to_docx(&output_path)?;
        }
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ERR_PANDOC_ERROR:{}", stderr))
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
        let file = fs::File::open(cp).map_err(|e| format!("ERR_COVER_OPEN:{}", e))?;

        builder
            .add_cover_image("images/cover.jpg", file, mime)
            .map_err(|e| format!("ERR_COVER_ADD:{}", e))?;

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
async fn get_app_language() -> Result<String, String> {
    let store_path = if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join("Library/Application Support/com.DroicheadNua.mirrorshard2/.settings.dat")
            })
            .map_err(|_| "Could not find HOME directory")?
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(|p| {
                std::path::PathBuf::from(p).join("com.DroicheadNua.mirrorshard2/.settings.dat")
            })
            .map_err(|_| "Could not find APPDATA")?
    } else {
        std::env::var("HOME")
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join(".local/share/com.DroicheadNua.mirrorshard2/.settings.dat")
            })
            .map_err(|_| "Could not find HOME directory")?
    };

    if store_path.exists() {
        let content = std::fs::read(&store_path).map_err(|e| e.to_string())?;
        if let Ok(json_str) = String::from_utf8(content) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(lang) = data.get("appLanguage").and_then(|v| v.as_str()) {
                    return Ok(lang.to_string());
                }
            }
        }
    }
    Ok("ja".to_string())
}

#[tauri::command]
async fn get_window_title(window_key: String) -> Result<String, String> {
    let titles: std::collections::HashMap<&str, std::collections::HashMap<&str, &str>> = [
        ("settings", [("ja", "設定"), ("en", "Settings")].into()),
        (
            "export",
            [("ja", "エクスポート / 印刷"), ("en", "Export / Print")].into(),
        ),
        ("preview", [("ja", "プレビュー"), ("en", "Preview")].into()),
        (
            "markdown",
            [("ja", "Markdownプレビュー"), ("en", "Markdown Preview")].into(),
        ),
        (
            "shortcut",
            [("ja", "ショートカット"), ("en", "Shortcuts")].into(),
        ),
        (
            "idea_processor",
            [("ja", "アイデアプロセッサ"), ("en", "Idea Processor")].into(),
        ),
        ("ai_chat", [("ja", "AIチャット"), ("en", "AI Chat")].into()),
        (
            "terminal",
            [("ja", "ターミナル"), ("en", "Terminal")].into(),
        ),
    ]
    .into();

    let lang = get_app_language()
        .await
        .unwrap_or_else(|_| "ja".to_string());

    titles
        .get(window_key.as_str())
        .and_then(|langs| langs.get(lang.as_str()))
        .map(|s| s.to_string())
        .ok_or_else(|| "".to_string())
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
    Err("ERR_UNSUPPORTED_ENCODING".to_string())
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
    // Linux環境でのみ起動時に環境変数を強制セットする
    #[cfg(target_os = "linux")]
    {
        println!("Linux detected: Disabling WebKit compositing mode for stability.");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        // もしWayland環境でウィンドウが表示されない等の問題が続く場合は
        // 以下の「X11バックエンド強制」もセットで試す
        // std::env::set_var("GDK_BACKEND", "x11");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cli::init())
        .manage(MacFileBuffer(Mutex::new(None)))
        .manage(InitialFile(Mutex::new(None))) // 最初の起動用
        .manage(SecondInstanceFile(Mutex::new(None))) // 2回目以降の起動用
        // TerminalStateの初期化 (HashMap)
        .manage(TerminalState(Mutex::new(HashMap::new())))
        .manage(OpenCodeProcess(Mutex::new(None)))
        .manage(SillyTavernProcess(Mutex::new(None)))
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
            force_save_file,
            force_save_chat_log,
            open_opencode,
            open_silly_tavern,
            get_app_language,
            get_window_title,
            launch_stable_diffusion_external,
            start_sd_port_monitor,
        ])
        .on_window_event(|window, event| match event {
            // 1. メインウィンドウの終了確認
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    api.prevent_close();
                    window.emit("tauri://ask-before-close", ()).unwrap();
                }
            }
            // 2. 各ウィンドウが破棄された時のプロセス清掃
            tauri::WindowEvent::Destroyed => {
                let label = window.label();
                match label {
                    "opencode" => {
                        let state = window.state::<OpenCodeProcess>();
                        if let Ok(mut lock) = state.inner().0.lock() {
                            if let Some(mut child) = lock.take() {
                                kill_child_tree(&mut child);
                            }
                        }
                    }
                    "silly_tavern" => {
                        let state = window.state::<SillyTavernProcess>();
                        if let Ok(mut lock) = state.inner().0.lock() {
                            if let Some(mut child) = lock.take() {
                                kill_child_tree(&mut child);
                            }
                        }
                    }
                    _ if label.starts_with("terminal_") => {
                        if let Some(state) = window.try_state::<TerminalState>() {
                            if let Ok(mut sessions) = state.0.lock() {
                                // ラベル名 = HashMapのキー なので、そのまま消す
                                sessions.remove(label);
                                println!("PTY session removed for: {}", label);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Exit => {
                // 外部ツールのプロセスを一掃
                if let Ok(mut lock) = app_handle.state::<OpenCodeProcess>().inner().0.lock() {
                    if let Some(mut child) = lock.take() {
                        kill_child_tree(&mut child);
                    }
                }
                if let Ok(mut lock) = app_handle.state::<SillyTavernProcess>().inner().0.lock() {
                    if let Some(mut child) = lock.take() {
                        kill_child_tree(&mut child);
                    }
                }
                // ターミナルセッションを一掃
                if let Some(state) = app_handle.try_state::<TerminalState>() {
                    if let Ok(mut sessions) = state.0.lock() {
                        sessions.clear(); // HashMapを空にすれば全セッションがDropされる
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    // ウィンドウタイトルを狙い撃ちして、SD のコンソールを強制終了させる
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("taskkill")
                        .args([
                            "/F",
                            "/T",
                            "/FI",
                            "WINDOWTITLE eq Stable Diffusion (MirrorShard)",
                        ])
                        .creation_flags(0x08000000)
                        .status();
                }
            }
            // Macの関連付け起動イベント
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                use tauri::Manager; // emit を使うために必要
                if let Some(url) = urls.first() {
                    if let Ok(path_buf) = url.to_file_path() {
                        if let Some(path_str) = path_buf.to_str() {
                            // 1. 起動済みならイベントで通知
                            let _ = app_handle.emit("open-file-from-os", path_str);
                            // 2. 未起動ならStateに保存
                            let state: tauri::State<MacFileBuffer> = app_handle.state();
                            *state.inner().0.lock().unwrap() = Some(path_str.to_string());
                        }
                    }
                }
            }
            _ => {}
        });
}

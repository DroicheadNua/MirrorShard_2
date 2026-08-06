// src-lib.rs

// --- use文 (ファイルの先頭に追加) ---
use encoding_rs::{SHIFT_JIS, UTF_8};
use epub_builder::{EpubBuilder, EpubContent, ReferenceType, ZipLibrary};
use font_kit::source::SystemSource;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use rig::client::{CompletionClient, ProviderClient};
use rig::completion::Prompt;
use rodio::source::Source;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_cli::CliExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{Builder, StateFlags};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

// BGMの状態保持用 (OutputStream も一緒に保持しないと音が出なくなる)
struct BgmState(Mutex<Option<(MixerDeviceSink, Player)>>);
// Vivliostyle プレビュープロセス管理用
struct VivliostyleProcess(Mutex<Option<Child>>);

struct OpenCodeProcess(Mutex<Option<Child>>);

struct SillyTavernProcess(Mutex<Option<Child>>);

struct SdCppProcess(Mutex<Option<std::process::Child>>);

struct SdServerProcess(Mutex<Option<std::process::Child>>);

// PTYの入力側を保持する構造体
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    pid: u32,
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

// 1. 引数の定義（マクロは使わないただの構造体）
#[derive(serde::Deserialize, serde::Serialize)]
pub struct WebSearchArgs {
    pub query: String,
}

// 2. ツールの実体
pub struct WebSearchTool {
    pub obscura_path: String,
    pub search_engine: String, // "duckduckgo" or "tavily"
    pub tavily_api_key: String,
}

// 3. エラー型の定義 (既存のまま)
#[derive(Debug, thiserror::Error)]
pub enum WebFetchError {
    #[error("Obscura error: {0}")]
    ObscuraError(String),
    #[error("IO error: {0}")]
    IoError(String),
}

// 4. トレイトの実装
impl rig::tool::Tool for WebSearchTool {
    const NAME: &'static str = "web_search";
    type Error = WebFetchError;
    type Args = WebSearchArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> rig::completion::ToolDefinition {
        rig::completion::ToolDefinition {
            name: Self::NAME.to_string(),
            description: "A tool to search the web or fetch content from a URL. The agent must use this tool for research and then provide the final answer in the user's original language.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search keyword or URL. Use only one string."
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let query = args.query.clone();
        let is_url = query.starts_with("http");

        // --- 1. Tavily 検索ルート ---
        // URL指定ではなく、Tavilyが選ばれていて、キーが設定されている場合のみ実行
        if !is_url && self.search_engine == "tavily" && !self.tavily_api_key.is_empty() {
            let client = reqwest::Client::new();
            let payload = serde_json::json!({
                "api_key": self.tavily_api_key,
                "query": &query,
                "search_depth": "basic",
                "max_results": 5
            });

            if let Ok(res) = client
                .post("https://api.tavily.com/search")
                .json(&payload)
                .send()
                .await
            {
                if res.status().is_success() {
                    if let Ok(json) = res.json::<serde_json::Value>().await {
                        if let Some(results) = json.get("results").and_then(|r| r.as_array()) {
                            let mut output = String::new();
                            for r in results {
                                let title = r.get("title").and_then(|t| t.as_str()).unwrap_or("");
                                let content =
                                    r.get("content").and_then(|c| c.as_str()).unwrap_or("");
                                output.push_str(&format!(
                                    "Title: {}\nContent: {}\n\n",
                                    title, content
                                ));
                            }
                            if !output.is_empty() {
                                println!("Rig Tool: Executing -> Tavily Search API");
                                // 既存の文字数制限(4000文字)に合わせて返す
                                return Ok(output.chars().take(4000).collect());
                            }
                        }
                    }
                }
            }
            // ※ TavilyのAPI呼び出しが失敗した（無料枠切れ、通信エラー等）場合は
            // そのままエラーを出さずに下のObscura(DuckDuckGo)ルートへフォールバック
        }

        // --- 2. 従来の Obscura 処理（URL直接指定、DDG選択時、またはTavily失敗時） ---
        let mut target_url = if is_url {
            query
        } else {
            // URLエンコードする
            let encoded = urlencoding::encode(&query);
            format!("https://html.duckduckgo.com/html/?q={}", encoded)
        };

        // 特定のドメインに対するハック（Reddit対策）
        // www.reddit.com を old.reddit.com に置換することで重いJSを回避
        if target_url.contains("www.reddit.com") {
            target_url = target_url.replace("www.reddit.com", "old.reddit.com");
        }

        println!("Rig Tool: Executing -> {}", target_url);

        #[cfg(target_os = "windows")]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new(&self.obscura_path);
            // ここにフラグを追加することで、Obscura の窓が一切出なくなる
            c.creation_flags(0x08000000);
            c
        };

        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new(&self.obscura_path);

        cmd.args([
            "fetch",
            &target_url,
            "--stealth",
            "--wait-until",
            "load",
            "--eval",
            "document.body.innerText",
        ]);

        let output = cmd
            .output()
            .map_err(|e| WebFetchError::IoError(e.to_string()))?;

        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(text.chars().take(4000).collect())
        } else {
            let err_raw = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(format!("Error during fetching: {}", err_raw)) // AIにエラーを伝えてリトライさせる
        }
    }
}

// --- Tauriコマンドの定義 ---

#[tauri::command]
fn play_bgm_rust(path: String, state: tauri::State<'_, BgmState>) -> Result<(), String> {
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;

    if let Some((_handle, player)) = lock.take() {
        player.stop();
    }

    let handle =
        DeviceSinkBuilder::open_default_sink().map_err(|e| format!("Audio device error: {}", e))?;
    let player = Player::connect_new(&handle.mixer());

    let file = File::open(&path).map_err(|e| format!("BGM file not found: {}", e))?;

    // BufReader::new(file) で包んでから Decoder へ渡す
    let source =
        Decoder::try_from(BufReader::new(file)).map_err(|e| format!("BGM decode error: {}", e))?;

    player.append(source.repeat_infinite());
    player.set_volume(0.5);

    *lock = Some((handle, player));

    Ok(())
}

#[tauri::command]
fn stop_bgm_rust(state: tauri::State<'_, BgmState>) {
    if let Ok(mut lock) = state.0.lock() {
        if let Some((_handle, player)) = lock.take() {
            player.stop();
        }
    }
}

// --- Linux用GPUコンポジット処理分岐ヘルパー群 ---

#[allow(dead_code)]
fn is_nvidia_gpu() -> bool {
    std::path::Path::new("/proc/driver/nvidia").exists()
}

#[allow(dead_code)]
fn is_virtual_machine() -> bool {
    if let Ok(vendor) = std::fs::read_to_string("/sys/class/dmi/id/sys_vendor") {
        let v = vendor.to_lowercase();
        if v.contains("qemu")
            || v.contains("kvm")
            || v.contains("innotek")
            || v.contains("vmware")
            || v.contains("bochs")
        {
            return true;
        }
    }
    if let Ok(prod) = std::fs::read_to_string("/sys/class/dmi/id/product_name") {
        let p = prod.to_lowercase();
        if p.contains("virtualbox") || p.contains("kvm") || p.contains("qemu") || p.contains("utm")
        {
            return true;
        }
    }
    false
}

#[allow(dead_code)]
fn is_compatible_compositor_for_nvidia() -> bool {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.to_lowercase())
        .unwrap_or_default();

    std::env::var("NIRI_SOCKET").is_ok()
        || desktop.contains("niri")
        || desktop.contains("cosmic")
        || desktop.contains("drift")
}

// Niri の IPC コマンドを叩いてカラム幅と高さを指定する
#[tauri::command]
#[allow(unused_variables)]
async fn apply_niri_size_preset(preset: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let is_niri = std::env::var("NIRI_SOCKET").is_ok();
        if !is_niri {
            return Ok(());
        }

        // 1. Niri IPC から全ウィンドウの情報を JSON で取得
        let output = std::process::Command::new("niri")
            .args(["msg", "--json", "windows"])
            .output();

        if let Ok(out) = output {
            if let Ok(json_str) = String::from_utf8(out.stdout) {
                if let Ok(windows) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    if let Some(win_list) = windows.as_array() {
                        // 2. メインエディタのウィンドウ ("mirrorshard-ver02") を直接ピンポイントで特定
                        let main_win = win_list.iter().find(|w| {
                            let title = w.get("title").and_then(|t| t.as_str()).unwrap_or("");
                            title == "mirrorshard-ver02" || title.contains("mirrorshard-ver02")
                        });

                        // 3. メインエディタが見つかったら ID を使ってフォーカスを当ててからリサイズ
                        if let Some(target) = main_win {
                            if let Some(win_id) = target.get("id").and_then(|i| i.as_u64()) {
                                // 現在のフローティング状態を取得
                                let is_currently_floating = target
                                    .get("is_floating")
                                    .and_then(|f| f.as_bool())
                                    .unwrap_or(false);

                                let want_floating = preset == "45x35";

                                // ターゲット指定してフォーカス
                                let _ = std::process::Command::new("niri")
                                    .args([
                                        "msg",
                                        "action",
                                        "focus-window",
                                        "--id",
                                        &win_id.to_string(),
                                    ])
                                    .status();

                                // 状態が食い違っている時だけ toggle する（フロート解除、またはフロート化）
                                if is_currently_floating != want_floating {
                                    let _ = std::process::Command::new("niri")
                                        .args(["msg", "action", "toggle-window-floating"])
                                        .status();
                                }

                                // 各プリセットのサイズ変更
                                if want_floating {
                                    let _ = std::process::Command::new("niri")
                                        .args(["msg", "action", "set-window-width", "35%"])
                                        .status();
                                    let _ = std::process::Command::new("niri")
                                        .args(["msg", "action", "set-window-height", "45%"])
                                        .status();
                                } else {
                                    match preset.as_str() {
                                        "80x35" => {
                                            let _ = std::process::Command::new("niri")
                                                .args(["msg", "action", "set-column-width", "35%"])
                                                .status();
                                            let _ = std::process::Command::new("niri")
                                                .args(["msg", "action", "set-window-height", "80%"])
                                                .status();
                                        }
                                        "90x40" => {
                                            let _ = std::process::Command::new("niri")
                                                .args(["msg", "action", "set-column-width", "40%"])
                                                .status();
                                            let _ = std::process::Command::new("niri")
                                                .args(["msg", "action", "set-window-height", "90%"])
                                                .status();
                                        }
                                        "100x50" => {
                                            let _ = std::process::Command::new("niri")
                                                .args(["msg", "action", "set-column-width", "50%"])
                                                .status();
                                            let _ = std::process::Command::new("niri")
                                                .args([
                                                    "msg",
                                                    "action",
                                                    "set-window-height",
                                                    "100%",
                                                ])
                                                .status();
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// フロントエンドから「Niri環境か否か」だけを直接問い合わせるコマンド
#[tauri::command]
fn is_niri_compositor() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("NIRI_SOCKET").is_ok()
            || std::env::var("XDG_CURRENT_DESKTOP")
                .map(|v| v.to_lowercase().contains("niri"))
                .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false // Linux以外は Niri ではないため false
    }
}

// Niri専用のターミナルフロート化コマンド
#[tauri::command]
async fn setup_niri_floating_terminal() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if is_niri_compositor() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            // 1. フローティング状態にする
            let _ = std::process::Command::new("niri")
                .args(["msg", "action", "toggle-window-floating"])
                .status();

            // 2. 初期サイズ（幅35% × 高さ45%）にセット
            let _ = std::process::Command::new("niri")
                .args(["msg", "action", "set-window-width", "30%"])
                .status();

            let _ = std::process::Command::new("niri")
                .args(["msg", "action", "set-window-height", "40%"])
                .spawn();
        }
    }
    Ok(())
}

// .settings.dat から disableGpuCompositing の設定値を直接読み取るヘルパー
#[allow(dead_code)]
fn is_user_disabled_gpu_compositing() -> bool {
    if let Ok(home) = std::env::var("HOME") {
        let store_path = std::path::PathBuf::from(home)
            .join(".local/share/com.DroicheadNua.mirrorshard2/.settings.dat");

        if store_path.exists() {
            if let Ok(content) = std::fs::read(&store_path) {
                if let Ok(json_str) = String::from_utf8(content) {
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        return data
                            .get("disableGpuCompositing")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    }
                }
            }
        }
    }
    false
}

// 共通判定: GPUコンポジットをオフにすべきか
#[allow(dead_code)]
fn should_disable_gpu_compositing() -> bool {
    let forced_by_env = std::env::var("MIRRORSHARD_DISABLE_COMPOSITING").is_ok();
    let forced_by_settings = is_user_disabled_gpu_compositing(); // 👈 設定画面のチェック

    if forced_by_env || forced_by_settings {
        true // 手動指定時
    } else if is_virtual_machine() {
        true // 仮想環境(VM)の時
    } else if is_nvidia_gpu() {
        !is_compatible_compositor_for_nvidia() // NVIDIA実機: 対応コンポジター以外はOFF
    } else {
        false // Intel / AMD 実機: 無条件でオン
    }
}

// --- フロントエンドからの呼び出しコマンド ---
#[tauri::command]
fn is_full_feature_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        // GPUコンポジットが有効（= should_disable が false）な環境なら全機能を解禁
        !should_disable_gpu_compositing()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true // Windows / macOS は常に全機能解禁
    }
}

// スタック（上下2段組）の対象となる6つのサブウィンドウかを判定する
// 6つのサブウィンドウだけを厳密に判定する（メインエディタの誤認識を防止）
fn is_eligible_stack_target(title: &str, app_id: &str) -> bool {
    // 他のアプリをはじくガード
    if !app_id.to_lowercase().contains("mirrorshard") {
        return false;
    }

    let t = title.to_lowercase();

    // メインエディタ（ファイル名や mirrorshard-ver02）を確実に排除
    if t.contains("mirrorshard-ver02")
        || t.ends_with(".md")
        || t.ends_with(".txt")
        || t.contains("terminal")
        || t.contains("opencode")
        || t.contains("silly")
        || t.contains("diffusion")
        || t.contains("shortcut")
    {
        return false;
    }

    // 6つのサブウィンドウの専用タイトルのみを判定
    t == "ai chat"
        || t == "aiチャット"
        || t == "idea processor"
        || t == "アイデアプロセッサ"
        || t == "vivliostyle dtp export"
        || t == "vivliostyle"
        || t == "markdown preview"
        || t == "markdownプレビュー"
        || t == "settings"
        || t == "設定"
        || t == "preview"
        || t == "プレビュー"
}

// .settings.dat から subWindowHalfHeight (サブウィンドウ2段組化フラグ) を読み出す
fn is_user_enabled_subwindow_half_height() -> bool {
    if let Ok(home) = std::env::var("HOME") {
        let store_path = std::path::PathBuf::from(home)
            .join(".local/share/com.DroicheadNua.mirrorshard2/.settings.dat");

        if store_path.exists() {
            if let Ok(content) = std::fs::read(&store_path) {
                if let Ok(json_str) = String::from_utf8(content) {
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        return data
                            .get("subWindowHalfHeight")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    }
                }
            }
        }
    }
    false
}

// 隣接カラムをスキャンして、条件を満たすターゲットウィンドウの ID を返す
#[allow(dead_code)]
fn find_niri_stack_target_id() -> Option<u64> {
    let output = std::process::Command::new("niri")
        .args(["msg", "--json", "windows"])
        .output()
        .ok()?;

    let json_str = String::from_utf8(output.stdout).ok()?;
    let windows = serde_json::from_str::<serde_json::Value>(&json_str).ok()?;
    let win_list = windows.as_array()?;

    let active_win = win_list.iter().find(|w| {
        w.get("is_focused")
            .and_then(|f| f.as_bool())
            .unwrap_or(false)
            || w.get("is_active")
                .and_then(|f| f.as_bool())
                .unwrap_or(false)
    });

    if let Some(active) = active_win {
        let active_title = active.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let curr_col = get_niri_column_idx(active)?;
        println!(
            "🔍 [Niri Scan] 現在フォーカス中の窓: '{}' (列: {})",
            active_title, curr_col
        );

        let active_id = active.get("id").and_then(|i| i.as_u64());

        let check_column = |col_idx: u64| -> Option<u64> {
            let col_wins: Vec<_> = win_list
                .iter()
                .filter(|w| {
                    let is_same_ws = w.get("workspace_id").and_then(|i| i.as_u64())
                        == active.get("workspace_id").and_then(|i| i.as_u64());
                    let is_same_col = get_niri_column_idx(w) == Some(col_idx);
                    let is_not_self = w.get("id").and_then(|i| i.as_u64()) != active_id;

                    is_same_ws && is_same_col && is_not_self
                })
                .collect();

            if col_wins.len() == 1 {
                let w = col_wins[0];
                let title = w.get("title").and_then(|t| t.as_str()).unwrap_or("");
                // app_id も抽出する
                let app_id = w.get("app_id").and_then(|a| a.as_str()).unwrap_or("");
                let is_floating = w
                    .get("is_floating")
                    .and_then(|f| f.as_bool())
                    .unwrap_or(false);

                // title と app_id の両方を引き渡す
                if !is_floating && is_eligible_stack_target(title, app_id) {
                    println!(
                        "🎯 [Niri Scan] 条件に一致するターゲット窓を発見: '{}' (ID: {})",
                        title,
                        w.get("id").unwrap()
                    );
                    return w.get("id").and_then(|i| i.as_u64());
                }
            }
            None
        };

        // 1. 現在のカラム
        if let Some(id) = check_column(curr_col) {
            return Some(id);
        }
        // 2. 左隣のカラム
        if curr_col > 0 {
            if let Some(id) = check_column(curr_col - 1) {
                return Some(id);
            }
        }
        // 3. 右隣のカラム
        if let Some(id) = check_column(curr_col + 1) {
            return Some(id);
        }
    } else {
        println!("⚠️ [Niri Scan] フォーカス中のウィンドウが検出できませんでした");
    }

    None
}

// スタック実行ヘルパー
#[allow(dead_code)]
async fn try_niri_stack_window(target_id: Option<u64>) {
    // そもそも設定で「ハーフサイズ」が有効になっていなければ何もせず終了
    if !is_user_enabled_subwindow_half_height() {
        return;
    }

    match target_id {
        // -------------------------------------------------------------
        // パターンA: 吸い込み対象（隣接サブウィンドウ）が存在する場合
        // -------------------------------------------------------------
        Some(_target_id) => {
            tokio::time::sleep(Duration::from_millis(150)).await;

            let output = std::process::Command::new("niri")
                .args(["msg", "--json", "windows"])
                .output();

            if let Ok(out) = output {
                if let Ok(json_str) = String::from_utf8(out.stdout) {
                    if let Ok(windows) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        if let Some(win_list) = windows.as_array() {
                            let new_win = win_list.iter().find(|w| {
                                w.get("is_focused")
                                    .and_then(|f| f.as_bool())
                                    .unwrap_or(false)
                                    || w.get("is_active")
                                        .and_then(|f| f.as_bool())
                                        .unwrap_or(false)
                            });

                            let target_win = win_list
                                .iter()
                                .find(|w| w.get("id").and_then(|i| i.as_u64()) == Some(_target_id));

                            if let (Some(new_w), Some(target_w)) = (new_win, target_win) {
                                let target_col = get_niri_column_idx(target_w);
                                let target_ws =
                                    target_w.get("workspace_id").and_then(|i| i.as_u64());
                                let new_col = get_niri_column_idx(new_w);

                                // ターゲット列の現在の枚数を再確認 (3段組防止)
                                let current_count = win_list
                                    .iter()
                                    .filter(|w| {
                                        w.get("workspace_id").and_then(|i| i.as_u64()) == target_ws
                                            && get_niri_column_idx(w) == target_col
                                    })
                                    .count();

                                // ターゲット列が単一パネル（1枚）の時だけ吸い込み
                                if current_count == 1 {
                                    if let (Some(nc), Some(tc)) = (new_col, target_col) {
                                        if nc > tc {
                                            let _ = std::process::Command::new("niri")
                                                .args([
                                                    "msg",
                                                    "action",
                                                    "consume-or-expel-window-left",
                                                ])
                                                .status();
                                        } else if nc < tc {
                                            let _ = std::process::Command::new("niri")
                                                .args([
                                                    "msg",
                                                    "action",
                                                    "consume-window-into-column",
                                                ])
                                                .status();
                                        }

                                        // 吸い込み後に幅40% × 高さ50% に調整
                                        let _ = std::process::Command::new("niri")
                                            .args(["msg", "action", "set-column-width", "40%"])
                                            .status();
                                        let _ = std::process::Command::new("niri")
                                            .args(["msg", "action", "set-window-height", "50%"])
                                            .spawn();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------
        // パターンB: 単独（1つだけ）でサブウィンドウを開いた場合
        // -------------------------------------------------------------
        None => {
            tokio::time::sleep(Duration::from_millis(150)).await;

            // 単独で開いたサブウィンドウのカラム幅を 40%、高さを 60% に直接指定
            let _ = std::process::Command::new("niri")
                .args(["msg", "action", "set-column-width", "40%"])
                .status();

            let _ = std::process::Command::new("niri")
                .args(["msg", "action", "set-window-height", "60%"])
                .spawn();
        }
    }
}

// NiriのウィンドウJSONから列番号(column_idx)を抽出するヘルパー
#[allow(dead_code)]
fn get_niri_column_idx(win: &serde_json::Value) -> Option<u64> {
    win.get("layout")?
        .get("pos_in_scrolling_layout")?
        .get(0)?
        .as_u64()
}

// フロントエンドから show() 直後に呼び出す用のTauriコマンド
#[tauri::command]
async fn trigger_niri_stack() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let is_niri = is_niri_compositor();
        let is_half_enabled = is_user_enabled_subwindow_half_height();

        if is_niri && is_half_enabled {
            // target_id が None (単独起動) の時でも try_niri_stack_window(None) を呼ぶ
            let target_id = find_niri_stack_target_id();
            try_niri_stack_window(target_id).await;
        }
    }
    Ok(())
}

// Pandoc(Haskell)用にUNCプレフィックス(\\?\)を除去し、スラッシュ区切りに整える関数
fn normalize_path_for_pandoc(path: &str) -> String {
    let s = path.replace("\\", "/");
    // //?/ や \\?\ で始まるWindows拡張パスの頭を綺麗に削る
    if let Some(stripped) = s.strip_prefix("//?/") {
        stripped.to_string()
    } else if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        stripped.to_string()
    } else {
        s
    }
}

#[tauri::command]
async fn open_project_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// フォルダ内のMarkdownファイルを検出して配列で返すコマンド（Vivliostyle用）
#[tauri::command]
async fn get_markdown_files(dir_path: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&dir_path).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                // .md と .txt の両方を収集対象にする
                if ext == "md" || ext == "txt" {
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        files.push(file_name.to_string());
                    }
                }
            }
        }
    }

    files.sort(); // 01.txt, 02.md 等をまとめて昇順ソート
    Ok(files)
}

// 任意のテキストファイルを読み込み、UTF-8文字列として返すコマンド
#[tauri::command]
async fn read_local_file_content(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("File read error: {}", e))?;

    // 1. まずUTF-8としてのデコードを試みる
    if let Ok(utf8_str) = String::from_utf8(bytes.clone()) {
        return Ok(utf8_str);
    }

    // 2. UTF-8で失敗した場合（Shift-JISなどの場合）は、encoding_rsで救済デコード
    use encoding_rs::SHIFT_JIS;
    let (cow, _encoding_used, _had_errors) = SHIFT_JIS.decode(&bytes);
    Ok(cow.into_owned())
}

// Linux用: システム上の Chrome / Chromium の絶対パスを優先順位で探す
#[allow(dead_code)]
fn find_linux_chrome_path() -> Option<String> {
    let candidates = [
        "/usr/bin/chromium",             // Debian / Ubuntu / Arch (ARM64 & x86_64)
        "/usr/bin/chromium-browser",     // Raspberry Pi OS
        "/usr/bin/google-chrome-stable", // 一般的な Linux 版 Chrome
        "/run/current-system/sw/bin/google-chrome-stable", // NixOS Chrome
        "/run/current-system/sw/bin/chromium", // NixOS Chromium
    ];

    for path in candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

// Linux/macOS用: npx の絶対パスと、node が存在する PATH を完全自動検出する
fn resolve_npx_and_path() -> (String, String) {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut path_dirs = Vec::new();
    let mut found_npx = None;

    // 1. nvm のベースディレクトリの候補（標準、XDG準拠、環境変数）
    let mut nvm_base_dirs = vec![
        format!("{}/.nvm/versions/node", home),
        format!("{}/.config/nvm/versions/node", home), // NixOS等で使われるパスを追加
    ];
    if let Ok(nvm_dir_env) = std::env::var("NVM_DIR") {
        nvm_base_dirs.push(format!("{}/versions/node", nvm_dir_env));
    }

    // NVMの各候補ディレクトリを探索し、最新バージョンの bin を探す
    for nvm_base in nvm_base_dirs {
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            let mut node_dirs: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            node_dirs.sort(); // 昇順ソート
            node_dirs.reverse(); // 最新バージョンを先頭に

            for dir in node_dirs {
                let bin_dir = dir.join("bin");
                if bin_dir.exists() {
                    let npx_bin = bin_dir.join("npx");
                    if found_npx.is_none() && npx_bin.exists() {
                        found_npx = Some(npx_bin.to_string_lossy().to_string());
                    }
                    path_dirs.push(bin_dir.to_string_lossy().to_string());
                }
            }
        }
    }

    // 2. その他の標準設置パス候補
    let user = std::env::var("USER").unwrap_or_default();
    let standard_dirs = [
        format!("{}/.npm-global/bin", home),
        format!("{}/.nodebrew/current/bin", home),
        format!("{}/.n/bin", home),
        format!("{}/.local/bin", home),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/run/current-system/sw/bin".to_string(),
        format!("/etc/profiles/per-user/{}/bin", user),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];

    for dir_str in standard_dirs {
        let p = std::path::Path::new(&dir_str);
        if p.exists() {
            let npx_bin = p.join("npx");
            if found_npx.is_none() && npx_bin.exists() {
                found_npx = Some(npx_bin.to_string_lossy().to_string());
            }
            path_dirs.push(dir_str.to_string());
        }
    }

    if let Ok(current) = std::env::var("PATH") {
        path_dirs.push(current);
    }

    let final_npx = found_npx.unwrap_or_else(|| "npx".to_string());
    let final_path = path_dirs.join(":");

    (final_npx, final_path)
}

// 🛠️ 共通ヘルパー: OS別の Vivliostyle コマンド（preview / build）を一括構築する
fn create_vivliostyle_command(
    subcommand: &str,
    extra_args: &[&str],
    project_path: &str,
) -> std::process::Command {
    if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("cmd");
        let mut c_args = vec!["/C", "npx", "-y", "@vivliostyle/cli", subcommand];
        c_args.extend(extra_args);
        c.args(c_args);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c.current_dir(project_path);
        c
    } else {
        // 👇 Linux/macOS: /bin/sh を経由し、PATHを確実に反映させてから実行する
        let (npx_path, extended_path) = resolve_npx_and_path();

        let mut c = std::process::Command::new("sh");
        c.arg("-c");
        // シェル内でPATHをエクスポートし、$0(npx) に $@(引数リスト) を渡して実行
        c.arg(format!("export PATH=\"{}\"; \"$0\" \"$@\"", extended_path));

        // $0 の中身
        c.arg(npx_path);

        // $@ の中身 (引数リスト)
        let mut cli_args = vec![
            "-y".to_string(),
            "@vivliostyle/cli".to_string(),
            subcommand.to_string(),
        ];

        for extra in extra_args {
            cli_args.push(extra.to_string());
        }

        // Linux 用 Chrome / Chromium 自動検出
        #[cfg(target_os = "linux")]
        {
            if let Some(chrome_path) = find_linux_chrome_path() {
                cli_args.push("--executable-browser".to_string());
                cli_args.push(chrome_path);
            }
        }

        // macOS 用 Chrome 検出
        #[cfg(target_os = "macos")]
        {
            let mac_chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
            if std::path::Path::new(mac_chrome).exists() {
                cli_args.push("--executable-browser".to_string());
                cli_args.push(mac_chrome.to_string());
            }
        }

        c.args(cli_args);
        c.current_dir(project_path);
        c
    }
}

#[tauri::command]
async fn build_vivliostyle_pdf(project_path: String) -> Result<String, String> {
    let mut cmd = create_vivliostyle_command("build", &[], &project_path);

    let output = cmd
        .output()
        .map_err(|e| format!("PDFビルドプロセスの実行に失敗しました: {}", e))?;

    if output.status.success() {
        Ok("PDFの生成が完了しました。".to_string())
    } else {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("PDF生成エラー: {}", err_msg))
    }
}

#[tauri::command]
async fn start_vivliostyle_preview(
    _app: tauri::AppHandle,
    project_path: String,
    state: tauri::State<'_, VivliostyleProcess>,
) -> Result<(), String> {
    // 既存のプレビュープロセスがあれば殺す
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }

        // 共通関数でコマンド生成 (--port 8123 を付与)
        let mut cmd = create_vivliostyle_command("preview", &["--port", "8123"], &project_path);

        let child = cmd
            .spawn()
            .map_err(|e| format!("ERR_VIVLIOSTYLE_SPAWN:{}", e))?;

        *lock = Some(child);
    }

    Ok(())
}

#[tauri::command]
async fn open_sd_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, SdServerProcess>,
    exe_path: String,
    model_path: String,
    prompt: String,
    neg_prompt: String,
    steps: u32,
    cfg: f32,
    sampler: String,
    scheduler: String,
    resolution: String,
) -> Result<(), String> {
    // 1. トグル処理
    if let Some(win) = app.get_webview_window("sd_server") {
        let _ = win.close();
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }
        return Ok(());
    }

    let exe_file = std::path::Path::new(&exe_path);
    let exe_dir = exe_file.parent().ok_or("Failed to get exe directory")?;

    let parts: Vec<&str> = resolution.split('x').collect();
    let width = parts.get(0).unwrap_or(&"512");
    let height = parts.get(1).unwrap_or(&"512");

    // 2. サーバープロセス起動
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }

        let mut cmd = std::process::Command::new(&exe_path);
        cmd.current_dir(exe_dir);

        // Windows 向け DLL パス追加と窓隠し
        #[cfg(target_os = "windows")]
        {
            if let Ok(existing_path) = std::env::var("PATH") {
                cmd.env("PATH", format!("{};{}", exe_dir.display(), existing_path));
            }
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        // Mac 向け dylib パス追加 (これで Gatekeeper / Library not loaded を回避)
        #[cfg(target_os = "macos")]
        {
            if let Ok(existing_path) = std::env::var("DYLD_LIBRARY_PATH") {
                cmd.env(
                    "DYLD_LIBRARY_PATH",
                    format!("{}:{}", exe_dir.display(), existing_path),
                );
            } else {
                cmd.env("DYLD_LIBRARY_PATH", exe_dir.display().to_string());
            }
        }

        cmd.args(["--listen-port", "8888", "-m", &model_path]);

        // 空でなければ引数に追加（初期プロンプトとしてUIにセット）
        if !prompt.is_empty() {
            cmd.args(["-p", &prompt]);
        }
        if !neg_prompt.is_empty() {
            cmd.args(["-n", &neg_prompt]);
        }

        cmd.args([
            "--steps",
            &steps.to_string(),
            "--cfg-scale",
            &cfg.to_string(),
            "--sampling-method",
            &sampler,
            "--scheduler",
            &scheduler,
            "-W",
            width,
            "-H",
            height,
            "-s",
            "-1",
        ]);

        // バッファ詰まり防止
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| format!("ERR_SD_SERVER_SPAWN:{}", e))?;
        *lock = Some(child);
    }

    // 3. 表示処理のOS分岐
    let _app_handle = app.clone();

    #[cfg(target_os = "linux")]
    {
        // Linux: ポート監視して標準ブラウザで開く
        std::thread::spawn(move || {
            let addr = "127.0.0.1:8888";
            for _ in 0..150 {
                // モデルロードを考慮して長めに
                if std::net::TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    std::time::Duration::from_millis(200),
                )
                .is_ok()
                {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = _app_handle
                        .opener()
                        .open_url("http://127.0.0.1:8888", Option::<String>::None);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Windows/Mac: 専用ウィンドウを loading 経由で生成
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "sd_server",
            tauri::WebviewUrl::App("loading.html".into()),
        )
        .title("Stable Diffusion C++ Server (Loading...)")
        .inner_size(1100.0, 850.0)
        .decorations(true);

        #[cfg(target_os = "windows")]
        let builder = builder.theme(Some(tauri::Theme::Dark));

        let window = builder.build().map_err(|e| e.to_string())?;

        // ポート監視してURL切り替え
        std::thread::spawn(move || {
            let addr = "127.0.0.1:8888";
            for _ in 0..150 {
                if std::net::TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    std::time::Duration::from_millis(200),
                )
                .is_ok()
                {
                    let _ = window.eval("window.location.href = 'http://127.0.0.1:8888'");
                    let _ = window.set_title("Stable Diffusion C++ Server");
                    return;
                }
                if window.is_closable().is_err() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }

    Ok(())
}

#[tauri::command]
async fn generate_image_cpp(
    state: tauri::State<'_, SdCppProcess>,
    exe_path: String,
    model_path: String,
    prompt: String,
    neg_prompt: String,
    steps: u32,
    cfg: f32,
    sampler: String,
    scheduler: String,
    width: u32,
    height: u32,
    save_dir: String,
) -> Result<String, String> {
    let exe_file = std::path::Path::new(&exe_path);
    let exe_dir = exe_file.parent().ok_or("Failed to get exe directory")?;

    // 1. 最終的な保存パス（日本語OK）
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let file_name = format!("ms_cpp_{}.png", timestamp);
    let final_output_path = std::path::Path::new(&save_dir).join(&file_name);

    // 2. sd-cli用の「一時的なASCII出力パス」(C言語の日本語エラーを防ぐ)
    // exeと同じフォルダに ms_temp.png として出させる
    let temp_output_name = "ms_temp_gen.png";
    let temp_output_path = exe_dir.join(temp_output_name);

    let mut cmd = std::process::Command::new(&exe_path);
    cmd.current_dir(exe_dir);

    // DLL対策のPATH追加
    if let Ok(existing_path) = std::env::var("PATH") {
        let new_path = format!("{};{}", exe_dir.display(), existing_path);
        cmd.env("PATH", new_path);
    }

    // --- Windows 向け DLL 読み込み対策 ---
    #[cfg(target_os = "windows")]
    {
        if let Ok(existing_path) = std::env::var("PATH") {
            let new_path = format!("{};{}", exe_dir.display(), existing_path);
            cmd.env("PATH", new_path);
        }
        // 窓を隠すフラグ
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    // --- Mac 向け dylib 読み込み対策 ---
    #[cfg(target_os = "macos")]
    {
        // macOSのダイナミックリンカーに、exeと同じフォルダを探すよう強制する
        if let Ok(existing_path) = std::env::var("DYLD_LIBRARY_PATH") {
            let new_path = format!("{}:{}", exe_dir.display(), existing_path); // Macはコロン(:)区切り
            cmd.env("DYLD_LIBRARY_PATH", new_path);
        } else {
            cmd.env("DYLD_LIBRARY_PATH", exe_dir.display().to_string());
        }
    }

    cmd.args([
        "-m",
        &model_path,
        "-p",
        &prompt,
        "-n",
        &neg_prompt,
        "--steps",
        &steps.to_string(),
        "--cfg-scale",
        &cfg.to_string(),
        "--sampling-method",
        &sampler,
        "--scheduler",
        &scheduler,
        "-W",
        &width.to_string(),
        "-H",
        &height.to_string(),
        "-s",
        "-1",
        "-o",
        temp_output_name, // ディレクトリを含まない「ファイル名のみ」を渡すのが最も安全
    ]);

    // プロセスを開始し、ハンドルを保存する
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sd-cli: {}", e))?;

    {
        let mut lock = state.0.lock().unwrap();
        *lock = Some(child);
    } // ここでロックが解放される

    // 4. プロセスの終了を「監視」する
    // ロックを長時間持たないようにループ内で try_wait を使う
    loop {
        // 中断されたか確認
        {
            let lock = state.0.lock().unwrap();
            if lock.is_none() {
                return Err("ABORTED".to_string());
            }
        }

        // 終了したか確認
        {
            let mut lock = state.0.lock().unwrap();
            if let Some(child) = lock.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // 終了した
                        if status.success() {
                            break;
                        } else {
                            return Err(format!("sd-cli failed with code: {:?}", status.code()));
                        }
                    }
                    Ok(None) => { /* まだ実行中 */ }
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        // CPU負荷を抑えるために少し待機
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // 成功後の処理 (ファイル移動)
    if temp_output_path.exists() {
        std::fs::rename(&temp_output_path, &final_output_path).map_err(|e| e.to_string())?;
        Ok(final_output_path.to_str().unwrap().to_string())
    } else {
        Err("Output file not found".to_string())
    }
}

// アボート用コマンド
#[tauri::command]
async fn abort_image_cpp(state: tauri::State<'_, SdCppProcess>) -> Result<(), String> {
    let mut lock = state.0.lock().unwrap();
    if let Some(mut child) = lock.take() {
        println!("Aborting sd-cli process...");
        kill_child_tree(&mut child); // 既存の心中関数を利用
    }
    Ok(())
}

#[tauri::command]
async fn run_web_agent(
    api_type: String,
    api_key: String,
    base_url: String,
    model: String,
    obscura_path: String,
    system_prompt: String,
    prompt: String,
    search_engine: String,
    tavily_api_key: String,
) -> Result<String, String> {
    let web_search_tool = WebSearchTool {
        obscura_path,
        search_engine,
        tavily_api_key,
    };
    let actual_key = if api_key.is_empty() {
        "sk-local".to_string()
    } else {
        api_key.clone()
    };

    let result = match api_type.as_str() {
        "gemini" => {
            std::env::set_var("GEMINI_API_KEY", &api_key);
            let client = rig::providers::gemini::Client::from_env().map_err(|e| e.to_string())?;
            let mut agent = client
                .agent(&model)
                .preamble(&system_prompt)
                .tool(web_search_tool)
                .build();
            agent.default_max_turns = Some(10);
            agent
                .prompt(&prompt)
                .await
                .map_err(|e| format!("Gemini Error: {}", e))?
        }
        "groq" => {
            std::env::set_var("GROQ_API_KEY", &actual_key);
            let client = rig::providers::groq::Client::from_env().map_err(|e| e.to_string())?;
            let mut agent = client
                .agent(&model)
                .preamble(&system_prompt)
                .tool(web_search_tool)
                .build();
            agent.default_max_turns = Some(10);
            agent
                .prompt(&prompt)
                .await
                .map_err(|e| format!("Groq Error: {}", e))?
        }
        "mistral" => {
            std::env::set_var("MISTRAL_API_KEY", &actual_key);
            let client = rig::providers::mistral::Client::from_env().map_err(|e| e.to_string())?;
            let mut agent = client
                .agent(&model)
                .preamble(&system_prompt)
                .tool(web_search_tool)
                .build();
            agent.default_max_turns = Some(10);
            agent
                .prompt(&prompt)
                .await
                .map_err(|e| format!("Mistral Error: {}", e))?
        }
        "cohere" => {
            return Err("Web Agent is not supported for Cohere in this version.".to_string());
        }
        "cerebras" => {
            return Err("Web Agent is not supported for Cerebras in this version.".to_string());
        }
        _ => {
            // Local LLM
            std::env::set_var("OPENAI_API_KEY", &actual_key);
            if !base_url.is_empty() {
                std::env::set_var("OPENAI_API_BASE", &base_url);
                std::env::set_var("OPENAI_BASE_URL", &base_url);
            }
            let client = rig::providers::openai::Client::from_env().map_err(|e| e.to_string())?;

            // Local は確実に /chat/completions を叩かせるための処理
            let model_instance = client.completion_model(&model);
            let mut agent = rig::agent::AgentBuilder::new(model_instance)
                .preamble(&system_prompt)
                .tool(web_search_tool)
                .build();

            agent.default_max_turns = Some(10);
            agent
                .prompt(&prompt)
                .await
                .map_err(|e| format!("Local AI Error: {}", e))?
        }
    };

    Ok(result)
}

// 汎用ポートモニタ
#[tauri::command]
async fn start_port_monitor(app: tauri::AppHandle, port: u16, url: String) {
    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", port);
        // 5分〜10分程度監視 (1秒おきに300〜600回)
        for _ in 0..300 {
            if std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                std::time::Duration::from_millis(500),
            )
            .is_ok()
            {
                // ポートを検知したら指定のURLをブラウザで開く
                let _ = app.opener().open_url(&url, Option::<String>::None);
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
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
    let _ = enable_st_terminal;
    // 1. トグル処理
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            // すでにプロセスがあるなら、殺して終了（OFFにする）
            kill_child_tree(&mut child);

            // もし専用ウィンドウ（Win/Mac）が開いていればそれも閉じる
            if let Some(win) = app.get_webview_window("silly_tavern") {
                let _ = win.close();
            }
            return Ok("closed".to_string());
        }
        // プロセスがない場合は、そのまま下へ進んで起動処理を行う
    }

    // 2. パス判定
    let st_path = st_path_setting.unwrap_or_default();
    if st_path.is_empty() || !std::path::Path::new(&st_path).exists() {
        return Err("ERR_ST_PATH_NOT_FOUND".to_string());
    }

    // --- 3. ロード画面を「先に」表示 (Windows/Mac用) ---
    let window = {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "silly_tavern",
            tauri::WebviewUrl::App("loading.html".into()),
        )
        .title("SillyTavern (Loading...)")
        .inner_size(1200.0, 900.0)
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

        #[cfg(target_os = "windows")]
        let builder = builder.theme(Some(tauri::Theme::Dark));

        builder.build().map_err(|e| e.to_string())?
    };

    // --- 4. サーバープロセス起動 ---
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }

        #[cfg(target_os = "windows")]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "node server.js"]);

            if enable_st_terminal {
                // 確実に新しい窓を出すフラグ
                c.creation_flags(0x00000010);
            } else {
                // 完全に隠すフラグ
                c.creation_flags(0x08000000);
                c.stdout(Stdio::null());
                c.stderr(Stdio::null());
            }
            c
        };

        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = std::process::Command::new(resolve_node_path());
            c.arg("server.js");
            // Mac/Linuxは常に非表示（ゾンビ化防止）
            c.stdout(Stdio::null());
            c.stderr(Stdio::null());
            c
        };

        cmd.current_dir(&st_path);
        let child = cmd.spawn().map_err(|e| format!("ERR_ST_SPAWN:{}", e))?;
        *lock = Some(child);
    }

    // --- 5. 表示・監視 ---

    // Windows/Mac: ポート監視してURL切り替え
    std::thread::spawn(move || {
        let addr = "127.0.0.1:8000";
        for _ in 0..100 {
            if std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                std::time::Duration::from_millis(200),
            )
            .is_ok()
            {
                let _ = window.eval("window.location.href = 'http://127.0.0.1:8000'");
                let _ = window.set_title("SillyTavern");
                return;
            }
            if window.is_closable().is_err() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });

    Ok("opened".to_string())
}

#[tauri::command]
async fn open_opencode(
    app: tauri::AppHandle,
    state: State<'_, OpenCodeProcess>,
) -> Result<(), String> {
    // 1. トグル処理 (ウィンドウがある場合のみ。Linuxでは基本スルーされる)
    if let Some(win) = app.get_webview_window("opencode") {
        let _ = win.close();
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }
        return Ok(());
    }

    // 2. サーバー起動
    {
        let mut lock = state.inner().0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            kill_child_tree(&mut child);
        }

        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "set BROWSER=true && opencode serve --port 4096"]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x08000000);
            }
            c
        } else {
            // Mac/Linux 共通のパス解決
            let brew_path = "/opt/homebrew/bin/opencode";
            let intel_path = "/usr/local/bin/opencode";

            let final_cmd = if std::path::Path::new(brew_path).exists() {
                brew_path.to_string()
            } else if std::path::Path::new(intel_path).exists() {
                intel_path.to_string()
            } else {
                "opencode".to_string() // Linux や、PATHが通っている環境
            };

            let mut c = std::process::Command::new(final_cmd);
            c.args(["serve", "--port", "4096"]);
            c.env("BROWSER", "true");

            // 出力は捨てる（バッファ詰まり防止）
            c.stdout(Stdio::null());
            c.stderr(Stdio::null());
            c
        };

        let child = cmd
            .spawn()
            .map_err(|e| format!("ERR_OPENCODE_SPAWN:{}", e))?;
        *lock = Some(child);
        std::thread::sleep(std::time::Duration::from_millis(2000)); // 2秒待機してサーバーを安定させる。この行がないとMacOSで正常に起動しない
    }

    // 3. 表示処理

    // Windows/Mac: 専用ウィンドウを生成
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

    // セッションID自体をユニークにする
    let session_id = match input_id.as_str() {
        "sd" | "st" | "oc" => input_id.clone(),
        _ => format!(
            "main_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ),
    };

    let label = format!("terminal_{}", session_id);

    // SD, ST, OC 用の場合のみ、既に開いていればフォーカスして終了
    if session_id == "sd" || session_id == "st" || session_id == "oc" {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_focus();
            return Ok(());
        }
    }

    // ユニークなIDをURLに渡す
    let url = format!("terminal.html?id={}", session_id);

    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(match session_id.as_str() {
                "sd" => "Stable Diffusion Console",
                "st" => "SillyTavern Console",
                "oc" => "OpenCode Console",
                _ => "Terminal",
            })
            .inner_size(640.0, 480.0) // デフォルトサイズ
            .min_inner_size(640.0, 480.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .visible(false);

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

    // portable_ptyのChildからPIDを取得（数値に変換）
    let pid = child.process_id().unwrap_or(0) as u32;

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
                pid,
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
}

#[tauri::command]
async fn open_vivliostyle(app: AppHandle) {
    if app.get_webview_window("vivliostyle").is_some() {
        app.get_webview_window("vivliostyle")
            .unwrap()
            .close()
            .unwrap();
        return;
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "vivliostyle",
        tauri::WebviewUrl::App("vivliostyle.html".into()),
    )
    .title("Vivliostyle")
    .inner_size(640.0, 800.0)
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
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

// Linux限定のEPUB出力用動的CSSパッチ（約物の回転処理）
fn prepare_css_for_pandoc(app: &AppHandle, original_resource_path: &str) -> Result<String, String> {
    // 1. まず元のCSSファイルの絶対パスを解決する
    let resolved_path = resolve_resource_path(app, original_resource_path)?;

    // 2. コンパイル・実行環境が Linux のときだけ一時ファイルを生成してパッチを当てる
    #[cfg(target_os = "linux")]
    {
        // 元のCSSファイルを読み込む
        if let Ok(content) = fs::read_to_string(&resolved_path) {
            let mut patched_content = content;
            // 縦書きの記号回転用パッチを末尾に追記
            patched_content.push_str("\nbody { font-feature-settings: \"vert\" 1 !important; -webkit-font-feature-settings: \"vert\" 1 !important; }\n");

            // 一時フォルダ（Temp）に、元のファイル名と同じ一時ファイルを書き出す
            let temp_dir = std::env::temp_dir();
            let filename = Path::new(original_resource_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            let temp_css_path = temp_dir.join(format!("temp_{}", filename));

            if fs::write(&temp_css_path, patched_content).is_ok() {
                // パッチが当たった一時ファイルのパスを返す
                return Ok(temp_css_path.to_string_lossy().to_string());
            }
        }
    }

    // Windows や Mac（またはフォールバック）では元のファイルを無改造のまま直接返す
    Ok(resolved_path)
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

    // Windowsのバックスラッシュ(\)をすべてスラッシュ(/)に置換してPandocのバグを回避する
    let clean_input_md = normalize_path_for_pandoc(&input_md.to_string_lossy());
    let clean_output_path = normalize_path_for_pandoc(&output_path);

    // 3. コマンド構築
    let mut cmd = Command::new(&pandoc_exe);
    cmd.arg(&clean_input_md);

    // 共通オプション
    cmd.arg("--standalone");

    // HTMLタグ (<ruby> や <span class="tcy">) を保持して読み込ませる
    cmd.arg("--from").arg("markdown+raw_html");

    // メタデータ設定
    if let Some(title) = metadata.get("title").and_then(|v| v.as_str()) {
        cmd.arg("--metadata").arg(format!("title={}", title));
    }
    if let Some(author) = metadata.get("author").and_then(|v| v.as_str()) {
        cmd.arg("--metadata").arg(format!("author={}", author));
    }

    let cover_image = metadata.get("cover").and_then(|v| v.as_str());

    cmd.arg("--metadata").arg("lang=ja");

    // フォーマット別処理
    match format.as_str() {
        "epub" => {
            cmd.arg("-o").arg(&clean_output_path);
            if is_vertical {
                let css_path = prepare_css_for_pandoc(&app, "resources/styles/epubvertical.css")?;
                cmd.arg("--css").arg(normalize_path_for_pandoc(&css_path));
                cmd.arg("--metadata").arg("page-progression-direction=rtl");
            }

            if let Some(cover) = cover_image {
                if !cover.is_empty() {
                    cmd.arg(format!(
                        "--epub-cover-image={}",
                        normalize_path_for_pandoc(&cover)
                    ));
                }
            }
        }

        "html" => {
            cmd.arg("-o").arg(&clean_output_path);
            cmd.arg("--embed-resources");
            cmd.arg("--standalone");

            if is_vertical {
                let css_path = prepare_css_for_pandoc(&app, "resources/styles/vertical.css")?;
                cmd.arg("--css").arg(normalize_path_for_pandoc(&css_path));
            }
        }
        "docx" => {
            cmd.arg("-o").arg(&clean_output_path);
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
            "vivliostyle",
            [("ja", "Vivliostyle"), ("en", "Vivliostyle")].into(),
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
    #[cfg(target_os = "macos")]
    {
        let _ = window.eval("document.body.classList.add('is-mac');");
    }
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
}

// フロントエンドからの表示準備完了を検知するハンドシェイク用コマンド
#[tauri::command]
fn ping_window_ready(_label: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    println!(
        "[IPC Handshake] Sub-window '{}' is fully rendered and ready to show.",
        _label
    );
    Ok(())
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
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
    let _window = builder.devtools(true).build().unwrap();
    #[cfg(not(debug_assertions))]
    let _window = builder.build().unwrap();
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
    // Linux環境での起動時判定
    #[cfg(target_os = "linux")]
    {
        // 1. Wayland環境であれば GTK_IM_MODULE=wayland を強制セット（インライン変換の有効化）
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|v| v == "wayland")
                .unwrap_or(false);

        if is_wayland {
            println!("Wayland detected: Setting GTK_IM_MODULE=wayland for inline IME composition.");
            std::env::set_var("GTK_IM_MODULE", "wayland");
        }

        // 2. GPUコンポジットの自動判定
        if should_disable_gpu_compositing() {
            println!("Linux: Disabling WebKit GPU compositing mode for stability.");
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        } else {
            println!("Linux: Enabling WebKit GPU compositing mode.");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cli::init())
        .manage(BgmState(Mutex::new(None)))
        .manage(MacFileBuffer(Mutex::new(None)))
        .manage(InitialFile(Mutex::new(None))) // 最初の起動用
        .manage(SecondInstanceFile(Mutex::new(None))) // 2回目以降の起動用
        // TerminalStateの初期化 (HashMap)
        .manage(TerminalState(Mutex::new(HashMap::new())))
        .manage(OpenCodeProcess(Mutex::new(None)))
        .manage(SillyTavernProcess(Mutex::new(None)))
        .manage(SdCppProcess(Mutex::new(None)))
        .manage(SdServerProcess(Mutex::new(None)))
        .manage(VivliostyleProcess(Mutex::new(None)))
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
            open_vivliostyle,
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
            start_port_monitor,
            run_web_agent,
            generate_image_cpp,
            abort_image_cpp,
            open_sd_server,
            read_local_file_content,
            get_markdown_files,
            start_vivliostyle_preview,
            build_vivliostyle_pdf,
            open_project_folder,
            is_full_feature_supported,
            play_bgm_rust,
            stop_bgm_rust,
            is_niri_compositor,
            apply_niri_size_preset,
            trigger_niri_stack,
            ping_window_ready,
            setup_niri_floating_terminal,
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
                    "vivliostyle_preview" => {
                        if let Some(state) = window.try_state::<VivliostyleProcess>() {
                            if let Ok(mut lock) = state.0.lock() {
                                if let Some(mut child) = lock.take() {
                                    kill_child_tree(&mut child);
                                }
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
                    "sd_server" => {
                        if let Some(state) = window.try_state::<SdServerProcess>() {
                            if let Ok(mut lock) = state.0.lock() {
                                if let Some(mut child) = lock.take() {
                                    kill_child_tree(&mut child);
                                }
                            }
                        }
                    }
                    _ if label.starts_with("terminal_") => {
                        let id = label.replace("terminal_", "");
                        if let Some(state) = window.try_state::<TerminalState>() {
                            if let Ok(mut sessions) = state.0.lock() {
                                if let Some(session) = sessions.remove(&id) {
                                    // ★ PIDを使ってプロセスを殺す
                                    #[cfg(target_os = "windows")]
                                    {
                                        use std::os::windows::process::CommandExt;
                                        let _ = std::process::Command::new("taskkill")
                                            .args(["/F", "/T", "/PID", &session.pid.to_string()])
                                            .creation_flags(0x08000000)
                                            .spawn();
                                    }
                                    #[cfg(not(target_os = "windows"))]
                                    {
                                        // Linux/Mac: プロセスグループごと殺す (-記号をPIDの前に付けるのが定石)
                                        let _ = std::process::Command::new("kill")
                                            .arg("-9")
                                            .arg(format!("-{}", session.pid)) // グループキル
                                            .spawn();

                                        // 万が一グループキルが効かない時の保険（自分自身を殺す）
                                        let _ = std::process::Command::new("kill")
                                            .arg("-9")
                                            .arg(session.pid.to_string())
                                            .spawn();
                                    }
                                    println!(
                                        "PTY Terminal PID {} killed for ID: {}",
                                        session.pid, id
                                    );
                                }
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
                if let Some(state) = app_handle.try_state::<VivliostyleProcess>() {
                    if let Ok(mut lock) = state.0.lock() {
                        if let Some(mut child) = lock.take() {
                            kill_child_tree(&mut child);
                        }
                    }
                }
                if let Ok(mut lock) = app_handle.state::<SillyTavernProcess>().inner().0.lock() {
                    if let Some(mut child) = lock.take() {
                        kill_child_tree(&mut child);
                    }
                }
                if let Some(state) = app_handle.try_state::<SdServerProcess>() {
                    if let Ok(mut lock) = state.0.lock() {
                        if let Some(mut child) = lock.take() {
                            kill_child_tree(&mut child);
                        }
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

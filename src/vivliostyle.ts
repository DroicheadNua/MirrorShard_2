import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { type } from "@tauri-apps/plugin-os";
import { listen } from "@tauri-apps/api/event";
import { Store } from "@tauri-apps/plugin-store";
import {
  initI18n,
  applyTranslationsToDOM,
  t,
} from "./i18n";
import updateArticle from "./scripts/ruby";

// read_file が返すオブジェクトの型定義
interface FileData {
  content: string;
  encoding: string;
}

const appWindow = getCurrentWindow();
const osType = type();

// --- メモリ上の DOM を使って文字列の青空ルビを HTML ルビに変換するヘルパー ---
function convertAozoraRubyToHtml(rawText: string): string {
  const tempDiv = document.createElement("div");
  // 改行や特殊文字を維持したままテキストノードとしてセット
  tempDiv.textContent = rawText;

  // ruby.ts
  updateArticle(tempDiv);

  // 変換後の HTML 文字列を返す
  return tempDiv.innerHTML;
}

class VivliostyleManager {
  // DOM要素
  private folderPathInput = document.getElementById("project-folder-path") as HTMLInputElement;
  private btnSelectFolder = document.getElementById("btn-select-folder") as HTMLButtonElement;
  private btnUpdateFiles = document.getElementById("btn-update-files") as HTMLButtonElement;

  private presetSelector = document.getElementById("preset-selector") as HTMLSelectElement;
  private paperSize = document.getElementById("paper-size") as HTMLSelectElement;
  private direction = document.getElementById("direction") as HTMLSelectElement;
  private columns = document.getElementById("columns") as HTMLSelectElement;

  private marginTop = document.getElementById("margin-top") as HTMLInputElement;
  private marginBottom = document.getElementById("margin-bottom") as HTMLInputElement;
  private marginInside = document.getElementById("margin-inside") as HTMLInputElement;
  private marginOutside = document.getElementById("margin-outside") as HTMLInputElement;

  private btnOpenTerminal = document.getElementById("btn-open-terminal") as HTMLButtonElement;
  private btnPreview = document.getElementById("btn-preview") as HTMLButtonElement;
  private btnBuildPdf = document.getElementById("btn-build-pdf") as HTMLButtonElement;

  private fullscreenBtn = document.getElementById("btn-maximize") as HTMLButtonElement;
  private minimizeBtn = document.getElementById("btn-minimize") as HTMLButtonElement;
  private closeBtn = document.getElementById("btn-close") as HTMLButtonElement;
  private wrapper = document.getElementById("vivliostyle-wrapper") as HTMLDivElement;

  // 現在選択中のフォルダパス
  private currentProjectPath: string | null = null;
  private store: Store | null = null;
  private isSimpleFullscreen = false;

  // 非同期の初期化を順番に実行する
  public async init() {
    this.store = await Store.load(".settings.dat");

    // 1. 言語読み込み
    const appLang = (await this.store.get<string>("appLanguage")) ?? "ja";
    await initI18n(appLang === "en" ? "en" : "ja");

    // 2. システムフォント一覧の取得＆ドロップダウン生成
    await this.loadSystemFonts();

    // 3. 保存されている Vivliostyle 設定の復元
    await this.loadSavedSettings();

    // 4. DOMに翻訳を反映
    applyTranslationsToDOM();

    // 5. 言語変更のイベント監視
    await listen<string>("app:language-changed", async (event) => {
      await initI18n(event.payload === "en" ? "en" : "ja");
      applyTranslationsToDOM();
    });
  }

  constructor() {
    this.setupWindowControls();
    this.setupEventListeners();
  }

  // --- 1. カスタムタイトルバーの操作 ---
  private setupWindowControls() {
    this.minimizeBtn?.addEventListener("click", () => appWindow.minimize());
    this.fullscreenBtn?.addEventListener("click", async () => {
      this.vivliostyleToggleFullscreen();
    });
    this.closeBtn?.addEventListener("click", () => invoke("open_vivliostyle"));
  }

  // --- 2. イベントリスナーの設定 ---
  private setupEventListeners() {
    // 右クリックメニューの無効化
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });

    // キーボードショートカットの登録
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      this.handleKeyDown(e);
    });

    // フォルダ選択
    this.btnSelectFolder.addEventListener("click", async () => {
      await this.selectProjectFolder();
    });

    // プリセット変更
    this.presetSelector.addEventListener("change", () => {
      this.applyPreset(this.presetSelector.value);
      this.saveSettings()
    });

    // 設定ファイル更新・作成
    this.btnUpdateFiles.addEventListener("click", async () => {
      await this.updateConfigurationFiles();
      this.saveSettings();
    });

    // ターミナルを開く
    this.btnOpenTerminal.addEventListener("click", async () => {
      await this.openTerminalInProject();
    });

    // プレビュー
    this.btnPreview.addEventListener("click", async () => {
      await this.startPreview();
    });

    // PDFエクスポート
    this.btnBuildPdf.addEventListener("click", async () => {
      await this.buildPdf();
    });

    // フォント選択変更時の保存
    const fontSelect = document.getElementById("font-family-select") as HTMLSelectElement;
    fontSelect?.addEventListener("change", async () => {
      if (this.store) {
        await this.store.set("vivliostyleFontFamily", fontSelect.value);
        await this.store.save();
      }
    });

  }

  // ショートカット
  private handleKeyDown(e: KeyboardEvent) {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isMac = osType === "macos";
    const isCtrl = e.ctrlKey;
    const isCmd = e.metaKey;

    // Ctrl + Shift + B : 閉じる (メイン画面と統一)
    if (isCtrlOrCmd && isShift && key === "b") {
      e.preventDefault();
      invoke("open_vivliostyle");
      return;
    }

    // Ctrl + H : 最小化
    if (isCtrlOrCmd && key === "h") {
      e.preventDefault();
      appWindow.minimize();
      return;
    }

    // Ctrl + Cmd + F (Mac) : フルスクリーン
    if (isMac && isCtrl && isCmd && key === "f") {
      e.preventDefault();
      this.vivliostyleToggleFullscreen();
      return;
    }

    // F11 (Win/Linux) : フルスクリーン
    if (!isMac && e.key === "f11") {
      e.preventDefault();
      this.vivliostyleToggleFullscreen();
      return;
    }
  }

  // 設定の復元（初期化時に呼び出す）
  private async loadSavedSettings() {
    try {
      const store = await Store.load(".settings.dat");

      // 最後に使ったプロジェクトパス
      const lastPath = await store.get<string>("vivliostyleLastProjectPath");
      if (lastPath) {
        this.currentProjectPath = lastPath;
        this.folderPathInput.value = lastPath;
        this.enableButtons(true);
      }

      // 各フォーム値の復元
      const preset = await store.get<string>("vivliostylePreset");
      if (preset) this.presetSelector.value = preset;

      const paper = await store.get<string>("vivliostylePaperSize");
      if (paper) this.paperSize.value = paper;

      const dir = await store.get<string>("vivliostyleDirection");
      if (dir) this.direction.value = dir;

      const cols = await store.get<string>("vivliostyleColumns");
      if (cols) this.columns.value = cols;

      const marginTop = await store.get<string>("vivliostyleMarginTop");
      if (marginTop) this.marginTop.value = marginTop;

      const marginBottom = await store.get<string>("vivliostyleMarginBottom");
      if (marginBottom) this.marginBottom.value = marginBottom;

      const marginInside = await store.get<string>("vivliostyleMarginInside");
      if (marginInside) this.marginInside.value = marginInside;

      const marginOutside = await store.get<string>("vivliostyleMarginOutside");
      if (marginOutside) this.marginOutside.value = marginOutside;

    } catch (e) {
      console.error("Vivliostyle設定の読み込みに失敗しました:", e);
    }
  }

  // 設定の保存（フォーム変更時や「設定更新」ボタン押下時に呼び出す）
  private async saveSettings() {
    try {
      const store = await Store.load(".settings.dat");

      if (this.currentProjectPath) {
        await store.set("vivliostyleLastProjectPath", this.currentProjectPath);
      }
      await store.set("vivliostylePreset", this.presetSelector.value);
      await store.set("vivliostylePaperSize", this.paperSize.value);
      await store.set("vivliostyleDirection", this.direction.value);
      await store.set("vivliostyleColumns", this.columns.value);

      await store.set("vivliostyleMarginTop", this.marginTop.value);
      await store.set("vivliostyleMarginBottom", this.marginBottom.value);
      await store.set("vivliostyleMarginInside", this.marginInside.value);
      await store.set("vivliostyleMarginOutside", this.marginOutside.value);

      await store.save();
    } catch (e) {
      console.error("Vivliostyle設定の保存に失敗しました:", e);
    }
  }

  // ボタンの活性/非活性を切り替えるヘルパー
  private enableButtons(enabled: boolean) {
    this.btnUpdateFiles.disabled = !enabled;
    this.btnPreview.disabled = !enabled;
    this.btnBuildPdf.disabled = !enabled;
    this.btnOpenTerminal.disabled = !enabled;
  }

  // --- 3. コア機能の実装 (TODO) ---

  // --- 1. システムフォントのロード関数 ---
  private async loadSystemFonts() {
    const fontSelect = document.getElementById("font-family-select") as HTMLSelectElement;
    if (!fontSelect) return;

    try {
      const fonts = await invoke<string[]>("get_system_fonts");

      // デフォルト（指定なし）の選択肢
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "default";
      defaultOpt.text = "標準フォント (Default)";
      fontSelect.appendChild(defaultOpt);

      fonts.forEach((fontName) => {
        const opt = document.createElement("option");
        opt.value = fontName;
        opt.text = fontName;
        fontSelect.appendChild(opt);
      });

      // 保存されていたフォントがあればセット
      const savedFont = await this.store?.get<string>("vivliostyleFontFamily");
      if (savedFont) fontSelect.value = savedFont;

    } catch (err) {
      console.error("Font loading failed:", err);
    }
  }

  // --- 2. custom.css の文字列を自動生成する ---
  private generateCustomCss(): string {
    const paperSize = this.paperSize.value;
    const isVertical = this.direction.value === "vertical";
    const cols = this.columns.value;
    const font = (document.getElementById("font-family-select") as HTMLSelectElement).value;

    const fontFamilyCss = font && font !== "default"
      ? `font-family: "${font}", "Yu Mincho", serif;`
      : `font-family: "Yu Mincho", "游明朝", serif;`;

    return `/* Generated by MirrorShard Vivliostyle Export */

  @page {
    size: ${paperSize};
    margin-top: ${this.marginTop.value};
    margin-bottom: ${this.marginBottom.value};
    margin-inside: ${this.marginInside.value};
    margin-outside: ${this.marginOutside.value};
  }

  html {
    writing-mode: ${isVertical ? "vertical-rl" : "horizontal-tb"};
    ${fontFamilyCss}
  }

  body {
    column-count: ${cols};
    column-gap: 8mm;
  }
  `;
  }

  // --- 3. vivliostyle.config.js の文字列を自動生成する ---
  private async generateVivliostyleConfig(markdownFiles: string[]): Promise<string> {
    const title = (document.getElementById("book-title") as HTMLInputElement).value || "無題";
    const author = (document.getElementById("book-author") as HTMLInputElement).value || "作者不明";
    const lang = (document.getElementById("book-language") as HTMLSelectElement).value || "ja";

    // エントリーファイル（Markdown一覧）の配列をJSON化
    // ファイル指定がない場合はデフォルトで 'novel.md' にフォールバック
    const entries = markdownFiles.length > 0 ? markdownFiles : ["novel.md"];
    const entryJson = JSON.stringify(entries, null, 4);

    return `// @ts-check
  import { defineConfig } from '@vivliostyle/cli';

  export default defineConfig({
    title: ${JSON.stringify(title)},
    author: ${JSON.stringify(author)},
    language: ${JSON.stringify(lang)},
    theme: [
      "@vivliostyle/theme-bunko@^2.0.1",
      "./custom.css",
    ],
    entry: ${entryJson},
    toc: {
      title: "目次",
      sectionDepth: 1,
    },
  });
  `;
  }

  // フォルダ選択ダイアログを開く
  private async selectProjectFolder() {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Vivliostyleのプロジェクトフォルダを選択",
      });

      if (selectedPath && typeof selectedPath === 'string') {
        this.currentProjectPath = selectedPath;
        this.folderPathInput.value = selectedPath;

        // フォルダが選ばれたらアクションボタンを有効化する
        this.btnUpdateFiles.disabled = false;
        this.btnPreview.disabled = false;
        this.btnBuildPdf.disabled = false;
        this.btnOpenTerminal.disabled = false;
      }
    } catch (e) {
      console.error("フォルダの選択に失敗しました:", e);
    }
  }

  // プリセットを各入力欄に適用する
  private applyPreset(preset: string) {
    if (preset === "a5-vertical-2col") {
      this.paperSize.value = "A5";
      this.direction.value = "vertical";
      this.columns.value = "2";
      this.marginTop.value = "20mm";
      this.marginBottom.value = "20mm";
      this.marginInside.value = "25mm";
      this.marginOutside.value = "15mm";
    } else if (preset === "bunko-vertical-1col") {
      this.paperSize.value = "A6";
      this.direction.value = "vertical";
      this.columns.value = "1";
      this.marginTop.value = "15mm";
      this.marginBottom.value = "15mm";
      this.marginInside.value = "20mm";
      this.marginOutside.value = "12mm";
    } else if (preset === "a4-horizontal-1col") {
      this.paperSize.value = "A4";
      this.direction.value = "horizontal";
      this.columns.value = "1";
      this.marginTop.value = "25mm";
      this.marginBottom.value = "25mm";
      this.marginInside.value = "25mm";
      this.marginOutside.value = "25mm";
    }
  }

  private async updateConfigurationFiles() {
      if (!this.currentProjectPath) {
        alert(t("vivliostyle.alerts.selectFolderFirst"));
        return;
      }

      try {
        const sep = this.currentProjectPath.includes("\\") ? "\\" : "/";
        const compiledFileName = "vivliostylepublishing.md";

        // 1. フォルダ内の .md ファイル一覧を取得
        const markdownFiles = await invoke<string[]>("get_markdown_files", {
          dirPath: this.currentProjectPath,
        });

        // 2. 原稿ファイルを順番に連結する（生成物自身は除外する）
        let combinedRawText = "";
        for (const fileName of markdownFiles) {
          // 前回のビルド用ファイル（vivliostylepublishing.md）は連結対象から除外
          if (fileName === compiledFileName) continue;

          const filePath = `${this.currentProjectPath}${sep}${fileName}`;
          try {
            const fileData = await invoke<FileData>("read_file", { path: filePath });
            // 各ファイル間に改行を挟んで連結
            combinedRawText += fileData.content.trim() + "\n\n";
          } catch (e) {
            console.error(`[Vivliostyle] ${fileName} の読み込みに失敗:`, e);
          }
        }

        // 3. 連結したテキスト全体にルビ変換をかける
        const convertedText = convertAozoraRubyToHtml(combinedRawText);

        // 4. ビルド用の単一ファイル (vivliostylepublishing.md) として保存 (元の原稿は無傷)
        const compiledFilePath = `${this.currentProjectPath}${sep}${compiledFileName}`;
        await invoke("write_file", {
          path: compiledFilePath,
          content: convertedText,
          encoding: "UTF-8",
        });

        // 5. custom.css の保存
        const cssContent = this.generateCustomCss();
        const cssPath = `${this.currentProjectPath}${sep}custom.css`;
        await invoke("write_file", {
          path: cssPath,
          content: cssContent,
          encoding: "UTF-8",
        });

        // 6. vivliostyle.config.js の保存 (entry には vivliostylepublishing.md のみを指定)
        const configContent = await this.generateVivliostyleConfig([compiledFileName]);
        const configPath = `${this.currentProjectPath}${sep}vivliostyle.config.js`;
        await invoke("write_file", {
          path: configPath,
          content: configContent,
          encoding: "UTF-8",
        });

        // 7. 設定の保存
        await this.saveSettings();

        alert(t("vivliostyle.alerts.updateSuccess"));
      } catch (e) {
        console.error("設定ファイルの更新に失敗しました:", e);
        alert(`Error updating configuration: ${String(e)}`);
      }
  }

  private async openTerminalInProject() {
      if (!this.store) {
        this.store = await Store.load(".settings.dat");
      }

      const targetPath =
        this.currentProjectPath ||
        (await this.store.get<string>("vivliostyleLastProjectPath"));

      if (!targetPath) {
        alert(t("vivliostyle.alerts.selectFolderFirst"));
        return;
      }

      try {
        await this.store.set("terminalTempCwd", targetPath);
        await this.store.save();

        await invoke("open_terminal_window");
      } catch (e) {
        console.error("ターミナル起動エラー:", e);
      }
    }

  // プレビュー用のローカルサーバーを起動し、子ウィンドウを開く
  private async startPreview() {
    if (!this.currentProjectPath) return;
    this.btnPreview.disabled = true;
    this.btnPreview.textContent = "⌛ プレビューを準備中...";

    console.log("プレビューを起動します:", this.currentProjectPath);
    // TODO: await invoke("start_vivliostyle_preview", { path: this.currentProjectPath });

    // 起動完了後にボタンを戻す
    setTimeout(() => {
      this.btnPreview.disabled = false;
      this.btnPreview.textContent = "👁️ プレビューを開く";
    }, 3000);
  }

  // PDFビルドコマンドを実行する
  private async buildPdf() {
    if (!this.currentProjectPath) return;
    this.btnBuildPdf.disabled = true;
    this.btnBuildPdf.textContent = "⌛ PDFを出力中...";

    console.log("PDFを出力します:", this.currentProjectPath);
    // TODO: await invoke("build_vivliostyle_pdf", { path: this.currentProjectPath });

    setTimeout(() => {
      this.btnBuildPdf.disabled = false;
      this.btnBuildPdf.textContent = "📄 PDFエクスポート";
      alert(t("vivliostyle.alerts.exportSuccess"));
    }, 3000);
  }

  private async vivliostyleToggleFullscreen() {
    this.isSimpleFullscreen = !this.isSimpleFullscreen;
    await invoke("set_simple_fullscreen", { enable: this.isSimpleFullscreen });
    // CSS調整
    if (osType !== "macos" && this.wrapper) {
      this.wrapper.style.borderRadius = this.isSimpleFullscreen ? "0px" : "6px";
    }
  }

}

// 起動処理
window.addEventListener("DOMContentLoaded", async () => {
  // OSの検出と body へのクラス付与（mac/linux固有のスタイル調整用）
  const osType = await type();
  if (osType === "macos") {
    document.body.classList.add("is-mac");
  }
  if (osType === "linux") {
    document.body.classList.add("is-linux");
  }

  // バックエンドからウィンドウタイトルを取得してセット
  const title: string = await invoke<string>("get_window_title", {
    windowKey: "vivliostyle",
  }).catch((): string => "");

  if (title) {
    await getCurrentWindow().setTitle(title);
  }

  // Vivliostyle のマネージャーインスタンス生成
  const manager = new VivliostyleManager();
  await manager.init(); // 非同期で順番に完了させる
});

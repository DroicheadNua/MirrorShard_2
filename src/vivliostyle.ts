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
  tempDiv.textContent = rawText;
  updateArticle(tempDiv);
  return tempDiv.innerHTML;
}

// 単一改行を自動的に段落（\n\n）に補正するヘルパー
function normalizeNovelParagraphs(text: string): string {
  // 1. 改行コードを \n に統一し、全角/半角スペースのみの行を完全な空行に掃除
  const cleaned = text.replace(/\r\n/g, "\n").replace(/^[ 　\t]+$/gm, "");

  // 2. 行ごとに分割
  const lines = cleaned.split("\n");
  const processedBlocks: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      // ⚠️ 空行（文字のない改行のみの行）は明示的に <br> に変換して1行空けを保証
      processedBlocks.push("<br />");
    } else {
      processedBlocks.push(line);
    }
  }

  // 3. 各行を二重改行（\n\n）で連結して Markdown の独立した段落にする
  return processedBlocks.join("\n\n");
}

// 自動縦中横を適用するヘルパー
function applyAutoTcy(text: string, enabled: boolean = true): string {
  if (!enabled) return text;
  return text.replace(/\b(\d{1,2})\b/g, '<span class="tcy">$1</span>');
}

class VivliostyleManager {
  // DOM要素
  private folderPathInput = document.getElementById("project-folder-path") as HTMLInputElement;
  private btnSelectFolder = document.getElementById("btn-select-folder") as HTMLButtonElement;
  private btnOpenFolder = document.getElementById("btn-open-folder") as HTMLButtonElement;
  private btnUpdateFiles = document.getElementById("btn-update-files") as HTMLButtonElement;

  private presetSelector = document.getElementById("preset-selector") as HTMLSelectElement;
  private paperSize = document.getElementById("paper-size") as HTMLSelectElement;
  private direction = document.getElementById("direction") as HTMLSelectElement;
  private columns = document.getElementById("columns") as HTMLSelectElement;

  private marginTop = document.getElementById("margin-top") as HTMLInputElement;
  private marginBottom = document.getElementById("margin-bottom") as HTMLInputElement;
  private marginInside = document.getElementById("margin-inside") as HTMLInputElement;
  private marginOutside = document.getElementById("margin-outside") as HTMLInputElement;
  private titleInput = document.getElementById("book-title") as HTMLInputElement;
  private authorInput = document.getElementById("book-author") as HTMLInputElement;
  private fontSizeInput = document.getElementById("font-size-input") as HTMLInputElement;
  private lineHeightInput = document.getElementById("line-height-input") as HTMLInputElement;

  private btnOpenTerminal = document.getElementById("btn-open-terminal") as HTMLButtonElement;
  private btnPreview = document.getElementById("btn-preview") as HTMLButtonElement;
  private btnBuildPdf = document.getElementById("btn-build-pdf") as HTMLButtonElement;

  private fullscreenBtn = document.getElementById("btn-maximize") as HTMLButtonElement;
  private minimizeBtn = document.getElementById("btn-minimize") as HTMLButtonElement;
  private closeBtn = document.getElementById("btn-close") as HTMLButtonElement;
  private wrapper = document.getElementById("vivliostyle-wrapper") as HTMLDivElement;
  private enableTcy = document.getElementById("enable-tcy") as HTMLInputElement;

  // 現在選択中のフォルダパス
  private currentProjectPath: string | null = null;
  private store: Store | null = null;
  private isSimpleFullscreen = false;

  constructor() {
    this.setupWindowControls();
    this.setupEventListeners();
  }

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
    this.btnSelectFolder?.addEventListener("click", async () => {
      await this.selectProjectFolder();
    });

    // フォルダ開く
    this.btnOpenFolder?.addEventListener("click", async () => {
      await this.openProjectFolder();
    });

    // プリセット変更
    this.presetSelector?.addEventListener("change", async () => {
      this.applyPreset(this.presetSelector.value);
      await this.saveSettings();
    });

    // 設定ファイル更新・作成
    this.btnUpdateFiles?.addEventListener("click", async () => {
      await this.updateConfigurationFiles(true);
    });

    // ターミナルを開く
    this.btnOpenTerminal?.addEventListener("click", async () => {
      await this.openTerminalInProject();
    });

    // プレビュー
    this.btnPreview?.addEventListener("click", async () => {
      await this.startPreview();
    });

    // PDFエクスポート
    this.btnBuildPdf?.addEventListener("click", async () => {
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

    // サブウィンドウ
    if (e.key === "F2") {
      e.preventDefault();
      invoke("open_settings_window");
    }

    if (isCtrlOrCmd && isShift && key === "a") {
      e.preventDefault();
      invoke("open_ai_chat");
    }

    if (isCtrlOrCmd && key === "i" && !isShift) {
      e.preventDefault();
      invoke("open_idea_processor");
    }

    if (isCtrlOrCmd && key === "b" && isShift) {
      e.preventDefault();
      invoke("open_vivliostyle");
    }

    if (isCtrlOrCmd && key === "h") {
      e.preventDefault();
      appWindow.minimize();
      return;
    }

    if (isMac && isCtrl && isCmd && key === "f") {
      e.preventDefault();
      this.vivliostyleToggleFullscreen();
      return;
    }

    if (!isMac && e.key === "f11") {
      e.preventDefault();
      this.vivliostyleToggleFullscreen();
      return;
    }
  }

  // 設定の復元（初期化時に呼び出す）
  private async loadSavedSettings() {
    try {
      if (!this.store) {
        this.store = await Store.load(".settings.dat");
      }

      // 最後に使ったプロジェクトパス
      const lastPath = await this.store.get<string>("vivliostyleLastProjectPath");
      if (lastPath) {
        this.currentProjectPath = lastPath;
        if (this.folderPathInput) this.folderPathInput.value = lastPath;
        this.enableButtons(true);
      }

      // 各フォーム値の復元
      const preset = await this.store.get<string>("vivliostylePreset");
      if (preset && this.presetSelector) this.presetSelector.value = preset;

      const paper = await this.store.get<string>("vivliostylePaperSize");
      if (paper && this.paperSize) this.paperSize.value = paper;

      const dir = await this.store.get<string>("vivliostyleDirection");
      if (dir && this.direction) this.direction.value = dir;

      const cols = await this.store.get<string>("vivliostyleColumns");
      if (cols && this.columns) this.columns.value = cols;

      const marginTop = await this.store.get<string>("vivliostyleMarginTop");
      if (marginTop && this.marginTop) this.marginTop.value = marginTop;

      const marginBottom = await this.store.get<string>("vivliostyleMarginBottom");
      if (marginBottom && this.marginBottom) this.marginBottom.value = marginBottom;

      const marginInside = await this.store.get<string>("vivliostyleMarginInside");
      if (marginInside && this.marginInside) this.marginInside.value = marginInside;

      const marginOutside = await this.store.get<string>("vivliostyleMarginOutside");
      if (marginOutside && this.marginOutside) this.marginOutside.value = marginOutside;

      const title = await this.store.get<string>("vivliostyleBookTitle");
      if (title && this.titleInput) this.titleInput.value = title;

      const author = await this.store.get<string>("vivliostyleBookAuthor");
      if (author && this.authorInput) this.authorInput.value = author;

      const fontSize = await this.store.get<string>("vivliostyleFontSize");
      if (fontSize && this.fontSizeInput) this.fontSizeInput.value = fontSize;

      const lineHeight = await this.store.get<string>("vivliostyleLineHeight");
      if (lineHeight && this.lineHeightInput) this.lineHeightInput.value = lineHeight;

      const savedTcy = await this.store.get<boolean>("vivliostyleEnableTcy");
      if (savedTcy !== undefined && this.enableTcy) {
        this.enableTcy.checked = savedTcy;
      } else if (this.enableTcy) {
        this.enableTcy.checked = true; // デフォルトはON
      }

    } catch (e) {
      console.error("Vivliostyle設定の読み込みに失敗しました:", e);
    }
  }

  // 設定の保存（フォーム変更時や「設定更新」ボタン押下時に呼び出す）
  private async saveSettings() {
    try {
      if (!this.store) {
        this.store = await Store.load(".settings.dat");
      }

      if (this.currentProjectPath) {
        await this.store.set("vivliostyleLastProjectPath", this.currentProjectPath);
      }
      if (this.presetSelector) await this.store.set("vivliostylePreset", this.presetSelector.value);
      if (this.paperSize) await this.store.set("vivliostylePaperSize", this.paperSize.value);
      if (this.direction) await this.store.set("vivliostyleDirection", this.direction.value);
      if (this.columns) await this.store.set("vivliostyleColumns", this.columns.value);

      if (this.marginTop) await this.store.set("vivliostyleMarginTop", this.marginTop.value);
      if (this.marginBottom) await this.store.set("vivliostyleMarginBottom", this.marginBottom.value);
      if (this.marginInside) await this.store.set("vivliostyleMarginInside", this.marginInside.value);
      if (this.marginOutside) await this.store.set("vivliostyleMarginOutside", this.marginOutside.value);

      if (this.titleInput) await this.store.set("vivliostyleBookTitle", this.titleInput.value);
      if (this.authorInput) await this.store.set("vivliostyleBookAuthor", this.authorInput.value);
      if (this.fontSizeInput) await this.store.set("vivliostyleFontSize", this.fontSizeInput.value);
      if (this.lineHeightInput) await this.store.set("vivliostyleLineHeight", this.lineHeightInput.value);
      if (this.enableTcy) await this.store.set("vivliostyleEnableTcy", this.enableTcy.checked);

      await this.store.save();
    } catch (e) {
      console.error("Vivliostyle設定の保存に失敗しました:", e);
    }
  }

  // ボタンの活性/非活性を切り替えるヘルパー
  private enableButtons(enabled: boolean) {
    if (this.btnUpdateFiles) this.btnUpdateFiles.disabled = !enabled;
    if (this.btnPreview) this.btnPreview.disabled = !enabled;
    if (this.btnBuildPdf) this.btnBuildPdf.disabled = !enabled;
    if (this.btnOpenTerminal) this.btnOpenTerminal.disabled = !enabled;
  }

  // --- システムフォントのロード関数 ---
  private async loadSystemFonts() {
    const fontSelect = document.getElementById("font-family-select") as HTMLSelectElement;
    if (!fontSelect) return;

    try {
      const fonts = await invoke<string[]>("get_system_fonts");

      fontSelect.innerHTML = ""; // 初期化
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

      const savedFont = await this.store?.get<string>("vivliostyleFontFamily");
      if (savedFont) fontSelect.value = savedFont;

    } catch (err) {
      console.error("Font loading failed:", err);
    }
  }

  // --- custom.css の文字列を自動生成する ---
  private generateCustomCss(): string {
    const isVertical = this.direction?.value === "vertical";
    const fontSelect = document.getElementById("font-family-select") as HTMLSelectElement;
    const font = fontSelect?.value || "default";

    const fontSize = this.fontSizeInput?.value || "10.5pt";
    const lineHeight = this.lineHeightInput?.value || "1.8";

    // 縦書き(右綴じ)と横書き(左綴じ)の左右余白の切り替え
    const rightPageMarginLeft = isVertical ? this.marginOutside?.value : this.marginInside?.value;
    const rightPageMarginRight = isVertical ? this.marginInside?.value : this.marginOutside?.value;
    const leftPageMarginLeft = isVertical ? this.marginInside?.value : this.marginOutside?.value;
    const leftPageMarginRight = isVertical ? this.marginOutside?.value : this.marginInside?.value;

    const fontFamilyCss = font && font !== "default"
      ? `font-family: "${font}", "Yu Mincho", serif;`
      : `font-family: "Yu Mincho", "游明朝", serif;`;

    return `/* Generated by MirrorShard Vivliostyle Export */

@page {
  size: ${this.paperSize?.value || "A5"};
  margin-top: ${this.marginTop?.value || "20mm"};
  margin-bottom: ${this.marginBottom?.value || "20mm"};
}

@page :right {
  margin-left: ${rightPageMarginLeft || "15mm"};
  margin-right: ${rightPageMarginRight || "25mm"};
}

@page :left {
  margin-left: ${leftPageMarginLeft || "25mm"};
  margin-right: ${leftPageMarginRight || "15mm"};
}

:root {
  font-size: ${fontSize};
}

html, body {
  font-size: ${fontSize};
  line-height: ${lineHeight};
  writing-mode: ${isVertical ? "vertical-rl" : "horizontal-tb"};
  ${fontFamilyCss}
}

body {
  column-count: ${this.columns?.value || "1"};
  column-gap: 8mm;
  column-fill: auto; /* 均等割り振りを禁止し、1段目から順に埋める */
}

/* 段落（pタグ）のデフォルト余白を消去 */
p {
  margin: 0;
  margin-block-start: 0;
  margin-block-end: 0;
  padding: 0;
}

/* ⚠️追加: 空の段落（意図的な1行空け）の表示高さを1行分(1.8em)確保する */
p:empty::before,
p:blank::before {
  content: "\\00a0"; /* 不可視のスペースを入れて潰れを防止 */
}

/* 縦中横 */
.tcy {
  -webkit-text-combine: horizontal;
  text-combine-upright: all;
}
`;
  }

  // --- vivliostyle.config.js の文字列を自動生成する ---
  private async generateVivliostyleConfig(markdownFiles: string[]): Promise<string> {
    const title = this.titleInput?.value || "無題";
    const author = this.authorInput?.value || "作者不明";
    const langSelect = document.getElementById("book-language") as HTMLSelectElement;
    const lang = langSelect?.value || "ja";

    const entries = markdownFiles.length > 0 ? markdownFiles : ["vivliostylepublishing.md"];
    const entryJson = JSON.stringify(entries, null, 4);

    return `module.exports = {
  title: ${JSON.stringify(title)},
  author: ${JSON.stringify(author)},
  language: ${JSON.stringify(lang)},
  openViewer: false,
  theme: [
    "./custom.css",
  ],
  entry: ${entryJson},
  toc: {
    title: "目次",
    sectionDepth: 1,
  },
};
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
        if (this.folderPathInput) this.folderPathInput.value = selectedPath;
        this.enableButtons(true);
        await this.saveSettings();
      }
    } catch (e) {
      console.error("フォルダの選択に失敗しました:", e);
    }
  }

  private async openProjectFolder() {
    if (!this.currentProjectPath) return;
    await invoke("open_project_folder", { path: this.currentProjectPath });
  }

  // プリセットを各入力欄に適用する
  private applyPreset(preset: string) {
    if (preset === "a5-vertical-2col") {
      if (this.paperSize) this.paperSize.value = "A5";
      if (this.direction) this.direction.value = "vertical";
      if (this.columns) this.columns.value = "2";
      if (this.marginTop) this.marginTop.value = "20mm";
      if (this.marginBottom) this.marginBottom.value = "20mm";
      if (this.marginInside) this.marginInside.value = "25mm";
      if (this.marginOutside) this.marginOutside.value = "15mm";
      if (this.fontSizeInput) this.fontSizeInput.value = "10.5pt";
      if (this.lineHeightInput) this.lineHeightInput.value = "1.75";
    } else if (preset === "bunko-vertical-1col") {
      if (this.paperSize) this.paperSize.value = "A6";
      if (this.direction) this.direction.value = "vertical";
      if (this.columns) this.columns.value = "1";
      if (this.marginTop) this.marginTop.value = "15mm";
      if (this.marginBottom) this.marginBottom.value = "15mm";
      if (this.marginInside) this.marginInside.value = "20mm";
      if (this.marginOutside) this.marginOutside.value = "12mm";
      if (this.fontSizeInput) this.fontSizeInput.value = "9pt";
      if (this.lineHeightInput) this.lineHeightInput.value = "1.8";
    } else if (preset === "a4-horizontal-1col") {
      if (this.paperSize) this.paperSize.value = "A4";
      if (this.direction) this.direction.value = "horizontal";
      if (this.columns) this.columns.value = "1";
      if (this.marginTop) this.marginTop.value = "25mm";
      if (this.marginBottom) this.marginBottom.value = "25mm";
      if (this.marginInside) this.marginInside.value = "25mm";
      if (this.marginOutside) this.marginOutside.value = "25mm";
      if (this.fontSizeInput) this.fontSizeInput.value = "11pt";
      if (this.lineHeightInput) this.lineHeightInput.value = "1.6";
    }
  }

  private async updateConfigurationFiles(showAlert: boolean = true) {
    if (!this.currentProjectPath) {
      if (showAlert) alert(t("vivliostyle.alerts.selectFolderFirst"));
      return;
    }

    try {
      const sep = this.currentProjectPath.includes("\\") ? "\\" : "/";
      const compiledFileName = "vivliostylepublishing.md";

      // 1. フォルダ内の .md/.txt ファイル一覧を取得
      const markdownFiles = await invoke<string[]>("get_markdown_files", {
        dirPath: this.currentProjectPath,
      });

      // 2. 原稿ファイルを順番に連結する
      let combinedRawText = "";
      for (const fileName of markdownFiles) {
        if (fileName === compiledFileName) continue;

        const filePath = `${this.currentProjectPath}${sep}${fileName}`;
        try {
          const fileData = await invoke<FileData>("read_file", { path: filePath });
          combinedRawText += fileData.content.trimEnd() + "\n\n";
        } catch (e) {
          console.error(`[Vivliostyle] ${fileName} の読み込みに失敗:`, e);
        }
      }

      const isTcyEnabled = this.enableTcy?.checked ?? true;

      // 3. ルビ変換・段落補正・縦中横処理
      const convertedText = convertAozoraRubyToHtml(normalizeNovelParagraphs(combinedRawText));
      const autoTcyText = applyAutoTcy(convertedText, isTcyEnabled);

      // Linux(WebKitGTK) の一部の環境で勝手にエスケープされた改行タグを強制復元する
      const finalText = autoTcyText.replace(/&lt;br\s*\/?&gt;/gi, "<br />");

      // 4. vivliostylepublishing.md として保存
      const compiledFilePath = `${this.currentProjectPath}${sep}${compiledFileName}`;
      await invoke("write_file", {
        path: compiledFilePath,
        content: finalText,
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

      // 6. vivliostyle.config.js の保存
      const configContent = await this.generateVivliostyleConfig([compiledFileName]);
      const configPath = `${this.currentProjectPath}${sep}vivliostyle.config.js`;
      await invoke("write_file", {
        path: configPath,
        content: configContent,
        encoding: "UTF-8",
      });

      // 7. 設定の保存
      await this.saveSettings();

      if (showAlert) {
        alert(t("vivliostyle.alerts.updateSuccess"));
      }
    } catch (e) {
      console.error("設定ファイルの更新に失敗しました:", e);
      if (showAlert) alert(`Error updating configuration: ${String(e)}`);
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

  // プレビュー用のローカルサーバーを起動
  private async startPreview() {
    if (!this.currentProjectPath) {
      alert(t("vivliostyle.alerts.selectFolderFirst"));
      return;
    }

    try {
      this.btnPreview.disabled = true;
      this.btnPreview.textContent = "⌛ プレビューを準備中...";

      await this.updateConfigurationFiles(false);

      await invoke("start_vivliostyle_preview", {
        projectPath: this.currentProjectPath,
      });

      setTimeout(() => {
        this.btnPreview.disabled = false;
        this.btnPreview.textContent = "👁️ プレビューを開く";
      }, 5000);

    } catch (e) {
      console.error("プレビュー起動エラー:", e);
      this.btnPreview.disabled = false;
      this.btnPreview.textContent = "👁️ プレビューを開く";
    }
  }

  // PDFビルドコマンドを実行する
  private async buildPdf() {
    if (!this.currentProjectPath) {
      alert(t("vivliostyle.alerts.selectFolderFirst"));
      return;
    }

    try {
      this.btnBuildPdf.disabled = true;
      this.btnBuildPdf.textContent = "⌛ PDFを出力中...";

      await this.updateConfigurationFiles(false);

      await invoke("build_vivliostyle_pdf", {
        projectPath: this.currentProjectPath,
      });

      alert(t("vivliostyle.alerts.exportSuccess"));
      await this.openProjectFolder();
    } catch (e) {
      console.error("PDFエクスポートエラー:", e);
      alert(`PDF Export Failed: ${String(e)}`);
    } finally {
      this.btnBuildPdf.disabled = false;
      this.btnBuildPdf.textContent = "📄 PDFエクスポート";
    }
  }

  private async vivliostyleToggleFullscreen() {
    this.isSimpleFullscreen = !this.isSimpleFullscreen;
    await invoke("set_simple_fullscreen", { enable: this.isSimpleFullscreen });
    if (osType !== "macos" && this.wrapper) {
      this.wrapper.style.borderRadius = this.isSimpleFullscreen ? "0px" : "6px";
    }
  }
}

// 起動処理
window.addEventListener("DOMContentLoaded", async () => {
  const osType = type();
  if (osType === "macos") {
    document.body.classList.add("is-mac");
  }
  if (osType === "linux") {
    document.body.classList.add("is-linux");
  }

  const title: string = await invoke<string>("get_window_title", {
    windowKey: "vivliostyle",
  }).catch((): string => "");

  if (title) {
    await getCurrentWindow().setTitle(title);
  }

  const manager = new VivliostyleManager();
  await manager.init();
  await invoke("ping_window_ready", { label: "Vivliostyle" });
  await getCurrentWindow().show();
  // Niriスタックウィンドウのトリガー (Linuxのみ)
  if (osType === "linux") {
    await invoke("trigger_niri_stack");
  }
});

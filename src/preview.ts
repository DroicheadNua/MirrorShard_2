import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import updateArticle from "./scripts/ruby";
import { resolveResource } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";
import {
  initI18n,
  applyTranslationsToDOM,
  t,
  translateRustError,
} from "./i18n";

interface PreviewPayload {
  text: string;
  isDarkMode: boolean;
  cursorLine: number;
  fontFamily: string;
  fontSize: string;
  lineHeight: number;
}

// 現在のテキストを保持する変数（印刷用）
let currentRawText = "";
let isSimpleFullscreen = false;
let isAutoTcyEnabled = false;

// --- 縦中横用のヘルパー関数 ---
function applyAutoTcy(text: string): string {
  // フラグがOFFなら何もせず原稿のまま返す
  if (!isAutoTcyEnabled) return text;

  // 単語境界の半角1〜2桁数字を自動で縦中横化
  return text.replace(/\b(\d{1,2})\b/g, '<span class="tcy">$1</span>');
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
      // ⚠️ 空行（文字のない改行のみの行）は明示的に <br /> に変換して1行空けを保証
      processedBlocks.push("<br />");
    } else {
      processedBlocks.push(line);
    }
  }

  // 3. 各行を二重改行（\n\n）で連結して Markdown の独立した段落にする
  return processedBlocks.join("\n\n");
}

async function initPreview() {
  const contentDiv = document.getElementById("content");
  const exportMenuBtn = document.getElementById("btn-export-menu");
  const exportDropdown = document.getElementById("export-dropdown");
  const dropdownItems = document.querySelectorAll(".dropdown-item");
  const refreshBtn = document.getElementById("btn-refresh");
  const fullscreenBtn = document.getElementById("btn-fullscreen");
  const closeBtn = document.getElementById("btn-close");
  const paperArea = document.getElementById("paper-area");
  const wrapper = document.getElementById("preview-wrapper");
  const pinBtn = document.getElementById("btn-pin");
  let isPinned = false;
  // モーダル要素
  const epubModal = document.getElementById("epub-modal");
  const epubTitleInput = document.getElementById(
    "epub-title",
  ) as HTMLInputElement;
  const epubAuthorInput = document.getElementById(
    "epub-author",
  ) as HTMLInputElement;
  const epubCoverInput = document.getElementById(
    "epub-cover-path",
  ) as HTMLInputElement;
  const btnSelectCover = document.getElementById("btn-select-cover");
  const btnClearCover = document.getElementById("btn-clear-cover");
  const btnCancelEpub = document.getElementById("btn-cancel-epub");
  const btnExecEpub = document.getElementById("btn-exec-epub");

  const store = await Store.load(".settings.dat");

  // --- メインからのデータ受信 ---
  await listen<PreviewPayload>("preview-update-data", async (event) => {
    const { text, isDarkMode, cursorLine, fontFamily, fontSize, lineHeight } =
      event.payload;

    // テキストを保持（印刷時に使う）
    if (text !== undefined) {
      currentRawText = text;
    }

    // 1. ダークモード反映
    if (isDarkMode !== undefined) {
      document.body.classList.toggle("dark-mode", isDarkMode);

      // 2. 背景画像設定
            if (wrapper) {
              if (isDarkMode) {
                wrapper.style.backgroundImage = "none";
              } else {
                // OSタイプを判定
                const osType = await type();

                if (osType === "linux") {
                  // 【Linux環境特有のフォールバック】
                  // パス解決の不整合を避け、最初から目に優しいセピアの単色背景を適用
                  wrapper.style.backgroundImage = "none";
                  wrapper.style.backgroundColor = "#eae3d2";
                } else {
                  // 【その他のOS（Windows/Mac）用の標準背景画像読み込み処理】
                  try {
                    const resourcePath = await resolveResource(
                      "resources/img/default_bg.jpg",
                    );
                    const url = convertFileSrc(resourcePath);
                    wrapper.style.backgroundImage = `url(${url})`;
                  } catch (e) {
                    console.error(e);
                  }
                }
                // ユーザーが設定したカスタム背景をプレビューにも反映させたい場合は
                // メインウィンドウから imageUrl を payload で送る
              }
            }
    }

    if (text !== undefined && contentDiv && paperArea) {
      // 2. ★★★ コンテンツの生成（Electron版ロジック移植） ★★★
      // 行ごとに分割し、ID付きのspanで囲む
      const lines = text.split("\n");
      const htmlWithLineNumbers = lines
        .map((line: string, index: number) => {
          // 空行でも高さを持たせるためにスペースを入れる等の処理
          const content = line || " ";
          // 各行の生テキストに自動縦中横を適用
                    const tcyContent = applyAutoTcy(content);
          // IDは line-1, line-2... となる
          return `<span id="line-${index + 1}" class="preview-line">${tcyContent}</span>`;
        })
        .join("<br>");

      contentDiv.innerHTML = htmlWithLineNumbers;

      // 3. ルビ変換
      updateArticle(contentDiv);

      // 4. カーソル位置へのスクロール
      // レンダリング待ちのため少し遅延させる
      setTimeout(() => {
        const targetElement = document.getElementById(`line-${cursorLine}`);
        if (targetElement) {
          // scrollIntoViewは縦書き(RTL)でも要素を視界に入れてくれる
          // block: 'center' で左右(縦書きの場合の行送り方向)の中央に来る
          targetElement.scrollIntoView({
            behavior: "auto",
            block: "center",
            inline: "center",
          });
        } else {
          // ターゲットが見つからない場合（巨大ファイル制限など）、先頭へ
          // paper-areaのスクロール方向(RTL)に合わせて0または右端へ
          paperArea.scrollTo({ left: 0, behavior: "auto" });
        }
      }, 200);
      // 5. 描画完了後にウィンドウを表示
      setTimeout(async () => {
        await invoke("enable_window_shadow");
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
      }, 100);

      // Niriスタックウィンドウのトリガー (Linuxのみ)
      const osType = type();
      if (osType === "linux") {
        await invoke("trigger_niri_stack");
      }
    }

    if (contentDiv) {
      if (fontSize) {
        contentDiv.style.fontSize = fontSize;
      }
      if (lineHeight) {
        contentDiv.style.lineHeight = lineHeight.toString();
      }
      if (fontFamily) {
        contentDiv.style.fontFamily = fontFamily;
      }
    }
  });
  // --- 設定変更の監視 (リアルタイムダークモード切替) ---
  await listen("settings-changed", () => {
    emit("preview-request-update");
  });

  isAutoTcyEnabled = (await store.get<boolean>("enableAutoTcy")) ?? false;
  await listen<any>("settings-changed", (event) => {
    if (event.payload.enableAutoTcy !== undefined) {
      isAutoTcyEnabled = event.payload.enableAutoTcy;
      // 必要に応じて最新の `currentRawText` で画面の再描画を呼び出す
    }
  });

  // --- 言語変更同期 ---
  await listen<string>("app:language-changed", async (event) => {
    await initI18n(event.payload === "en" ? "en" : "ja");
    applyTranslationsToDOM();
  });

  const osType = type();
  if (osType === "macos") {
    document.body.classList.add("is-mac");
  }
  if (osType === "linux") {
    document.body.classList.add("is-linux");
  }

  const appLang = (await store.get("appLanguage")) ?? "ja";
  await initI18n(appLang === "en" ? "en" : "ja");
  applyTranslationsToDOM();
  const title: string = await invoke<string>("get_window_title", {
    windowKey: "preview",
  }).catch((): string => "");
  if (title) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  }

  // --- 更新ボタン ---
  refreshBtn?.addEventListener("click", async () => {
    await emit("preview-request-update");
  });

  // --- フルスクリーンボタン ---
  fullscreenBtn?.addEventListener("click", async () => {
    await previewToggleFullscreen();
  });

  // --- 閉じる ---
  closeBtn?.addEventListener("click", async () => {
    previewClose();
  });

  // --- 最前面固定切り替え ---
  pinBtn?.addEventListener("click", async () => {
    isPinned = !isPinned;

    // Window APIを使って最前面設定を変更
    await getCurrentWindow().setAlwaysOnTop(isPinned);

    // ボタンの見た目を切り替え
    if (isPinned) {
      pinBtn.classList.add("active");
      pinBtn.title = t("preview.tooltip.pinRelease");
    } else {
      pinBtn.classList.remove("active");
      pinBtn.title = t("preview.tooltip.pin");
    }
  });

  // --- ドロップダウンの開閉 ---
  exportMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation(); // 親への伝播を止める
    exportDropdown?.classList.toggle("show");
  });

  // 画面のどこかをクリックしたら閉じる
  document.addEventListener("click", () => {
    exportDropdown?.classList.remove("show");
  });

  // --- 各項目のクリック処理 ---
  dropdownItems.forEach((item) => {
    item.addEventListener("click", async (e) => {
      const action = (e.target as HTMLElement).getAttribute("data-action");
      if (!action) return;

      // ドロップダウンを閉じる
      exportDropdown?.classList.remove("show");

      if (action === "html") {
        // HTMLは即座に保存ダイアログへ
        await handlePandocExport("html");
      } else if (action === "epub") {
        // EPUBはモーダルを開く
        openEpubModal();
      }
    });
  });

  // --- EPUB モーダル制御 ---
  function openEpubModal() {
    if (!epubModal) return;
    epubModal.style.display = "flex";
  }

  btnCancelEpub?.addEventListener("click", () => {
    if (epubModal) epubModal.style.display = "none";
  });

  // 表紙選択
  btnSelectCover?.addEventListener("click", async () => {
    const path = await open({
      title: "Select Cover Image",
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (path && typeof path === "string") {
      epubCoverInput.value = path;
    }
  });

  // 表紙クリア
  btnClearCover?.addEventListener("click", () => {
    epubCoverInput.value = "";
  });

  // EPUB実行
  btnExecEpub?.addEventListener("click", async () => {
    if (epubModal) epubModal.style.display = "none";

    const metadata = {
      title: epubTitleInput.value || "Untitled",
      author: epubAuthorInput.value || "Unknown",
      cover: epubCoverInput.value || "", // Rust側で受け取るキー
    };

    await handlePandocExport("epub", metadata);
  });

  // --- Pandocエクスポート共通関数 ---
  async function handlePandocExport(format: string, customMetadata?: any) {
    if (!currentRawText) return;

    try {
      const ext = format;
      const filterName = format.toUpperCase();

      const path = await save({
        title: `Export ${filterName}`,
        filters: [{ name: filterName, extensions: [ext] }],
        defaultPath: `output.${ext}`,
      });
      if (!path) return;

      const pandocPath = await store.get<string>("pandocPath");

            // 1. 小説用段落補正（単一改行の段落化と空行の <br> 化）
            let processedText = normalizeNovelParagraphs(currentRawText);

            // 2. ルビ変換 (既存ロジック)
            processedText = processedText.replace(
              /｜([^《]+)《([^》]+)》/g,
              "<ruby>$1<rt>$2</rt></ruby>",
            );
            const kanjiRange = "\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3400-\\u4DBF";
            const kanjiRubyRegex = new RegExp(
              `([^｜|])([${kanjiRange}]+)《([^》\\n]+?)》`,
              "gu",
            );
            processedText = processedText.replace(
              kanjiRubyRegex,
              "$1<ruby>$2<rt>$3</rt></ruby>",
            );

            // 3. 縦中横 (TCY) の自動適用
            processedText = applyAutoTcy(processedText);

      // メタデータの決定
      // HTMLの場合はファイル名をタイトルにする等の簡易処理
      const filename = path.split(/[/\\]/).pop() || "Untitled";
      const fileTitle = filename.replace(/\.[^/.]+$/, "");

      // EPUBからの指定があればそれを使う、なければデフォルト
      const finalMetadata = customMetadata || {
        title: fileTitle,
        author: "",
      };

      await invoke("export_with_pandoc", {
        sourceContent: processedText,
        outputPath: path,
        format: format,
        isVertical: true,
        pandocPathSetting: pandocPath,
        metadata: finalMetadata,
      });

      alert(t("preview.alert.exportSuccess", { format: format.toUpperCase() }));
    } catch (e) {
      console.error(e);
      alert(`${t("preview.alert.exportFailed")}: ${translateRustError(e)}`);
    }
  }

  // --- ショートカットキー ---
  document.addEventListener("keydown", (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isMac = osType === "macos";
    const isCtrl = e.ctrlKey;
    const isCmd = e.metaKey;

    if (isCtrlOrCmd && key === "p" && !isShift) {
      e.preventDefault();
      previewClose();
    }
    if (isCtrlOrCmd && key === "t" && !isShift) {
      e.preventDefault();
      emit("subwindow-toggle-theme");
    }
    if (isMac && isCtrl && isCmd && key === "f") {
      e.preventDefault();
      previewToggleFullscreen();
      return;
    }
    // --- Windows/Linux用フルスクリーン (F11) ---
    if (!isMac && e.key === "F11") {
      e.preventDefault();
      previewToggleFullscreen();
      return;
    }
    if (isCtrlOrCmd && (e.code === "Equal" || e.code === "NumpadAdd")) {
      e.preventDefault();
      emit("preview-font-size", "up");
    }
    if (isCtrlOrCmd && (e.code === "Minus" || e.code === "NumpadSubtract")) {
      e.preventDefault();
      emit("preview-font-size", "down");
    }
    if (isCtrlOrCmd && (e.code === "Digit0" || e.code === "Numpad0")) {
      e.preventDefault();
      emit("preview-font-size", "reset");
    }

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

  });

  // --- 右クリックメニューの無効化 ---
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  // --- マウスホイールでの横スクロール変換 ---
  if (paperArea) {
    paperArea.addEventListener(
      "wheel",
      (e) => {
        // 縦スクロールの成分が横スクロールより大きい場合のみ処理（トラックパッド等の斜め移動対策）
        if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

        // 標準の縦スクロールをキャンセル
        e.preventDefault();

        // 縦スクロール量(deltaY) を 横スクロール(scrollLeft) に変換
        const scrollSpeed = 1.0;
        paperArea.scrollLeft -= e.deltaY * scrollSpeed;
      },
      { passive: false },
    ); // preventDefaultするために passive: false が必要
  }

  async function previewToggleFullscreen() {
    // 反転
    isSimpleFullscreen = !isSimpleFullscreen;

    // Rustコマンドを呼び出し
    await invoke("set_simple_fullscreen", { enable: isSimpleFullscreen });

    // 必要ならCSS調整 (角丸など)
    if (osType !== "macos" && wrapper) {
      wrapper.style.borderRadius = isSimpleFullscreen ? "0px" : "6px";
    }
  }

  // --- 閉じる ---
  async function previewClose() {
    const window = getCurrentWindow();
    if (await window.isFullscreen()) {
      await window.setFullscreen(false);
    }
    window.close();
  }

  // 起動時に一度データ要求
  setTimeout(async () => {
    await emit("preview-request-update");
  }, 100);
}

window.addEventListener("DOMContentLoaded", initPreview);

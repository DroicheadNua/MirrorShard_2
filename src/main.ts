import "./styles.css";
import {
  initI18n,
  applyTranslationsToDOM,
  t,
  translateRustError,
} from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import {
  EditorState,
  Compartment,
  RangeSetBuilder,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  ViewUpdate,
  scrollPastEnd,
  Decoration,
  DecorationSet,
  ViewPlugin,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  undo,
  redo,
  insertTab,
  cursorDocEnd,
  cursorDocStart,
  insertNewline,
  defaultKeymap,
  insertNewlineAndIndent,
  selectAll,
  indentSelection,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import type { Extension, SelectionRange, StateEffect } from "@codemirror/state";
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentUnit,
} from "@codemirror/language";

import { tags } from "@lezer/highlight";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, save } from "@tauri-apps/plugin-dialog";
import { listen, emit } from "@tauri-apps/api/event";
import { type } from "@tauri-apps/plugin-os";

// --- 型定義 ---
interface Heading {
  level: number;
  text: string;
  pos: number;
  isCollapsed: boolean;
}
interface OpenTab {
  path: string;
  state: EditorState;
  isDirty: boolean;
  encoding: string;
  lineEnding: "LF" | "CRLF" | "";
  headings: Heading[];
}

// Tokyo Night Color Palette
const tnColors = {
  background: "#1a1b26", // 青みがかった黒
  foreground: "#a9b1d6",
  selection: "#515c7e",
  cursor: "#c0caf5",
  comment: "#565f89",
  keyword: "#bb9af7", // Purple
  variable: "#c0caf5",
  string: "#9ece6a", // Green
  number: "#ff9e64", // Orange
  tag: "#f7768e", // Red
  function: "#7aa2f7", // Blue
  operator: "#89ddff", // Cyan
};

const tokyoNightTheme = EditorView.theme(
  {
    "&": {
      color: tnColors.foreground,
      backgroundColor: "transparent",
    },
    ".cm-gutters": { borderRight: "none" },
    // 対応する括弧の強調 (グローエフェクト)
    ".cm-matchingBracket": {
      backgroundColor: "rgba(0, 255, 65, 0.2)", // ほのかな緑背景
      color: "#00FF41 !important", // ネオングリーン
      textShadow:
        "0 0 8px rgba(0, 255, 65, 0.9), 0 0 15px rgba(0, 255, 65, 0.4) !important",
      fontWeight: "bold",
      outline: "1px solid rgba(0, 255, 65, 0.5)",
    },
    // 対応していない括弧（エラー）
    ".cm-nonmatchingBracket": {
      backgroundColor: "rgba(255, 0, 0, 0.2)",
      color: "#FF0000 !important",
      textShadow: "0 0 8px #FF0000 !important",
    },
    ".cm-content": { caretColor: tnColors.cursor },
    "&.cm-focused .cm-cursor": { borderLeftColor: tnColors.cursor },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      {
        backgroundColor: tnColors.selection,
      },
    ".cm-activeLine": { backgroundColor: "#292e42" },
  },
  { dark: true },
);

const tokyoNightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: tnColors.keyword },
  {
    tag: [
      tags.name,
      tags.deleted,
      tags.character,
      tags.propertyName,
      tags.macroName,
    ],
    color: tnColors.variable,
  },
  {
    tag: [tags.function(tags.variableName), tags.labelName],
    color: tnColors.function,
  },
  {
    tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
    color: tnColors.number,
  },
  {
    tag: [tags.definition(tags.name), tags.separator],
    color: tnColors.foreground,
  },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: tnColors.number,
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string),
    ],
    color: tnColors.operator,
  },
  {
    tag: [tags.meta, tags.comment],
    color: tnColors.comment,
    fontStyle: "italic",
  },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: tnColors.comment, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: tnColors.tag },
  {
    tag: [tags.atom, tags.bool, tags.special(tags.variableName)],
    color: tnColors.keyword,
  },
  {
    tag: [tags.processingInstruction, tags.string, tags.inserted],
    color: tnColors.string,
  },
  { tag: tags.tagName, color: tnColors.tag },
]);

const tokyoNight: Extension = [
  tokyoNightTheme,
  syntaxHighlighting(tokyoNightHighlightStyle),
];

/**
 * MirrorShardアプリケーションのすべてを管理するクラス
 */
class App {
  // --- プロパティ ---
  private store!: Store;
  private editorView!: EditorView;
  private activeFileHeadings: Heading[] = [];
  private openTabs: OpenTab[] = [];
  private activeTabPath: string | null = null;
  private isDarkMode = false;
  private isZenMode = false;
  private currentFontIndex = 1;
  private currentFontSize = 15;
  private lightTheme!: any;
  private darkTheme!: any;
  private fontClassNames = ["font-serif", "font-sans-serif", "font-monospace"];
  private fileListContainer = document.querySelector<HTMLElement>(
    "#file-list-container",
  );
  private outlineControls =
    document.querySelector<HTMLElement>(".outline-controls");
  private outlineControls2 = document.querySelector<HTMLElement>(
    ".outline-controls-2",
  );
  private outlineContainer =
    document.querySelector<HTMLElement>("#outline-container");
  private editorContainer =
    document.querySelector<HTMLElement>("#editor-container");
  private markdownBtn = document.getElementById("btn-markdown");
  private typesoundBtn = document.getElementById("btn-typesound");
  private spotlightBtn = document.getElementById("btn-spotlight");
  private statusBar = document.querySelector<HTMLElement>("#status-bar");
  private isSpotlightMode = false;
  private isTypeSoundEnabled = false;
  private audioContext: AudioContext | null = null;
  private typeSoundBuffer: AudioBuffer | null = null;
  private isSnowing = false;
  private stopSnowing: (() => void) | null = null;
  private isSimpleFullscreen = false;

  private recentFiles: string[] = [];
  private editorMaxWidth = "80";
  private editorPaddingX = 10;
  private editorLineHeight = 1.6;
  private editorLineBreak = "strict";
  private editorWordBreak = "break-all";
  private userFontFamily = "default";
  private editorAlign = "center";
  private editorBlur = 0;
  private customTextColor = "#1e1e1e";
  private customUiTextColor = "#1e1e1e";
  private customEditorBg = "rgba(255, 255, 255, 0)";
  private customWindowBg = "#ffffff";
  private customSelectionColor = "rgba(100, 150, 250, 0.3)";
  private customScrollbarColor = "rgba(0, 0, 0, 0.2)";
  private customHeadingColor = "#0550AE";
  private enableGlow = false;
  private glowColor = "rgba(0, 50, 255, 0.5)";
  private glowRadius = 5;

  private useUiBg = false;
  private userBackgroundImagePath = "";
  private userBgmPath = "";
  private bgmElement: HTMLAudioElement | null = null; // Win/Mac用
  private isBgmPlaying = false;
  private currentOs: string | null = null;
  private isLoading = false;

  private dynamicFontTheme: any;
  private readonly serifFont =
    '"Palatino Linotype", "Book Antiqua", Palatino, "Times New Roman", "Yu Mincho", "Hiragino Mincho ProN", serif';
  private readonly sansSerifFont =
    '"Verdana", "Arial", "Helvetica", "Tsukushi A Round Gothic", "Hiragino Sans", "Meiryo", "Yu Gothic", sans-serif';
  private readonly monospaceFont =
    '"Menlo", "Monaco", "Consolas", "Courier New", "BIZ UDゴシック", "Osaka-Mono", monospace';
  private fontList = [this.serifFont, this.sansSerifFont, this.monospaceFont];
  private languageCompartment = new Compartment();

  private mainAiApi:
    | "gemini"
    | "groq"
    | "cerebras"
    | "openRouter"
    | "cohere"
    | "mistral"
    | "local" = "gemini";
  private showAiThinkingOverlay = true;
  private isAiProcessing = false; // AI動作中フラグ
  private aiAbortController: AbortController | null = null; // 通信中断用
  private aiThinkingMode = "";

  private isCodeMode = false;
  private currentCodeLanguage = "html";
  private wasLightModeBeforeCode = false;
  private codeFontFamily = "default";
  private codeFontSize = 10;
  private codeLineWrap = false;
  private mdHardBreaks = false;
  private codeExtras: any = null;
  private isCodeExtrasLoaded = false;
  // 全ての拡張機能を管理する区画
  private mainCompartment = new Compartment();
  private codeFontCompartment = new Compartment();
  private isFullFeatureAvailable = true;
  private tokyoNightCustomTheme: Extension = [
    tokyoNight, // tokyoNightの全設定を継承
    EditorView.theme({
      // エディタ全体の背景を透明にして、#app-container の背景が見えるようにする
      "&": {
        backgroundColor: "transparent !important",
        cursor: "text !important",
        outline: "none !important",
      },
      ".cm-content": {
        cursor: "text !important",
      },
      ".cm-gutters": {
        backgroundColor: "rgba(26, 27, 38, 1) !important",
        border: "none",
        color: "#565f89",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      "& ::-webkit-scrollbar": {
        width: "18px",
      },
      "& ::-webkit-scrollbar-track": {
        backgroundColor: "transparent",
      },
      "& ::-webkit-scrollbar-thumb": {
        backgroundColor: "rgba(105, 200, 255, 0.15)",
        borderRadius: "9px",
        border: "3px solid transparent",
        backgroundClip: "content-box",
        minHeight: "40px",
      },
      "& ::-webkit-scrollbar-thumb:hover": {
        backgroundColor: "rgba(105, 200, 255, 0.4)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
        {
          backgroundColor: "rgba(100, 150, 255, 0.4) !important",
        },
    }),
  ];

  // --- 静的ファクトリメソッド ---
  public static create() {
    const app = new App();
    app.initialize(); // initializeを呼び出す
    return app;
  }

  // --- 降雪エフェクトの切り替え ---
  private async toggleSnowEffect() {
    this.isSnowing = !this.isSnowing;

    if (this.isSnowing) {
      // 動的インポート: Ctrl+Shift+Eを押したときだけロードされる
      const { startSnowing } = await import("./scripts/snow");

      // 雪を降らせる対象要素。#app-container が画面全体を覆っているので最適
      const container = document.getElementById("app-container");
      if (container) {
        this.stopSnowing = startSnowing(container);
        console.log("Snow started.");
      }
    } else {
      if (this.stopSnowing) {
        this.stopSnowing();
        this.stopSnowing = null;
        console.log("Snow stopped.");
      }
    }
  }

  /**
   * Tauriのグローバルイベントを聴取してドラッグ&ドロップを処理する
   */
  private async setupDragAndDrop() {
    // 'tauri://drag-drop' イベントをリッスン
    // Tauri 2.0 のペイロードは { paths: string[], position: { x: number, y: number } } です
    await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;
      const { convertFileSrc } = await import("@tauri-apps/api/core");

      for (const path of paths) {
        // 画像ファイルかチェック
        if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(path)) {
          // ファイル名を取得
          const fileName = path.split(/[\\/]/).pop() || "image";

          // ローカルパスをWebViewで表示可能なURLに変換
          const assetUrl = convertFileSrc(path);

          // Markdown形式を生成
          const markdownImage = `![${fileName}](${assetUrl})\n`;

          // エディタの現在のカーソル位置に挿入
          this.editorView.dispatch({
            changes: {
              from: this.editorView.state.selection.main.from,
              insert: markdownImage,
            },
            selection: {
              anchor:
                this.editorView.state.selection.main.from +
                markdownImage.length,
            },
          });
        }
      }
    });
  }

  private createEditorExtensions(): Extension[] {
    const isMac = this.currentOs === "macos";

    // カーソル位置を補正するフィルタ
    const preventCursorBeyondDocEndFilter = EditorState.transactionFilter.of(
      (tr) => {
        if (!tr.selection) return tr;
        const docEnd = tr.newDoc.length;
        const newPos = tr.selection.main.head;
        if (newPos > docEnd) {
          // カーソルが末尾を越えていたら、末尾に強制的に戻す
          return { ...tr, selection: { anchor: docEnd } };
        }
        return tr;
      },
    );

    // --- 拡張機能の配列を定義 ---
    const extensions: Extension[] = [
      history(),
      keymap.of([
        ...historyKeymap,
        ...searchKeymap,
        { key: "Tab", run: insertTab },
        { key: "Enter", run: insertNewline },
        {
          key: "Mod-ArrowUp",
          run: (v) => {
            cursorDocStart(v);
            v.dispatch({
              effects: EditorView.scrollIntoView(0, { y: "start" }),
            });
            return true;
          },
        },
        {
          key: "Mod-ArrowDown",
          run: (v) => {
            cursorDocEnd(v);
            v.dispatch({
              effects: EditorView.scrollIntoView(v.state.selection.main.head, {
                y: "center",
              }),
            });
            return true;
          },
        },
        {
          key: "Shift-Alt-Enter",
          run: () => {
            this.runAiMissingLink();
            return true;
          },
        },
        {
          key: "Alt-Enter",
          run: () => {
            this.runAiCompletion();
            return true;
          },
        },
      ]),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      search({
        top: true, // 検索パネルを上部に

        // 公式ドキュメントにある、スクロール挙動をカスタマイズするオプション
        scrollToMatch: (
          range: SelectionRange,
          _view: EditorView,
        ): StateEffect<unknown> => {
          // EditorView.scrollIntoViewを使って、中央揃えのスクロールエフェクトを生成して返す
          return EditorView.scrollIntoView(range.from, { y: "center" });
        },
      }),
      this.getCurrentTheme(),
      this.dynamicFontTheme,
      this.createFontSizeTheme(this.currentFontSize),
      EditorView.updateListener.of((update: ViewUpdate) =>
        this.onEditorUpdate(update),
      ),
      scrollPastEnd(),
      preventCursorBeyondDocEndFilter,
      syntaxHighlighting(
        this.isDarkMode ? this.darkHighlightStyle : this.lightHighlightStyle,
      ),
      this.createSpotlightPlugin(this.isSpotlightMode),
      [],
      [],
    ];
    // Mac限定のハックを追加
    if (isMac) {
      // 1. スクロール時の色剥げ対策
      extensions.push(drawSelection());

      // 2. 全選択コマンドの明示的な割り当て
      // selectAll を import { selectAll } from "@codemirror/commands" しておく
      extensions.push(keymap.of([{ key: "Mod-a", run: selectAll }]));
    }
    return extensions;
  }

  // 必要な時だけDOMを生成して入力を受け取る関数
  private async showDynamicInput(
    title: string,
    defaultValue: string | number,
  ): Promise<string | number | null> {
    return new Promise((resolve) => {
      // 1. オーバーレイの作成
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
        justify-content: center; z-index: 10000; backdrop-filter: blur(2px);
      `;

      // 2. コンテンツ容器の作成
      // 型判定：デフォルト値が数値なら number 型、それ以外なら text 型の入力欄にする
      const isNumber = typeof defaultValue === "number";
      const inputType = isNumber ? "number" : "text";

      const container = document.createElement("div");
      const bgColor =
        document.documentElement.style.getPropertyValue("--window-bg-color") ||
        "#1a1b26";
      const textColor =
        document.documentElement.style.getPropertyValue("--ui-text-color") ||
        "#eee";

      container.style.cssText = `
        background: ${bgColor};
        border: 1px solid ${textColor};
        padding: 20px; border-radius: 8px; width: 260px;
        box-shadow: 0 0 20px rgba(0, 0, 0, 0.5); color: ${textColor};
        font-family: sans-serif;
      `;

      container.innerHTML = `
        <div style="margin-bottom: 15px; font-weight: bold; border-bottom: 1px solid #555; padding-bottom: 5px;">${title}</div>
        <input type="${inputType}" id="dynamic-val-input" value="${defaultValue}"
               style="width: 100%; background: rgba(0,0,0,0.3); color: inherit; border: 1px solid #555; padding: 5px; margin-bottom: 20px; box-sizing: border-box;">
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button id="dyn-btn-cancel" style="padding: 5px 12px; cursor: pointer; background: transparent; border: 1px solid #888; color: #888;">Cancel</button>
            <button id="dyn-btn-ok" style="padding: 5px 12px; cursor: pointer; background: transparent; border: 1px solid ${textColor}; color: ${textColor};">Run</button>
        </div>
      `;

      overlay.appendChild(container);
      document.body.appendChild(overlay);

      const input = overlay.querySelector(
        "#dynamic-val-input",
      ) as HTMLInputElement;
      input.focus();
      input.select();

      // クリーンアップして結果を返す
      const done = () => {
        const rawValue = input.value;
        document.body.removeChild(overlay);

        // ここで型を復元して返す
        if (isNumber) {
          resolve(parseInt(rawValue, 10));
        } else {
          resolve(rawValue); // 文字列として返す
        }
      };

      overlay.querySelector("#dyn-btn-ok")?.addEventListener("click", done);
      overlay
        .querySelector("#dyn-btn-cancel")
        ?.addEventListener("click", () => {
          document.body.removeChild(overlay);
          resolve(null);
        });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done();
        if (e.key === "Escape") {
          document.body.removeChild(overlay);
          resolve(null);
        }
      });
    });
  }

  private async initMainAiSelector() {
    try {
      console.log("Initializing Main AI Selector...");

      const displayBtn = document.getElementById("main-ai-display");
      const optionsContainer = document.getElementById("main-ai-options");

      // 要素がない場合はログを出して終了（クラッシュさせない）
      if (!displayBtn || !optionsContainer) {
        console.error("Error: Custom dropdown elements not found in HTML.");
        return;
      }

      console.log("Elements found. Setting up listeners...");

      // --- オプションの動的生成 ---
      optionsContainer.innerHTML = ""; // 既存のHTML（もしあれば）をクリア

      // 常に表示
      optionsContainer.innerHTML += `<div class="custom-option" data-value="gemini">Gemini (Cloud)</div>`;

      // チェックボックスに応じて追加
      if (await this.store.get<boolean>("enableGroq")) {
        optionsContainer.innerHTML += `<div class="custom-option" data-value="groq">Groq</div>`;
      }
      if (await this.store.get<boolean>("enableCerebras")) {
        optionsContainer.innerHTML += `<div class="custom-option" data-value="cerebras">Cerebras</div>`;
      }
      if (await this.store.get<boolean>("enableOpenRouter")) {
        optionsContainer.innerHTML += `<div class="custom-option" data-value="openRouter">OpenRouter</div>`;
      }
      if (await this.store.get<boolean>("enableCohere")) {
        optionsContainer.innerHTML += `<div class="custom-option" data-value="cohere">Cohere</div>`;
      }
      if (await this.store.get<boolean>("enableMistral")) {
        optionsContainer.innerHTML += `<div class="custom-option" data-value="mistral">Mistral</div>`;
      }

      // 常に表示
      optionsContainer.innerHTML += `<div class="custom-option" data-value="local">Local AI</div>`;

      // --- イベントリスナーの再設定 ---
      const options = optionsContainer.querySelectorAll(
        "#main-ai-options .custom-option",
      );

      // 1. 開閉ロジック
      displayBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        optionsContainer.classList.toggle("open");
      });

      document.addEventListener("click", () => {
        optionsContainer.classList.remove("open");
      });

      // 2. 選択ロジック
      options.forEach((opt) => {
        opt.addEventListener("click", async () => {
          const value = opt.getAttribute("data-value");
          const text = opt.textContent;

          if (value && text) {
            this.mainAiApi = value as any;
            displayBtn.textContent = text;
            optionsContainer.classList.remove("open");

            // Store保存 (エラーハンドリング付き)
            try {
              await this.store.set("mainAiApi", this.mainAiApi);
              await this.store.save();
            } catch (err) {
              console.error("Store save failed:", err);
            }
          }
        });
      });

      // 3. 初期値ロード
      // Storeがロードされる前でもエラーにならないよう非同期で実行
      setTimeout(async () => {
        try {
          const val = await this.store.get<string>("mainAiApi");
          if (val) {
            this.mainAiApi = val as any;
            // 値に対応するテキストを探して表示
            // NodeListを配列に変換して検索
            const target = Array.from(options).find(
              (o) => o.getAttribute("data-value") === val,
            );
            if (target && target.textContent) {
              displayBtn.textContent = target.textContent;
            }
          }
        } catch (err) {
          console.error("Store get failed:", err);
        }
      }, 100);
    } catch (e) {
      // ここでエラーを捕まえるので、アプリ自体は止まらない
      console.error("Fatal Error inside initMainAiSelector:", e);
    }
  }

  // オーバーレイ制御用メソッド
  private updateAiThinkingStyle() {
    const root = document.documentElement.style;

    if (this.showAiThinkingOverlay) {
      // ONのときの色とブラー
      root.setProperty("--ai-thinking-bg", "rgba(0, 0, 0, 0.5)");
      root.setProperty("--ai-thinking-blur", "blur(2px)");
    } else {
      // OFFのときは透明化
      root.setProperty("--ai-thinking-bg", "transparent");
      root.setProperty("--ai-thinking-blur", "none");
    }
  }

  private setAiLoading(isLoading: boolean) {
    const overlayId = "ai-loading-overlay";

    // 既存のオーバーレイをすべて削除
    const existingOverlays = document.querySelectorAll(`#${overlayId}`);
    existingOverlays.forEach((el) => el.remove());

    if (isLoading) {
      // 事前にCSS変数を最新の状態にしておく
      this.updateAiThinkingStyle();

      const overlay = document.createElement("div");
      overlay.id = overlayId;
      overlay.className = "loading-overlay";

      // 演出設定がONのときだけ中身（スピナーと文字）を生成する
      if (this.showAiThinkingOverlay) {
        overlay.innerHTML = `
          <div class="spinner"></div>
          <div class="loading-text">AI is writing...</div>
          <div class="loading-text">Mode: ${this.aiThinkingMode}</div>
        `;
      } else {
        overlay.innerHTML = ""; // 透明ガードのみ
      }

      // 1. 右クリックメニュー (Context Menu) を禁止
      overlay.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      // 2. マウスボタン（クリック、戻る/進むボタン等）を禁止
      // mousedown, mouseup, click すべてを止めることで、
      // サイドボタンによるタブ切り替えやリンククリック等を防ぐ
      const blockEvent = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };

      overlay.addEventListener("mousedown", blockEvent);
      overlay.addEventListener("mouseup", blockEvent);
      overlay.addEventListener("click", blockEvent);
      overlay.addEventListener("dblclick", blockEvent);
      overlay.addEventListener("auxclick", blockEvent); // ホイールクリック等

      // 3. ホイールスクロールも止める
      overlay.addEventListener("wheel", blockEvent, { passive: false });

      document.body.appendChild(overlay);
    }
  }

  // 選択範囲の文字数カウント
  private async showSelectionCount() {
    const selection = this.editorView.state.selection.main;
    if (selection.empty) return;

    const text = this.editorView.state.sliceDoc(selection.from, selection.to);
    // 改行を除外するかどうかはお好みですが、一般的には「文字数」としてカウントします
    const count = text.length;

    // Tauri標準のメッセージダイアログで表示（手軽で確実です）
    await message(t("editor.selectionCount.message", { count }), {
      title: t("editor.selectionCount.title"),
      kind: "info",
    });
  }

  // ここでターミナルを開く
  private async openTerminalHere() {
    if (this.activeTabPath) {
      // ファイルパスからディレクトリパスを取得
      // (簡易実装: 最後のセパレータまでを切り取る)
      const sep = this.activeTabPath.includes("\\") ? "\\" : "/";
      const dir = this.activeTabPath.substring(
        0,
        this.activeTabPath.lastIndexOf(sep),
      );

      // ストアに一時的なCWDとして保存
      await this.store.set("terminalTempCwd", dir);
      await this.store.save();

      // ターミナルを開く
      await invoke("open_terminal_window");
    } else {
      // 未保存ファイルなどの場合、単に開くか、アラート
      await invoke("open_terminal_window");
    }
  }

  // ここでフォルダを開く
  private async openFolderHere() {
    if (!this.activeTabPath) return;
    if (this.activeTabPath) {
      // ディレクトリパスの抽出
      // (Windowsの \ と Macの / 両対応)
      const sep = this.activeTabPath.includes("\\") ? "\\" : "/";
      const dirPath = this.activeTabPath.substring(
        0,
        this.activeTabPath.lastIndexOf(sep),
      );

      // Rustコマンドを再利用 (opener::open はフォルダも開ける)
      await invoke("open_in_browser", { path: dirPath });
    }
  }

  // --- コードの簡易フォーマット ---
  private formatCode() {
    if (!this.isCodeMode) return;
    const view = this.editorView;
    const originalSel = view.state.selection;

    // 全選択してインデント整形し、選択範囲を元に戻す
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    indentSelection(view);
    view.dispatch({ selection: originalSel });
  }

  // AI通信を中止する
  private abortAiProcessing() {
    if (this.aiAbortController) {
      console.log("Sending abort signal...");
      this.aiAbortController.abort();
      // ここでフラグやUIをいじらない（finallyブロックに任せる）
    }
  }

  // AI補完を実行するメインロジック
  private async runAiCompletion() {
    if (this.isAiProcessing) return; // 二重起動防止
    if (this.isCodeMode) {
      await this.runCodeCompletion();
      return;
    }
    const view = this.editorView;
    const state = view.state;
    const cursor = state.selection.main.head;

    // 1. コンテキストの取得 (カーソル前の1000文字程度)
    let contextLimit = (await this.store.get<number>("aiContextLimit")) || 2000;
    // Gemini（API利用）の場合は、予期せぬ課金やエラーを防ぐため強制的に上限をかける
    if (this.mainAiApi !== "local") {
      const MAX_GEMINI_LIMIT = 2000; // 安全策
      if (contextLimit > MAX_GEMINI_LIMIT) {
        console.warn(
          `Cloud AIのコンテキスト長は安全のため ${MAX_GEMINI_LIMIT} 字以下に制限されます`,
        );
        contextLimit = MAX_GEMINI_LIMIT;
      }
    }
    const from = Math.max(0, cursor - contextLimit);
    const textContext = state.doc.sliceString(from, cursor);

    if (!textContext.trim()) return;

    // 2. UIのフィードバック
    console.log("AI Completion requested...");

    this.isAiProcessing = true;
    this.aiAbortController = new AbortController(); // 新しい中断用コントローラーを作成
    this.aiThinkingMode = "Completion";
    this.setAiLoading(true);

    try {
      let resultText = "";
      // 1. ストアからユーザー設定のシステムプロンプトを取得
      const userSystemPrompt =
        (await this.store.get<string>("aiSystemPrompt")) || "";

      // 2. 機能固有の指示
      const baseSystemPrompt = t("prompts.systemPrompt.completion");

      // 3. プロンプトの合成
      const userPrefix = t("prompts.template.userInstructionPrefix");
      const systemPrompt = userSystemPrompt
        ? `${baseSystemPrompt}\n\n${userPrefix}\n${userSystemPrompt}`
        : baseSystemPrompt;
      if (this.mainAiApi === "gemini") {
        const apiKey = await this.store.get<string>("geminiApiKey");
        if (!apiKey) throw new Error("Gemini API Key is not set.");
        // AiChatで実装した通信ロジックを流用 (簡略化)
        // ※ ここでは stream は使わず、一括で受け取るのが挿入しやすくて楽
        const response = await this.requestGeminiDirect(
          apiKey!,
          textContext,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
        resultText = response;
      } else if (this.mainAiApi === "cohere") {
        const apiKey = await this.store.get<string>("cohereApiKey");
        const model =
          (await this.store.get<string>("cohereModel")) ||
          "command-r-plus-08-2024";
        if (!apiKey) throw new Error("Cohere API Key is not set.");
        resultText = await this.requestCohereV2Direct(
          apiKey,
          model,
          textContext,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
      } else {
        // Groq, Mistral, Local LLM はすべて OpenAI 互換の共通関数へ投げる
        let url = "",
          apiKey = "",
          model = "";

        if (this.mainAiApi === "groq") {
          url = "https://api.groq.com/openai/v1/chat/completions";
          apiKey = (await this.store.get<string>("groqApiKey")) || "";
          model =
            (await this.store.get<string>("groqModel")) ||
            "llama-3.3-70b-versatile";
        } else if (this.mainAiApi === "cerebras") {
          url = "https://api.cerebras.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("cerebrasApiKey")) || "";
          model =
            (await this.store.get<string>("cerebrasModel")) || "gemma-4-31b";
        } else if (this.mainAiApi === "openRouter") {
          url = "https://openrouter.ai/api/v1/chat/completions";
          apiKey = (await this.store.get<string>("openRouterApiKey")) || "";
          model =
            (await this.store.get<string>("openRouterModel")) || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
        } else if (this.mainAiApi === "mistral") {
          url = "https://api.mistral.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("mistralApiKey")) || "";
          model =
            (await this.store.get<string>("mistralModel")) ||
            "mistral-small-latest";
        } else if (this.mainAiApi === "local") {
          url =
            (await this.store.get<string>("localLlmUrl")) ||
            "http://127.0.0.1:1234/v1/chat/completions";
          apiKey = "local"; // ローカルはキー不要なことが多いがダミーとして
          model =
            (await this.store.get<string>("localLlmModel")) || "local-model";
        }

        if (this.mainAiApi !== "local" && !apiKey)
          throw new Error(`${this.mainAiApi} API Key is not set.`);
        resultText = await this.requestOpenAICompatibleDirect(
          url,
          apiKey,
          model,
          textContext,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
      }

      // 3. エディタに挿入
      if (resultText) {
        const maxTokens = (await this.store.get<number>("aiMaxTokens")) || 2000;

        // 日本語の場合、トークン数と文字数はイコールではないが、
        // 安全策として「設定値の文字数」で切るのが確実
        if (resultText.length > maxTokens) {
          console.warn(
            `AI Output truncated: ${resultText.length} -> ${maxTokens}`,
          );
          resultText = resultText.substring(0, maxTokens);
          // 文の途中で切れるのを防ぐなら、最後の「。」までで切る等の処理も可
          const lastPeriod = resultText.lastIndexOf("。");
          if (lastPeriod > maxTokens * 0.8) {
            // ある程度長さがあれば句点で切る
            resultText = resultText.substring(0, lastPeriod + 1);
          }
        }

        // エディタに挿入
        view.dispatch({
          changes: { from: cursor, insert: resultText },
          selection: { anchor: cursor + resultText.length },
        });

        // 挿入箇所へスクロール
        view.dispatch({
          effects: EditorView.scrollIntoView(cursor + resultText.length, {
            y: "center",
          }),
        });
      }
    } catch (e: any) {
      this.handleAiError(e);
    } finally {
      this.aiThinkingMode = "";
      this.clearAiProcessingState();
    }
  }

  // --- Missing Link Completion (Shift+Alt+Enter) ---
  // カーソル位置の前後を読み取り、その間を繋ぐ文章を生成する
  private async runAiMissingLink() {
    if (this.isAiProcessing) return;
    const view = this.editorView;
    const state = view.state;
    const cursor = state.selection.main.head;

    // 1. 設定値の取得と数値変換の保証
    let limit = Number(await this.store.get<number>("aiContextLimit")) || 2000;

    // Geminiガード
    if (this.mainAiApi !== "local") {
      const MAX_GEMINI_LIMIT = 4000; // 安全策
      if (limit > MAX_GEMINI_LIMIT) {
        console.warn(
          `Cloud AIのコンテキスト長は安全のため ${MAX_GEMINI_LIMIT} 字以下に制限されます`,
        );
        limit = MAX_GEMINI_LIMIT;
      }
    }
    // 2. 配分の計算（Math.floorで整数化を確実にする）
    const prevLimit = Math.floor(limit * 0.66);
    const nextLimit = Math.floor(limit * 0.33);

    const from = Math.max(0, cursor - prevLimit);
    const to = Math.min(state.doc.length, cursor + nextLimit);

    const prevContext = state.doc.sliceString(from, cursor);
    const nextContext = state.doc.sliceString(cursor, to);

    // ガード：前後どちらも空なら実行しない
    if (!prevContext.trim() && !nextContext.trim()) {
      console.log("Context is empty. Aborting.");
      return;
    }

    console.log("AI Missing Link Completion requested...");

    this.isAiProcessing = true;
    this.aiAbortController = new AbortController();
    this.aiThinkingMode = "Missing Link";
    this.setAiLoading(true);

    try {
      let resultText = "";

      const userSystemPrompt =
        (await this.store.get<string>("aiSystemPrompt")) || "";
      // システムプロンプト: 繋ぎの文章を書くことに特化させる
      const baseSystemPrompt = t("prompts.systemPrompt.missingLink");
      // 3. プロンプトの合成
      const userPrefix = t("prompts.template.userInstructionPrefix");
      const systemPrompt = userSystemPrompt
        ? `${baseSystemPrompt}\n\n${userPrefix}\n${userSystemPrompt}`
        : baseSystemPrompt;

      // ユーザープロンプト: 前後を分かりやすく渡す
      const prevLabel = t("prompts.template.prevSection");
      const nextLabel = t("prompts.template.nextSection");
      const instructionLabel = t("prompts.template.instruction");
      const instructionFiller = t("prompts.template.instructionFiller");
      const userPrompt = `
${prevLabel}
${prevContext}

${nextLabel}
${nextContext}

${instructionLabel}
${instructionFiller}
`;

      if (this.mainAiApi === "gemini") {
        const apiKey = await this.store.get<string>("geminiApiKey");
        if (!apiKey) throw new Error("Gemini API Key is not set.");
        resultText = await this.requestGeminiDirect(
          apiKey!,
          userPrompt,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
      } else if (this.mainAiApi === "cohere") {
        const apiKey = await this.store.get<string>("cohereApiKey");
        const model =
          (await this.store.get<string>("cohereModel")) ||
          "command-r-plus-08-2024";
        if (!apiKey) throw new Error("Cohere API Key is not set.");
        resultText = await this.requestCohereV2Direct(
          apiKey,
          model,
          userPrompt,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
      } else {
        let url = "",
          apiKey = "",
          model = "";

        if (this.mainAiApi === "groq") {
          url = "https://api.groq.com/openai/v1/chat/completions";
          apiKey = (await this.store.get<string>("groqApiKey")) || "";
          model =
            (await this.store.get<string>("groqModel")) ||
            "llama-3.3-70b-versatile";
        } else if (this.mainAiApi === "cerebras") {
          url = "https://api.cerebras.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("cerebrasApiKey")) || "";
          model =
            (await this.store.get<string>("cerebrasModel")) || "gemma-4-31b";
        } else if (this.mainAiApi === "openRouter") {
          url = "https://openrouter.ai/api/v1/chat/completions";
          apiKey = (await this.store.get<string>("openRouterApiKey")) || "";
          model =
            (await this.store.get<string>("openRouterModel")) ||
            "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
        } else if (this.mainAiApi === "mistral") {
          url = "https://api.mistral.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("mistralApiKey")) || "";
          model =
            (await this.store.get<string>("mistralModel")) ||
            "mistral-small-latest";
        } else if (this.mainAiApi === "local") {
          url =
            (await this.store.get<string>("localLlmUrl")) ||
            "http://127.0.0.1:1234/v1/chat/completions";
          apiKey = "local";
          model =
            (await this.store.get<string>("localLlmModel")) || "local-model";
        }

        if (this.mainAiApi !== "local" && !apiKey)
          throw new Error(`${this.mainAiApi} API Key is not set.`);
        resultText = await this.requestOpenAICompatibleDirect(
          url,
          apiKey,
          model,
          userPrompt,
          systemPrompt,
          undefined,
          this.aiAbortController.signal,
        );
      }

      // 3. エディタに挿入
      if (resultText) {
        // 余計な空白や「繋ぎの文章は以下の通りです」みたいなAIの枕詞を削除する処理を入れるとより良い
        // resultText = resultText.trim();

        view.dispatch({
          changes: { from: cursor, insert: resultText },
          selection: { anchor: cursor + resultText.length }, // 挿入後の末尾にカーソル
        });

        view.dispatch({
          effects: EditorView.scrollIntoView(cursor + resultText.length, {
            y: "center",
          }),
        });
      }
    } catch (e: any) {
      this.handleAiError(e);
    } finally {
      this.aiThinkingMode = "";
      this.clearAiProcessingState();
    }
  }

  // --- コード補完実行メソッド ---
  private async runCodeCompletion() {
    if (this.isAiProcessing) return;
    const view = this.editorView;
    const state = view.state;
    const cursor = state.selection.main.head;

    // 前後2500文字程度
    const limit = 2500;
    const prefix = state.sliceDoc(Math.max(0, cursor - limit), cursor);
    const suffix = state.sliceDoc(
      cursor,
      Math.min(state.doc.length, cursor + limit),
    );

    if (!prefix.trim()) return;

    this.isAiProcessing = true;
    this.aiAbortController = new AbortController();
    this.aiThinkingMode = "Code Completion";
    this.setAiLoading(true);

    try {
      const url =
        (await this.store.get<string>("localLlmUrl")) ||
        "http://127.0.0.1:1234/v1/chat/completions";
      const resultText = await this.requestCodeFim(
        url,
        prefix,
        suffix,
        this.aiAbortController.signal,
      );

      if (resultText && resultText.trim().length > 0) {
        // 余計な装飾（```や解説）を排除
        let cleanText = resultText
          .replace(/<thought>[\s\S]*?<\/thought>/gi, "") // 思考タグ除去
          .replace(/```[a-z]*\n/gi, "") // コードブロック開始除去
          .replace(/```/g, "") // 閉じ除去
          .trimEnd(); // 行頭の空白は維持したいので trimEnd

        if (cleanText) {
          view.dispatch({
            changes: { from: cursor, insert: cleanText },
            selection: { anchor: cursor + cleanText.length },
          });
        }
      }
    } catch (e: any) {
      this.handleAiError(e);
    } finally {
      this.aiThinkingMode = "";
      this.clearAiProcessingState();
    }
  }

  // --- FIMリクエスト用ヘルパー ---
  private async requestCodeFim(
    url: string,
    prefix: string,
    suffix: string,
    signal: AbortSignal,
  ): Promise<string> {
    const modelName =
      (await this.store.get<string>("localLlmModel")) || "qwen2.5-coder:1.5b";
    const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;

    let targetUrl = "";
    let body: any = {};

    if (url.includes("/api/") || url.includes("11434")) {
      const baseUrl = url.split("/v1/")[0].split("/api/")[0].replace(/\/$/, "");
      targetUrl = `${baseUrl}/api/generate`;
      body = {
        model: modelName,
        prompt: prompt,
        stream: false,
        raw: true,
        options: {
          stop: [
            "<|file_separator|>",
            "<|endoftext|>",
            "<|fim_prefix|>",
            "<|fim_suffix|>",
          ],
          temperature: 0.1, // 0.0だと稀に固まるモデルがあるため 0.1
          num_predict: 256,
        },
      };
    } else {
      const baseUrl = url.split("/v1/")[0].replace(/\/$/, "");
      targetUrl = `${baseUrl}/v1/completions`;
      body = {
        model: modelName,
        prompt: prompt,
        stream: false,
        max_tokens: 256,
        temperature: 0.1,
        // HTMLタグなどをストップトークンに入れない
        stop: [
          "<|file_separator|>",
          "<|endoftext|>",
          "<|fim_prefix|>",
          "<|fim_suffix|>",
        ],
      };
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal,
    });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    return data.response || (data.choices && data.choices[0]?.text) || "";
  }

  // AIによる編集・加工実行メソッド
  private async runAiEdit(
    mode: "translate" | "summary" | "rewrite" | "sd_prompt",
  ) {
    if (this.isAiProcessing) return;
    const view = this.editorView;
    const state = view.state;
    const selection = state.selection.main;

    // 選択範囲がない場合は何もしない
    if (selection.empty) {
      await message(t("editor.noSelection"), { kind: "info" });
      return;
    }

    const selectedText = state.sliceDoc(selection.from, selection.to);
    const userSystemPrompt =
      (await this.store.get<string>("aiSystemPrompt")) || "";

    // モードごとの設定
    let baseSystemPrompt = "";
    let label = "";

    switch (mode) {
      case "translate":
        const lastLang =
          (await this.store.get<string>("aiTranslateLanguage")) ||
          t("editor.languageDefault");
        const lang = (await this.showDynamicInput("Translate to", lastLang)) as
          | string
          | null;

        if (lang === null) return;

        await this.store.set("aiTranslateLanguage", lang);
        await this.store.save();

        baseSystemPrompt = t("prompts.systemPrompt.translate", { lang });
        label = `[Translate: ${lang}]`;
        break;

      case "summary":
        const lastLength =
          (await this.store.get<number>("aiSummaryLength")) || 200;
        const targetLength = (await this.showDynamicInput(
          "Target Length (chars)",
          lastLength,
        )) as number | null;

        if (targetLength === null) return;

        await this.store.set("aiSummaryLength", targetLength);
        await this.store.save();

        baseSystemPrompt = t("prompts.systemPrompt.summarize", {
          length: targetLength,
        });
        label = `[Summarize] (${targetLength} chars)`;
        break;
      case "rewrite":
        baseSystemPrompt = t("prompts.systemPrompt.rewrite");
        label = "[Rewrite]";
        break;
      case "sd_prompt":
        // ユーザーが設定した画風などの Prefix を Store から取得（あれば）
        const sdPrefix =
          (await this.store.get<string>("imageSystemPrompt")) || "";

        // AIへの指示（システムプロンプト）
        baseSystemPrompt =
          "Task: Convert the provided scene description into a concise, high-quality, comma-separated English prompt for Stable Diffusion (maximum 30 tags). Focus on the most important subjects, setting, and atmosphere. Output ONLY the tags/prompt text. Do not include any explanations, greetings, or preamble.";

        // Prefixがあればシステムプロンプトに混ぜ込む
        if (sdPrefix) {
          baseSystemPrompt += `\nEnsure these tags are included at the beginning of your output: ${sdPrefix}`;
        }

        label = "[SD Prompt]";
        break;
    }
    // プロンプトの合成
    const userPrefix = t("prompts.template.userInstructionPrefix");
    const systemPrompt = userSystemPrompt
      ? `${baseSystemPrompt}\n\n${userPrefix}\n${userSystemPrompt}`
      : baseSystemPrompt;
    this.isAiProcessing = true;
    this.aiAbortController = new AbortController();
    // ローディング表示
    this.aiThinkingMode = label;
    this.setAiLoading(true);

    try {
      let resultText = "";
      // 長文対応のため、トークン制限を無視（多めに設定: 例 8192）
      const tempMaxTokens = 8192;

      if (this.mainAiApi === "gemini") {
        const apiKey = await this.store.get<string>("geminiApiKey");
        if (!apiKey) throw new Error("Gemini API Key is not set.");
        resultText = await this.requestGeminiDirect(
          apiKey,
          selectedText,
          systemPrompt,
          tempMaxTokens,
          this.aiAbortController?.signal,
        );
      } else if (this.mainAiApi === "cohere") {
        const apiKey = await this.store.get<string>("cohereApiKey");
        const model =
          (await this.store.get<string>("cohereModel")) ||
          "command-r-plus-08-2024";
        if (!apiKey) throw new Error("Cohere API Key is not set.");
        resultText = await this.requestCohereV2Direct(
          apiKey,
          model,
          selectedText,
          systemPrompt,
          tempMaxTokens,
          this.aiAbortController.signal,
        );
      } else {
        let url = "",
          apiKey = "",
          model = "";

        if (this.mainAiApi === "groq") {
          url = "https://api.groq.com/openai/v1/chat/completions";
          apiKey = (await this.store.get<string>("groqApiKey")) || "";
          model =
            (await this.store.get<string>("groqModel")) ||
            "llama-3.3-70b-versatile";
        } else if (this.mainAiApi === "cerebras") {
          url = "https://api.cerebras.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("cerebrasApiKey")) || "";
          model =
            (await this.store.get<string>("cerebrasModel")) || "gemma-4-31b";
        } else if (this.mainAiApi === "openRouter") {
          url = "https://openrouter.ai/api/v1/chat/completions";
          apiKey = (await this.store.get<string>("openRouterApiKey")) || "";
          model =
            (await this.store.get<string>("openRouterModel")) ||
            "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
        } else if (this.mainAiApi === "mistral") {
          url = "https://api.mistral.ai/v1/chat/completions";
          apiKey = (await this.store.get<string>("mistralApiKey")) || "";
          model =
            (await this.store.get<string>("mistralModel")) ||
            "mistral-small-latest";
        } else if (this.mainAiApi === "local") {
          url =
            (await this.store.get<string>("localLlmUrl")) ||
            "http://127.0.0.1:1234/v1/chat/completions";
          apiKey = "local";
          model =
            (await this.store.get<string>("localLlmModel")) || "local-model";
        }

        if (this.mainAiApi !== "local" && !apiKey)
          throw new Error(`${this.mainAiApi} API Key is not set.`);
        resultText = await this.requestOpenAICompatibleDirect(
          url,
          apiKey,
          model,
          selectedText,
          systemPrompt,
          tempMaxTokens,
          this.aiAbortController.signal,
        );
      }

      // 挿入処理 (選択範囲の後ろに改行を入れて追記)
      if (resultText) {
        const insertText = `\n\n${label}\n----------------\n${resultText}\n----------------\n`;

        view.dispatch({
          changes: { from: selection.to, insert: insertText },
          // 挿入された部分を選択状態にするか、カーソルを移動するか
          // ここではカーソルを挿入後の末尾に移動
          selection: { anchor: selection.to + insertText.length },
        });

        // スクロール
        view.dispatch({
          effects: EditorView.scrollIntoView(selection.to + insertText.length, {
            y: "center",
          }),
        });
      }
    } catch (e: any) {
      this.handleAiError(e);
    } finally {
      this.aiThinkingMode = "";
      this.clearAiProcessingState();
    }
  }

  // 共通のエラーハンドラ
  private handleAiError(e: any) {
    if (this.aiAbortController?.signal.aborted) {
      console.log("AI Task was aborted by user.");
      return; // 中断時は何も表示しない
    }
    console.error(e);
    const errorMsg = e.message || String(e);
    message(`AI Error: ${errorMsg}`, { title: "Error", kind: "error" });
  }

  // 共通のクリーンアップ
  private clearAiProcessingState() {
    this.isAiProcessing = false;
    this.aiAbortController = null;
    this.setAiLoading(false);
    this.editorView.focus();
  }

  // --- Geminiへの直接リクエスト ---
  private async requestGeminiDirect(
    apiKey: string,
    prompt: string,
    systemPrompt: string,
    maxTokensOverride?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const model =
      (await this.store.get<string>("geminiModel")) || "gemini-3.1-flash-lite";

    // 数値として確実に取得する (Storeから文字列で返ってくる場合の対策)
    // オーバーライドがあればそれを使い、なければ設定値を使う
    let maxTokens = maxTokensOverride;
    if (!maxTokens) {
      const stored =
        (await this.store.get<number | string>("aiMaxTokens")) || 2000;
      maxTokens = typeof stored === "string" ? parseInt(stored, 10) : stored;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: { text: systemPrompt } },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          // 安全性フィルターを無効化
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_NONE",
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_NONE",
            },
          ],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.8, // 少し創造性を上げる (0.7 -> 0.8)
          },
        }),
        signal: signal,
      });

      if (!response.ok) {
        throw new Error(
          `Gemini API Error: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      // デバッグ用: ログを見て finishReason を確認する
      // finishReason が "SAFETY" ならブロックされている、"MAX_TOKENS" なら長さ制限
      console.log("Gemini Response Data:", data);

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (text) {
        return text;
      } else {
        // テキストがない場合、ブロックされた理由が含まれている可能性がある
        const finishReason = data.candidates?.[0]?.finishReason;
        throw new Error(`No response text. Finish Reason: ${finishReason}`);
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  // --- 汎用: OpenAI互換API (Groq, Mistral, Local LLM) への直接リクエスト ---
  private async requestOpenAICompatibleDirect(
    url: string,
    apiKey: string,
    modelName: string,
    prompt: string,
    systemPrompt: string,
    maxTokensOverride?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let maxTokens = maxTokensOverride;
    if (!maxTokens) {
      maxTokens = Number(await this.store.get<number>("aiMaxTokens")) || 2000;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          stream: false, // メインエディタは一括取得
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (e) {
      console.error("OpenAI Compatible API Error:", e);
      throw e;
    }
  }

  // --- Cohere v2 APIへの直接リクエスト ---
  private async requestCohereV2Direct(
    apiKey: string,
    modelName: string,
    prompt: string,
    systemPrompt: string,
    maxTokensOverride?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let maxTokens = maxTokensOverride;
    if (!maxTokens) {
      maxTokens = Number(await this.store.get<number>("aiMaxTokens")) || 2000;
    }
    try {
      const response = await fetch("https://api.cohere.com/v2/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Cohere API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      return data.message?.content?.[0]?.text || "";
    } catch (e) {
      console.error("Cohere API Error:", e);
      throw e;
    }
  }

  private async visualizeSelection() {
    if (this.isAiProcessing) return;

    const selection = this.editorView.state.selection.main;
    if (selection.empty) {
      await message(t("editor.noSelection"), { kind: "info" });
      return;
    }

    const selectedText = this.editorView.state.sliceDoc(
      selection.from,
      selection.to,
    );
    const imageProvider =
      (await this.store.get<string>("imageGenProvider")) || "mistral";
    const imageSystemPrompt =
      (await this.store.get<string>("imageSystemPrompt")) || "";
    const exePath = (await this.store.get<string>("sdWebUIPath")) || "";
    const exePathLower = exePath.toLowerCase();
    const isCppCli =
      exePathLower.endsWith("sd-cli.exe") || exePathLower.endsWith("sd-cli");
    const isCppServer =
      exePathLower.endsWith("sd-server.exe") ||
      exePathLower.endsWith("sd-server");

    this.isAiProcessing = true;
    this.aiAbortController = new AbortController();
    this.aiThinkingMode = "[Visualize]";
    this.setAiLoading(true);

    try {
      // imageUrlOrBase64には、Mistralなら「httpから始まるURL」、Local SDなら「Base64の画像データ」が入る
      let imageUrlOrBase64 = "";
      let savedPath = "";

      if (imageProvider === "mistral") {
        // --- A. Mistral Agent 処理 ---
        const mistralAgent = await this.store.get<string>("mistralAgentID");
        const enableAgents =
          (await this.store.get<boolean>("enableMistralAgents")) ?? false;
        const apiKey = await this.store.get<string>("mistralApiKey");

        if (!apiKey || !mistralAgent || !enableAgents) {
          throw new Error(t("editor.ai.mistralAgentRequired"));
        }

        const baseSystemPrompt = t("prompts.systemPrompt.visualize");
        const userPrefix = t("prompts.template.userInstructionPrefix");
        const systemPrompt = imageSystemPrompt
          ? `${baseSystemPrompt}\n\n${userPrefix}\n${imageSystemPrompt}`
          : baseSystemPrompt;

        const response = await fetch(
          "https://api.mistral.ai/v1/agents/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              agent_id: mistralAgent,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: selectedText },
              ],
            }),
            signal: this.aiAbortController.signal,
          },
        );

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content || "";
        const urlMatch = content.match(/https?:\/\/[^\s"']+/);

        if (!urlMatch) throw new Error("No image URL found in response.");
        imageUrlOrBase64 = urlMatch[0]; // Mistralの画像URL
        savedPath =
          (await this.handleImageGenerationResult(imageUrlOrBase64)) || "";
      } else {
        // --- B. Local Stable Diffusion 処理 ---
        this.aiThinkingMode = "Translating scene to prompt...";
        const promptGenSystem =
          "Task: Convert the provided scene description into a concise, comma-separated English prompt for Stable Diffusion. Use maximum 30 tags. Focus ONLY on the most important subjects, setting, and atmosphere. No explanations.";
        let sdPrompt = "";
        const tempMaxTokens = 1000;

        // メインAIによるプロンプト生成（既存のAI分岐ロジック）
        if (this.mainAiApi === "gemini") {
          const apiKey = await this.store.get<string>("geminiApiKey");
          if (!apiKey) throw new Error("Gemini API Key is not set.");
          sdPrompt = await this.requestGeminiDirect(
            apiKey,
            selectedText,
            promptGenSystem,
            tempMaxTokens,
            this.aiAbortController?.signal,
          );
        } else if (this.mainAiApi === "cohere") {
          const apiKey = await this.store.get<string>("cohereApiKey");
          const model =
            (await this.store.get<string>("cohereModel")) ||
            "command-r-plus-08-2024";
          if (!apiKey) throw new Error("Cohere API Key is not set.");
          sdPrompt = await this.requestCohereV2Direct(
            apiKey,
            model,
            selectedText,
            promptGenSystem,
            tempMaxTokens,
            this.aiAbortController?.signal,
          );
        } else {
          let url = "",
            apiKey = "",
            model = "";
          if (this.mainAiApi === "groq") {
            url = "https://api.groq.com/openai/v1/chat/completions";
            apiKey = (await this.store.get<string>("groqApiKey")) || "";
            model =
              (await this.store.get<string>("groqModel")) ||
              "llama-3.3-70b-versatile";
          } else if (this.mainAiApi === "cerebras") {
            url = "https://api.cerebras.ai/v1/chat/completions";
            apiKey = (await this.store.get<string>("cerebrasApiKey")) || "";
            model =
              (await this.store.get<string>("cerebrasModel")) || "gemma-4-31b";
          } else if (this.mainAiApi === "openRouter") {
            url = "https://openrouter.ai/api/v1/chat/completions";
            apiKey = (await this.store.get<string>("openRouterApiKey")) || "";
            model =
              (await this.store.get<string>("openRouterModel")) ||
              "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
          } else if (this.mainAiApi === "mistral") {
            url = "https://api.mistral.ai/v1/chat/completions";
            apiKey = (await this.store.get<string>("mistralApiKey")) || "";
            model =
              (await this.store.get<string>("mistralModel")) ||
              "mistral-small-latest";
          } else if (this.mainAiApi === "local") {
            url =
              (await this.store.get<string>("localLlmUrl")) ||
              "http://127.0.0.1:1234/v1/chat/completions";
            apiKey = "local";
            model =
              (await this.store.get<string>("localLlmModel")) || "local-model";
          }
          if (this.mainAiApi !== "local" && !apiKey)
            throw new Error(`${this.mainAiApi} API Key is not set.`);
          sdPrompt = await this.requestOpenAICompatibleDirect(
            url,
            apiKey,
            model,
            selectedText,
            promptGenSystem,
            tempMaxTokens,
            this.aiAbortController?.signal,
          );
        }

        // --- Local SD ---
        this.aiThinkingMode = "Generating Image with Local SD...";
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");

        const negPrompt =
          (await this.store.get<string>("sdNegativePrompt")) ||
          "easynegative, low quality, bad anatomy, text, watermark";
        const steps = Number(await this.store.get<number>("sdSteps")) || 20;
        const cfg = Number(await this.store.get<number>("sdCfgScale")) || 7.0;
        const resolution =
          (await this.store.get<string>("sdResolution")) || "512x512";
        const [widthStr, heightStr] = resolution.split("x");
        const width = Number(widthStr) || 512;
        const height = Number(heightStr) || 512;

        const finalPrompt = imageSystemPrompt
          ? `${imageSystemPrompt}, ${sdPrompt}`
          : sdPrompt;

        if (isCppCli) {
          // --- B-1. sd-cli.exe (Rust内蔵エンジン) モード ---
          const autoSaveDir =
            (await this.store.get<string>("imageAutoSavePath")) || "";
          const modelPath = await this.store.get<string>("sdModelPath");

          // Rust側で生成し、直接保存ディレクトリへ書き込ませる
          savedPath = await invoke<string>("generate_image_cpp", {
            exePath: exePath,
            modelPath: modelPath,
            prompt: finalPrompt,
            negPrompt: negPrompt,
            steps: steps,
            cfg: cfg,
            sampler: (await this.store.get("sdSampler")) || "euler_a",
            scheduler: (await this.store.get("sdScheduler")) || "default",
            width: width,
            height: height,
            saveDir: autoSaveDir,
          });
          // 保存成功通知
          if (savedPath) {
            await message(
              t("editor.ai.imageSavedSuccess", { path: savedPath }),
              { kind: "info" },
            );
          }
        } else if (isCppServer) {
          // --- B-2. sd-server モード ---

          const imageUrlOrBase64 = await this.requestCppServerImage(
            sdPrompt,
            imageSystemPrompt,
            this.aiAbortController?.signal,
          );
          savedPath =
            (await this.handleImageGenerationResult(imageUrlOrBase64)) || "";
        } else {
          // --- B-3. AUTOMATIC1111 / Forge モード ---
          const response = await tauriFetch(
            "http://127.0.0.1:7860/sdapi/v1/txt2img",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: finalPrompt,
                negative_prompt: negPrompt,
                steps: steps,
                cfg_scale: cfg,
                width: width,
                height: height,
              }),
              connectTimeout: 60000,
              signal: this.aiAbortController?.signal,
            },
          );

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(
              `SD API Error (${response.status}): ${errText}\n※SDが --api オプション付きで起動しているか確認してください。`,
            );
          }

          const data = await response.json();
          // Local SDからは Base64文字列 が返ってくる
          imageUrlOrBase64 = `data:image/png;base64,${data.images[0]}`;
          savedPath =
            (await this.handleImageGenerationResult(imageUrlOrBase64)) || "";
        }
      }

      // --- C. 保存処理とエディタへの挿入 ---
      this.aiThinkingMode = "Saving image...";

      if (savedPath) {
        // 保存に成功したら、ローカルパスを asset:// 形式に変換
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const assetUrl = convertFileSrc(savedPath);
        const fileName = savedPath.split(/[\\/]/).pop() || "illustration.jpg";

        // 選択範囲の直後に Markdown 形式で画像を挿入
        const insertText = `\n\n![${fileName}](${assetUrl})\n`;

        this.editorView.dispatch({
          changes: { from: selection.to, insert: insertText },
          selection: { anchor: selection.to + insertText.length },
        });

        // 挿入した位置までスクロール
        this.editorView.dispatch({
          effects: EditorView.scrollIntoView(selection.to + insertText.length, {
            y: "center",
          }),
        });
      }
    } catch (e: any) {
      // シグナルがONかどうかだけで判定する
      if (this.aiAbortController?.signal.aborted) {
        console.log("Abort detected, killing processes...");

        // sd-cli (C++エンジン) を殺す
        await invoke("abort_image_cpp").catch(() => {});

        // sd-server や WebUI の計算も念のため止める
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        tauriFetch("http://127.0.0.1:7860/sdapi/v1/interrupt", {
          method: "POST",
        }).catch(() => {});
        tauriFetch("http://127.0.0.1:8888/sdapi/v1/interrupt", {
          method: "POST",
        }).catch(() => {});
      } else {
        // ユーザーがキャンセルしていないのにエラーが起きた場合は、真の異常事態
        this.handleAiError(e);
      }
    } finally {
      this.aiThinkingMode = "";
      this.setAiLoading(false);
      this.isAiProcessing = false;
      this.aiAbortController = null;
    }
  }

  private async handleImageGenerationResult(
    urlOrBase64: string | Uint8Array,
  ): Promise<string | null> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");

    let savePath: string | null =
      (await this.store.get<string>("imageAutoSavePath")) ?? null;

    if (!savePath || savePath.trim() === "") {
      savePath = await save({
        title: t("editor.ai.saveImageTitle"),
        defaultPath: `illustration_${Date.now()}.jpg`,
        filters: [{ name: "Images", extensions: ["jpg", "png"] }],
      });
    } else {
      const separator = savePath.includes("/") ? "/" : "\\";
      savePath = savePath.endsWith(separator)
        ? `${savePath}ms_img_${Date.now()}.png`
        : `${savePath}${separator}ms_img_${Date.now()}.png`;
    }

    if (!savePath) return null; // キャンセル時

    let uint8Array: Uint8Array;

    if (typeof urlOrBase64 === "string") {
      if (urlOrBase64.startsWith("data:image/")) {
        // Base64 (Forge/A1111 API) の場合
        const base64Data = urlOrBase64.split(",")[1];
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        uint8Array = bytes;
      } else {
        // URL (Mistral Agent) の場合
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const res = await tauriFetch(urlOrBase64, { method: "GET" });
        const arrayBuffer = await res.arrayBuffer();
        uint8Array = new Uint8Array(arrayBuffer);
      }
    } else {
      // 生バイナリ (sd-server API) の場合
      uint8Array = urlOrBase64;
    }

    // Rust側でローカルファイルとして保存
    await invoke("force_save_file", {
      path: savePath,
      content: Array.from(uint8Array),
    });

    // 挿入してプレビューですぐ見られるので、毎回「ブラウザで開くか？」と聞かずトースト通知のみ
    await message(t("editor.ai.imageSavedSuccess", { path: savePath }), {
      kind: "info",
    });

    // 保存したパスを返す
    return savePath;
  }

  private async requestCppServerImage(
    prompt: string,
    prefix: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");

    const negPrompt =
      (await this.store.get<string>("sdNegativePrompt")) ||
      "easynegative, low quality, bad anatomy";
    const steps = Number(await this.store.get<number>("sdSteps")) || 20;
    const cfg = Number(await this.store.get<number>("sdCfgScale")) || 7.0;
    const sampler = (await this.store.get<string>("sdSampler")) || "euler_a";
    const scheduler =
      (await this.store.get<string>("sdScheduler")) || "default";
    const resolution =
      (await this.store.get<string>("sdResolution")) || "512x512";
    const [widthStr, heightStr] = resolution.split("x");
    const width = Number(widthStr) || 512;
    const height = Number(heightStr) || 512;

    const finalPrompt = prefix ? `${prefix}, ${prompt}` : prompt;

    let response;
    try {
      // sd-server の API エンドポイント (ポート8888)
      response = await tauriFetch("http://127.0.0.1:8888/sdapi/v1/txt2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: finalPrompt,
          negative_prompt: negPrompt,
          steps: steps,
          cfg_scale: cfg,
          sample_method: sampler, // API仕様に合わせる
          schedule_method: scheduler,
          width: width,
          height: height,
          seed: -1,
        }),
        connectTimeout: 60000,
        signal: signal,
      });
    } catch (e) {
      throw new Error(
        `Failed to connect to sd-server (Port 8888). Please make sure the server is running.\nDetails: ${e}`,
      );
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(
        `sd-server API failed (Status: ${response.status}): ${err}`,
      );
    }

    const data = await response.json();
    if (!data.images || data.images.length === 0) {
      throw new Error("sd-server did not return any images.");
    }

    // Base64形式のURLとして返す（既存のA1111処理と合流）
    return `data:image/png;base64,${data.images[0]}`;
  }

  // コード用の拡張機能セットを返すヘルパー
  private createCodeExtensions(): Extension[] {
    const isMac = this.currentOs === "macos";
    // 基本セット
    const extensions: Extension[] = [
      this.tokyoNightCustomTheme,
      lineNumbers(),
      indentUnit.of("    "),
      bracketMatching(),
      history(),
      keymap.of([...historyKeymap, ...searchKeymap]),
      // EditorView.lineWrapping,
      scrollPastEnd(),
      EditorView.updateListener.of((update: ViewUpdate) =>
        this.onEditorUpdate(update),
      ),
      this.languageCompartment.of([]),
      this.codeFontCompartment.of(this.createCodeFontTheme()),
    ];

    if (isMac) {
      extensions.push(drawSelection());
      // Mod-a は keymap.of 内で処理
    }

    // モジュールがロード済みなら、高度な機能を追加する
    if (this.isCodeExtrasLoaded && this.codeExtras) {
      const { lang, auto } = this.codeExtras;
      extensions.push(
        search({
          top: true,
          scrollToMatch: (
            range: SelectionRange,
            _view: EditorView,
          ): StateEffect<unknown> => {
            return EditorView.scrollIntoView(range.from, { y: "center" });
          },
        }),
        lang.foldGutter(), // 折りたたみ
        lang.indentOnInput(), // オートインデント
        auto.closeBrackets(), // 括弧の自動補完
        auto.autocompletion(), // オートコンプリート
        keymap.of([
          ...defaultKeymap,
          ...lang.foldKeymap,
          ...auto.closeBracketsKeymap,
          ...auto.completionKeymap,
          { key: "Tab", run: insertTab },
          { key: "Enter", run: insertNewlineAndIndent },
          {
            key: "Mod-ArrowUp",
            run: (v) => {
              cursorDocStart(v);
              v.dispatch({
                effects: EditorView.scrollIntoView(0, { y: "start" }),
              });
              return true;
            },
          },
          {
            key: "Mod-ArrowDown",
            run: (v) => {
              cursorDocEnd(v);
              v.dispatch({
                effects: EditorView.scrollIntoView(
                  v.state.selection.main.head,
                  { y: "center" },
                ),
              });
              return true;
            },
          },
          {
            key: "Alt-Enter",
            run: () => {
              this.runAiCompletion();
              return true;
            },
          },
        ]),
      );
      if (this.codeLineWrap) {
        extensions.push(EditorView.lineWrapping);
      }
    }

    return extensions;
  }

  // ヘルパー: コードモード用フォント設定の作成
  private createCodeFontTheme(): Extension {
    console.log(
      `Creating Code Font Theme: ${this.codeFontFamily}, ${this.codeFontSize}`,
    );
    return EditorView.theme({
      "&": {
        // フォントサイズとファミリーを適用
        fontSize: `${this.codeFontSize}pt !important`,
        fontFamily:
          this.codeFontFamily === "default"
            ? "monospace !important"
            : `"${this.codeFontFamily}", monospace !important`,
      },
      ".cm-content": {
        fontFamily:
          this.codeFontFamily === "default"
            ? "monospace !important"
            : `"${this.codeFontFamily}", monospace !important`,
      },
    });
  }

  // コードモード用のフォントCSS変数を更新
  private updateCodeFontCss() {
    const fontVal =
      this.codeFontFamily === "default"
        ? "monospace" // デフォルトの場合
        : `"${this.codeFontFamily}", monospace`; // 指定フォントの場合

    document.body.style.setProperty("--code-font-family", fontVal);
  }

  // 拡張子から言語IDを取得するヘルパー
  private detectLanguageFromExtension(path: string): string | null {
    const ext = path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "rs":
        return "rust";
      case "py":
        return "python";
      case "ts":
      case "js":
      case "json":
        return "typescript"; // JS/JSONもTSパーサーでOK
      case "md":
      case "txt":
        return "markdown";
      case "html":
      case "htm":
        return "html";
      case "astro":
        return "html"; // とりあえずhtml扱い
      case "css":
        return "css";
      default:
        return null; // 判別不能
    }
  }

  // --- 初期化 ---

  private async initialize() {
    this.currentOs = await type();
    // UI要素のチェック
    if (
      !this.editorContainer ||
      !this.fileListContainer ||
      !this.outlineControls ||
      !this.outlineControls2 ||
      !this.outlineContainer
    ) {
      console.error("Fatal Error: A required UI container was not found.");
      return;
    }

    // Linux の場合は Rust 側にフル機能許可フラグを問い合わせる
    if (this.currentOs === "linux") {
      this.isFullFeatureAvailable = await invoke<boolean>("is_full_feature_supported");
    }

    // Linuxのときは一部機能を使用不可に
    if (
      !this.isFullFeatureAvailable &&
      this.markdownBtn &&
      this.typesoundBtn &&
      this.spotlightBtn
    ) {
      this.markdownBtn.style.display = "none";
      this.typesoundBtn.style.display = "none";
      this.spotlightBtn.style.display = "none";
    }

    // テーマとフォントの定義
    this.defineThemesAndFonts();
    this.createEditorExtensions();

    // CodeMirrorインスタンスを「デフォルト設定」で生成
    this.editorView = new EditorView({
      state: EditorState.create({
        extensions: this.mainCompartment.of(this.createEditorExtensions()),
      }),
      parent: this.editorContainer,
    });

    this.setupDragAndDrop();

    // イベントリスナーを設定
    this.setupEventListeners();

    // ステータスバーの初期描画と時計の開始
    this.updateStatusBar(this.editorView);
    setInterval(() => {
      this.updateStatusBarTimeOnly();
    }, 1000);

    // Storeをロード
    const storePromise = Store.load(".settings.dat");

    this.store = await storePromise;

    // i18nの初期化 (appLanguage設定を読んで翻訳を適用)
    const appLanguage = (await this.store.get<string>("appLanguage")) || "ja";
    await initI18n(appLanguage as "ja" | "en");
    applyTranslationsToDOM();

    // 5. 起動時にファイルが指定されたか確認
    // Windows/Linux: CLI引数を確認
    let fileToOpen = await invoke<string | null>("get_initial_file");

    // Mac: CLI引数がなければ、Mac用のStateを確認
    if (!fileToOpen && this.currentOs === "macos") {
      try {
        const macFile = await invoke<string | null>("get_mac_file_event");
        if (macFile) {
          fileToOpen = macFile;
        }
      } catch (e) {
        console.error(e);
      }
    }

    // AIセレクターの初期化
    this.initMainAiSelector();

    // ファイル指定があるかどうかのフラグ
    const hasInitialFile = !!fileToOpen;

    // 6. 設定を読み込む (戻り値としてセッションパスを受け取る)
    const sessionFilePaths = await this.loadSettings();

    //  読み込んだ設定をUIに完全に反映
    this.editorView.dispatch({
      effects: [
        this.mainCompartment.reconfigure(this.createEditorExtensions()),
      ],
    });
    this.updateFontSettings();
    document.body.classList.toggle("dark-mode", this.isDarkMode);
    document.body.classList.remove(...this.fontClassNames);
    document.body.classList.add(this.fontClassNames[this.currentFontIndex]);

    const btnTypesound = document.querySelector(
      "#btn-typesound",
    ) as HTMLElement;
    if (this.isTypeSoundEnabled) {
      btnTypesound.classList.add("enabled");
    } else {
      btnTypesound.classList.remove("enabled");
    }
    const btnSpotlight = document.querySelector(
      "#btn-spotlight",
    ) as HTMLElement;
    if (this.isSpotlightMode) {
      btnSpotlight.classList.add("enabled");
    } else {
      btnSpotlight.classList.remove("enabled");
    }

    //  背景画像、タイプ音の初期化（BGMは重いのでここでは呼ばない）
    // settings-changedイベント、あるいはtoggleBGMイベントでloadBGMDataが
    // 呼ばれた時に初めてインポートされる
    await this.updateBackground();
    if (this.isTypeSoundEnabled) {
      await this.initializeTypeSound();
    }

    await listen("settings-changed", async (event: any) => {
      console.log("Received settings-changed payload:", event.payload);
      const s = event.payload;

      // 言語変更があればi18nを再初期化
      if (s.appLanguage) {
        await initI18n(s.appLanguage as "ja" | "en");
        applyTranslationsToDOM();
        emit("app:language-changed", s.appLanguage);
      }

      // エディタ設定の更新
      if (s.editorMaxWidth !== undefined) {
        this.updateEditorWidthVariable(s.editorMaxWidth);
      }
      if (s.editorPaddingX !== undefined) {
        this.updateEditorPaddingXVariable(s.editorPaddingX);
      }
      if (s.editorLineHeight) this.updateEditorLineHeight(s.editorLineHeight);
      if (s.editorLineBreak) this.updateEditorLineBreak(s.editorLineBreak);
      if (s.editorWordBreak) this.updateEditorWordBreak(s.editorWordBreak);
      if (s.userFontFamily !== undefined) {
        this.userFontFamily = s.userFontFamily;
        this.updateFontSettings();
      }

      // 画像・BGMの更新
      // ペイロードに含まれていれば更新する
      // undefinedチェックに加え、null(リセット指示)も通す
      if (s.userBackgroundImagePath !== undefined) {
        // パスが同じなら再描画しない（ちらつき防止）
        // ただし null (デフォルトに戻す) の場合は常に更新
        if (
          this.userBackgroundImagePath !== s.userBackgroundImagePath ||
          s.userBackgroundImagePath === null
        ) {
          this.userBackgroundImagePath = s.userBackgroundImagePath || undefined; // nullならundefinedに戻す
          await this.updateBackground();
        }
      }

      // BGMのスマート更新
      if (s.userBgmPath !== undefined) {
        // 比較のために正規化する
        // (null, undefined, "" はすべて空文字 '' に変換して比較)
        const currentPathNorm = this.userBgmPath || "";
        const newPathNorm = s.userBgmPath || "";

        // 正規化した状態で比較
        if (currentPathNorm !== newPathNorm) {
          // 変更があった場合のみ更新
          this.userBgmPath = s.userBgmPath || undefined; // 実体は undefined にしておく(または空文字でも可)

          await this.loadBGMData();
          this.playBGM(); // ここで再生される
          this.isBgmPlaying = true;
          document.querySelector("#btn-bgm-toggle")?.classList.add("playing");
        }
        // パスが同じなら何もしない -> 曲は止まらない
      }

      if (s.editorAlign !== undefined) {
        this.updateEditorAlign(s.editorAlign);
      }
      if (s.editorBlur !== undefined && s.editorBlur > 0) {
        this.editorBlur = s.editorBlur;
        document.documentElement.style.setProperty(
          "--editor-blur",
          `${s.editorBlur}px`,
        );
      } else {
        document.documentElement.style.setProperty("--editor-blur", `none`);
      }

      // 半透明ウィンドウ反映
      if (s.editorAlign) {
        this.editorAlign = s.editorAlign; // プロパティ更新
        this.updateEditorAlign(s.editorAlign);
      }

      if (s.customEditorBg !== undefined) {
        if (s.customEditorBg) {
          document.documentElement.style.setProperty(
            "--editor-bg-color",
            s.customEditorBg,
          );
        } else {
          document.documentElement.style.removeProperty("--editor-bg-color");
        }
        this.customEditorBg = s.customEditorBg;
      }
      if (s.editorBlur !== undefined) {
        this.editorBlur = s.editorBlur;
      }
      if (s.customWindowBg !== undefined) {
        if (s.customWindowBg) {
          document.documentElement.style.setProperty(
            "--window-bg-color",
            s.customWindowBg,
          );
        } else {
          document.documentElement.style.removeProperty("--window-bg-color");
        }
        this.customWindowBg = s.customWindowBg;
      }
      if (s.customTextColor !== undefined) {
        if (s.customTextColor) {
          document.documentElement.style.setProperty(
            "--editor-text-color",
            s.customTextColor,
          );
        } else {
          document.documentElement.style.removeProperty("--editor-text-color");
        }
        this.customTextColor = s.customTextColor;
      }
      if (s.customUiTextColor !== undefined) {
        if (s.customUiTextColor) {
          document.documentElement.style.setProperty(
            "--ui-text-color",
            s.customUiTextColor,
          );
        } else {
          document.documentElement.style.removeProperty("--ui-text-color");
        }
        this.customUiTextColor = s.customUiTextColor;
      }
      if (s.customSelectionColor !== undefined) {
        if (s.customSelectionColor) {
          document.documentElement.style.setProperty(
            "--selection-color",
            s.customSelectionColor,
          );
        } else {
          document.documentElement.style.removeProperty("--selection-color");
        }
        this.customSelectionColor = s.customSelectionColor;
      }
      if (s.customScrollbarColor !== undefined) {
        if (s.customScrollbarColor) {
          document.documentElement.style.setProperty(
            "--scrollbar-color",
            s.customScrollbarColor,
          );
        } else {
          document.documentElement.style.removeProperty("--scrollbar-color");
        }
        this.customScrollbarColor = s.customScrollbarColor;
      }
      if (s.customHeadingColor !== undefined) {
        if (s.customHeadingColor) {
          document.documentElement.style.setProperty(
            "--heading-color",
            s.customHeadingColor,
          );
        } else {
          document.documentElement.style.removeProperty("--heading-color");
        }
        this.customHeadingColor = s.customHeadingColor;
      }
      if (s.enableGlow !== undefined) {
        this.enableGlow = s.enableGlow;
        this.updateGlowEffect();
      }
      if (s.glowColor !== undefined) {
        this.glowColor = s.glowColor;
        this.updateGlowEffect();
      }
      if (s.glowRadius !== undefined) {
        this.glowRadius = s.glowRadius;
        this.updateGlowEffect();
      }
      if (s.useUiBg !== undefined) {
        this.useUiBg = s.useUiBg;
        this.updateUiBg();
      }
      if (s.showAiThinkingOverlay !== undefined) {
        this.showAiThinkingOverlay = s.showAiThinkingOverlay;
        this.updateAiThinkingStyle();
      }

      // コードブロックの言語設定
      if (s.codeLanguage) {
        const oldLang = this.currentCodeLanguage;
        this.currentCodeLanguage = s.codeLanguage;
        console.log(
          `Code language changed from ${oldLang} to ${this.currentCodeLanguage}`,
        );
        // もし現在コードモード中なら、設定変更を即座に反映させる
        if (this.isCodeMode && oldLang !== this.currentCodeLanguage) {
          await this.getLanguageSupport();
          console.log("Code language applied immediately.");
        }
      }
      if (s.codeFontFamily !== undefined)
        this.codeFontFamily = s.codeFontFamily;
      if (s.codeFontSize !== undefined) this.codeFontSize = s.codeFontSize;
      if (s.codeLineWrap !== undefined) {
        this.codeLineWrap = s.codeLineWrap;
        // コードモード中なら即座に反映
        if (this.isCodeMode) {
          this.editorView.dispatch({
            effects: this.mainCompartment.reconfigure(
              this.createCodeExtensions(),
            ),
          });
        }
      }

      if (this.isCodeMode) {
        this.editorView.dispatch({
          effects: this.codeFontCompartment.reconfigure(
            this.createCodeFontTheme(),
          ),
        });
        this.updateCodeFontCss();
      }
      if (s.mdHardBreaks !== undefined) {
        this.mdHardBreaks = s.mdHardBreaks;
      }
    });

    // AI動作中のキー入力ガード
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.isAiProcessing) {
          // Escapeキー（中断）以外のすべてのキー入力を握り潰す
          if (e.key !== "Escape") {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      },
      { capture: true },
    );

    // プレビューからの更新要求に応える
    await listen("preview-request-update", async () => {
      await this.sendDataToPreview(true);
    });

    await listen("markdown-request-update", () => {
      const textLength = this.editorView.state.doc.length;
      const limit = 50000;
      // 更新ボタンやタブ切り替えで呼ばれた場合、いちいちダイアログを出すとうるさいので
      // 巨大ファイルなら「自動的に」制限モード(true)で送る
      const shouldTruncate = textLength > limit;
      this.sendDataToMarkdownPreview(shouldTruncate);
    });

    // サブウィンドウから設定画面を開く
    await listen("open-settings", async () => {
      await this.openSettingsWindow();
    });

    // --- エクスポートウィンドウとの連携 ---
    await listen("export-request-data", async () => {
      // 現在のテキストを取得
      const text = this.editorView.state.doc.toString();

      // 必要ならここでMarkdownをHTMLに変換したり、ルビ変換をかけたりする
      // とりあえず生テキストと、簡易HTMLを送る
      // (本格的なMarkdown変換は marked.js などを導入すると楽)

      await emit("export-data", {
        text: text,
        // 簡易的なHTML変換例 (改行をbrに)
        html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
      });
    });

    await listen("subwindow-toggle-theme", () => {
      this.toggleDarkMode();
    });

    await listen("send-content-to-editor", async (event: any) => {
      const content = event.payload.content;
      if (content) {
        // 1. 新規タブを作成
        this.createNewTab("From IP");

        // 2. タブの描画が完了するのを少し待ってからテキストを挿入
        setTimeout(() => {
          if (this.editorView) {
            this.editorView.dispatch({
              changes: { from: 0, insert: content },
            });
          }
        }, 50);
      }
    });

    await listen("preview-font-size", (event: any) => {
      if (event.payload === "up") {
        this.changeFontSize(this.currentFontSize + 1);
      } else if (event.payload === "down") {
        this.changeFontSize(this.currentFontSize - 1);
      } else if (event.payload === "reset") {
        this.changeFontSize(15);
      }
    });

    await listen("request-open-file", async (event: any) => {
      const path = event.payload;
      // ファイルを開く（既に開いていればスイッチ、なければ新規ロード）
      await this.openOrSwitchTab(path);
      this.sendDataToMarkdownPreview(false);
    });

    // AIチャットからの送信を受け取る
    await listen("request-new-tab", (event: any) => {
      const { title, content } = event.payload;
      this.createNewTabWithContent(title, content);
    });

    if (hasInitialFile && fileToOpen) {
      // 指定起動ならそのファイルを開く
      await this.openOrSwitchTab(fileToOpen);
    } else {
      // 通常起動なら復元
      if (sessionFilePaths.length > 0) {
        for (const filePath of sessionFilePaths) {
          await this.openOrSwitchTab(filePath);
        }
        await this.openOrSwitchTab(
          sessionFilePaths[sessionFilePaths.length - 1],
        );
      } else {
        this.createNewTab();
      }
    }

    await getCurrentWindow().show();
    // Niriの場合、画面表示の直前にサイズプリセットを反映する
    await this.applyMainWindowSizePreset();

  }

  private async loadSettings(): Promise<string[]> {
    this.isLoading = true;
    // --- 基本設定の読み込み ---
    const savedIsDarkMode = await this.store.get<boolean>("isDarkMode");
    this.isDarkMode = savedIsDarkMode ?? this.isDarkMode;

    const savedZen = await this.store.get<boolean>("isZenMode");
    this.isZenMode = savedZen ?? false;

    const savedFontIndex = await this.store.get<number>("currentFontIndex");
    this.currentFontIndex = savedFontIndex ?? this.currentFontIndex;

    const savedFontSize = await this.store.get<number>("currentFontSize");
    this.currentFontSize = savedFontSize ?? this.currentFontSize;

    const savedTypeSound = await this.store.get<boolean>("isTypeSoundEnabled");
    this.isTypeSoundEnabled = savedTypeSound ?? false;

    const savedSpotlight = await this.store.get<boolean>("isSpotlightMode");
    this.isSpotlightMode = savedSpotlight ?? false;

    const savedAiThinkingOverlay = await this.store.get<boolean>(
      "showAiThinkingOverlay",
    );
    this.showAiThinkingOverlay = savedAiThinkingOverlay ?? true;
    this.updateAiThinkingStyle();

    // --- エディタ設定 (ヘルパーがあるものはヘルパーに任せる) ---

    // 1. エディタ幅 (ヘルパーあり)
    this.editorMaxWidth =
      (await this.store.get<string>("editorMaxWidth")) ?? "80";
    this.updateEditorWidthVariable(this.editorMaxWidth); // ★ここでCSS設定完了

    // 2. エディタ左右余白
    this.editorPaddingX =
      (await this.store.get<number>("editorPaddingX")) ?? 10;
    this.updateEditorPaddingXVariable(this.editorPaddingX);

    // 3. 行の高さ (ヘルパーはないのでここで設定)
    this.editorLineHeight =
      (await this.store.get<number>("editorLineHeight")) ?? 1.6;
    document.documentElement.style.setProperty(
      "--editor-line-height",
      this.editorLineHeight.toString(),
    );

    // 3. 禁則・ワードラップ (ヘルパーはないのでここで設定)
    this.editorLineBreak =
      (await this.store.get<string>("editorLineBreak")) ?? "strict";
    document.documentElement.style.setProperty(
      "--editor-line-break",
      this.editorLineBreak,
    );

    this.editorWordBreak =
      (await this.store.get<string>("editorWordBreak")) ?? "break-all";
    document.documentElement.style.setProperty(
      "--editor-word-break",
      this.editorWordBreak,
    );

    // 4. フォント (専用メソッドがあるので読み込みのみ)
    this.userFontFamily =
      (await this.store.get<string>("userFontFamily")) ?? "default";
    document.documentElement.style.setProperty(
      "--user-font-family",
      this.userFontFamily,
    );

    // コードエディタ設定の読み込み
    this.codeFontFamily =
      (await this.store.get<string>("codeFontFamily")) ?? "default";
    this.codeFontSize = (await this.store.get<number>("codeFontSize")) ?? 10; // 初期値は10に合わせておく
    this.codeLineWrap =
      (await this.store.get<boolean>("codeLineWrap")) ?? false;
    this.currentCodeLanguage =
      (await this.store.get<string>("codeLanguage")) ?? "html";

    this.mdHardBreaks =
      (await this.store.get<boolean>("mdHardBreaks")) ?? false;

    const align = (await this.store.get<string>("editorAlign")) ?? "center";
    this.updateEditorAlign(align);

    // --- 配色設定 ---

    this.customTextColor =
      (await this.store.get<string>("customTextColor")) ?? "#1e1e1e";
    if (this.customTextColor) {
      document.documentElement.style.setProperty(
        "--editor-text-color",
        this.customTextColor,
      );
    } else {
      document.documentElement.style.removeProperty("--editor-text-color");
    }
    this.customUiTextColor =
      (await this.store.get<string>("customUiTextColor")) ?? "#1e1e1e";
    if (this.customUiTextColor) {
      document.documentElement.style.setProperty(
        "--ui-text-color",
        this.customUiTextColor,
      );
    } else {
      document.documentElement.style.removeProperty("--ui-text-color");
    }
    this.customEditorBg =
      (await this.store.get<string>("customEditorBg")) ??
      "rgba(255, 255, 255, 0)";
    if (this.customEditorBg) {
      document.documentElement.style.setProperty(
        "--editor-bg-color",
        this.customEditorBg,
      );
    }
    this.customWindowBg =
      (await this.store.get<string>("customWindowBg")) ?? "#ffffff";
    if (this.customWindowBg) {
      document.documentElement.style.setProperty(
        "--window-bg-color",
        this.customWindowBg,
      );
    }
    this.customSelectionColor =
      (await this.store.get<string>("customSelectionColor")) ??
      "rgba(100, 150, 250, 0.3)";
    if (this.customSelectionColor) {
      document.documentElement.style.setProperty(
        "--selection-color",
        this.customSelectionColor,
      );
    } else {
      document.documentElement.style.removeProperty("--selection-color");
    }
    this.customScrollbarColor =
      (await this.store.get<string>("customScrollbarColor")) ??
      "rgba(0, 0, 0, 0.2)";
    if (this.customScrollbarColor) {
      document.documentElement.style.setProperty(
        "--scrollbar-color",
        this.customScrollbarColor,
      );
    } else {
      document.documentElement.style.removeProperty("--scrollbar-color");
    }
    this.customHeadingColor =
      (await this.store.get<string>("customHeadingColor")) ?? "#0550AE";
    if (this.customHeadingColor) {
      document.documentElement.style.setProperty(
        "--heading-color",
        this.customHeadingColor,
      );
    } else {
      document.documentElement.style.removeProperty("--heading-color");
    }

    this.enableGlow = (await this.store.get<boolean>("enableGlow")) ?? false;
    this.glowColor =
      (await this.store.get<string>("glowColor")) ?? "rgba(0, 50, 255, 0.5)";
    this.glowRadius = (await this.store.get<number>("glowRadius")) ?? 5;

    // ブラー
    const blur = (await this.store.get<number>("editorBlur")) ?? 0;
    this.editorBlur = blur;
    if (blur > 0) {
      document.documentElement.style.setProperty("--editor-blur", `${blur}px`);
    } else {
      document.documentElement.style.setProperty("--editor-blur", `none`);
    }

    this.useUiBg = (await this.store.get<boolean>("useUiBg")) ?? false;
    this.updateUiBg();

    // --- パス ---
    this.userBackgroundImagePath =
      (await this.store.get<string>("userBackgroundImagePath")) ?? "";
    this.userBgmPath = (await this.store.get<string>("userBgmPath")) ?? "";

    // --- 外観の適用 (テーマ、ハイライトなど) ---
    this.applyAppearance();
    this.updateZenModeUI();

    // --- セッションパス ---
    const savedSessionPaths =
      await this.store.get<string[]>("sessionFilePaths");
    this.isLoading = false;
    return savedSessionPaths ?? [];
  }

  private updateGlowEffect() {
    const body = document.body;

    // ダークモードでない、かつグロー有効の場合のみ適用
    if (!this.isDarkMode && this.enableGlow) {
      body.classList.add("custom-glow");

      // RGBAの解析 (簡易正規表現)
      // "rgba(r, g, b, a)" または "rgb(r, g, b)"
      const match = this.glowColor.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/,
      );

      if (match) {
        const r = match[1];
        const g = match[2];
        const b = match[3];
        let a = parseFloat(match[4] || "1"); // アルファがない場合は1

        // 3段階の影を作成
        // x1
        const shadow1 = `0 0 ${this.glowRadius}px rgba(${r}, ${g}, ${b}, ${a})`;
        // x2 (alpha - 0.1)
        const a2 = Math.max(0, a - 0.1);
        const shadow2 = `0 0 ${this.glowRadius * 2}px rgba(${r}, ${g}, ${b}, ${a2})`;
        // x4 (alpha - 0.2)
        const a3 = Math.max(0, a - 0.2);
        const shadow3 = `0 0 ${this.glowRadius * 4}px rgba(${r}, ${g}, ${b}, ${a3})`;

        const shadowVal = `${shadow1}, ${shadow2}, ${shadow3}`;

        document.documentElement.style.setProperty(
          "--custom-text-shadow",
          shadowVal,
        );
      } else {
        // パース失敗時は色をそのまま使う（フォールバック）
        document.documentElement.style.setProperty(
          "--custom-text-shadow",
          `0 0 ${this.glowRadius}px ${this.glowColor}`,
        );
      }
    } else {
      body.classList.remove("custom-glow");
      document.documentElement.style.removeProperty("--custom-text-shadow");
    }
  }

  // カーソル行数を取得するヘルパー
  private getCursorLineSafe(): number {
    try {
      const state = this.editorView.state;
      // ドキュメントが空、または選択範囲がない場合は 1 を返す
      if (!state.doc || state.doc.length === 0 || !state.selection) {
        return 1;
      }
      const head = state.selection.main.head;
      return state.doc.lineAt(head).number;
    } catch (e) {
      console.warn("Cursor position calc failed, defaulting to 1", e);
      return 1; // エラー時は強制的に1行目とする
    }
  }

  // CSS変数を更新するヘルパー
  private updateEditorWidthVariable(rawValue: string | number) {
    const num =
      typeof rawValue === "string" ? parseInt(rawValue, 10) : rawValue;
    const cssValue = num === 0 || isNaN(num) ? "100%" : `calc(${num}ch + 20px)`;
    document.documentElement.style.setProperty("--editor-max-width", cssValue);

    this.editorMaxWidth = num.toString();
    this.saveSettings();
  }
  private updateEditorPaddingXVariable(newPaddingX: number) {
    document.documentElement.style.setProperty(
      "--editor-padding-x",
      newPaddingX.toString() + "px",
    );
    this.editorPaddingX = newPaddingX;
    this.saveSettings();
  }
  private updateEditorLineHeight(newHeight: number) {
    document.documentElement.style.setProperty(
      "--editor-line-height",
      newHeight.toString(),
    );
    this.editorLineHeight = newHeight;
    this.saveSettings();
  }
  private updateEditorLineBreak(newLineBreak: string) {
    document.documentElement.style.setProperty(
      "--editor-line-break",
      newLineBreak,
    );
    this.editorLineBreak = newLineBreak;
    this.saveSettings();
  }
  private updateEditorWordBreak(value: string) {
    document.documentElement.style.setProperty("--editor-word-break", value);
    this.editorWordBreak = value;
    this.saveSettings(); // 必要ならメイン側のプロパティも更新
  }
  private updateFontSettings() {
    let targetFontString = "";

    if (this.userFontFamily && this.userFontFamily !== "default") {
      // ユーザー指定ありの場合
      // bodyのクラスはすべて削除 (UIフォントをデフォルトに戻す、あるいは指定フォントにする)
      document.body.classList.remove(...this.fontClassNames);

      // エディタ用フォント文字列 (スペース対策で引用符で囲む)
      targetFontString = `"${this.userFontFamily}"`;

      // 必要ならUI用変数も更新
      document.documentElement.style.setProperty(
        "--user-font-family",
        targetFontString,
      );
    } else {
      // デフォルト (サイクル) の場合

      // 配列から取得
      targetFontString = this.fontList[this.currentFontIndex];

      // UI用クラスを適用
      document.body.classList.remove(...this.fontClassNames);
      document.body.classList.add(this.fontClassNames[this.currentFontIndex]);

      document.documentElement.style.removeProperty("--user-font-family");
    }

    // CodeMirrorを再構築するのではなく、CSS変数の値を書き換えるだけ
    // これで即座に反映される
    document.documentElement.style.setProperty(
      "--dynamic-editor-font",
      targetFontString,
    );
  }

  private updateEditorAlign(align: string) {
    const style = document.documentElement.style;
    switch (align) {
      case "left":
        style.setProperty("--editor-margin-left", "30px");
        style.setProperty("--editor-margin-right", "auto");
        break;
      case "right":
        style.setProperty("--editor-margin-left", "auto");
        style.setProperty("--editor-margin-right", "30px");
        break;
      case "center":
      default:
        style.setProperty("--editor-margin-left", "auto");
        style.setProperty("--editor-margin-right", "auto");
        break;
    }
    this.editorAlign = align;
  }

  private updateUiBg() {
    document.body.classList.toggle("ui-bg-enabled", this.useUiBg);
  }

  private getCurrentTheme() {
    if (this.isDarkMode) {
      return this.darkTheme;
    } else {
      return this.lightTheme;
    }
  }

  private applyAppearance() {
    this.editorView.dispatch({
      effects: [
        this.mainCompartment.reconfigure(this.createEditorExtensions()),
      ],
    });

    // bodyクラスのトグル
    document.body.classList.toggle("dark-mode", this.isDarkMode);

    // 背景画像の更新
    this.updateBackground();

    // グローエフェクトの更新
    this.updateGlowEffect();
  }

  private toggleZenMode() {
    if (this.isZenMode) {
      this.isZenMode = false;
    } else {
      this.isZenMode = true;
    }
    this.updateZenModeUI();
    this.saveSettings();
  }

  private updateZenModeUI() {
    if (this.isZenMode) {
      document.body.classList.add("zen-mode");
    } else {
      document.body.classList.remove("zen-mode");
    }
  }

  // --- コードモード切替 ---
  private async toggleCodeMode() {
    // A. コードモードに入る場合
    if (!this.isCodeMode) {
      console.log("Switching to Code Mode...");

      // ライトモード（または半透明モード）なら強制的にダークモードにする
      if (!this.isDarkMode) {
        this.toggleDarkMode();
        this.wasLightModeBeforeCode = true; // 「元はライトだった」と記憶
      } else {
        this.wasLightModeBeforeCode = false; // 元からダークだった
      }

      // 高度な機能を初めて使う時だけロードする
      if (!this.isCodeExtrasLoaded) {
        console.log("Lazy loading code extras...");
        const [lang, auto] = await Promise.all([
          import("@codemirror/language"),
          import("@codemirror/autocomplete"),
        ]);
        this.codeExtras = { lang, auto };
        this.isCodeExtrasLoaded = true;
      }

      // フラグを立てる (toggleDarkModeの後で行うのが重要)
      this.isCodeMode = true;

      // 1. まずテーマや行番号などの基本設定を適用
      this.editorView.dispatch({
        effects: this.mainCompartment.reconfigure(this.createCodeExtensions()),
      });
      // UIのフォントを更新
      this.updateCodeFontCss();

      // 2. 言語サポート適用
      await this.getLanguageSupport();
    }
    // B. コードモードから抜ける場合
    else {
      console.log("Switching back to Text Mode...");

      // 先にフラグを下ろす (これがないと toggleDarkMode 内のガードに弾かれる可能性があるため)
      this.isCodeMode = false;

      // 通常モードに戻す
      this.editorView.dispatch({
        effects: this.mainCompartment.reconfigure(
          this.createEditorExtensions(),
        ),
      });

      // ★修正: 元がライトモード（または半透明）だったなら、ダークモードを解除して元に戻す
      if (this.wasLightModeBeforeCode) {
        this.toggleDarkMode();
        this.wasLightModeBeforeCode = false; // リセット
      }
    }

    // Bodyクラスのトグル
    document.body.classList.toggle("code-mode", this.isCodeMode);
  }

  // --- 言語適用 (getLanguageSupport) ---
  private async getLanguageSupport() {
    let languageSupport;

    console.log(`Loading language support for: ${this.currentCodeLanguage}`);

    switch (this.currentCodeLanguage) {
      case "rust":
        const { rust } = await import("@codemirror/lang-rust");
        languageSupport = rust();
        break;
      case "python":
        const { python } = await import("@codemirror/lang-python");
        languageSupport = python();
        break;
      case "javascript":
      case "typescript":
        const { javascript } = await import("@codemirror/lang-javascript");
        // typescript: true にしておけばJSもTSも両方いける
        languageSupport = javascript({ typescript: true });
        break;
      case "markdown":
        const { markdown } = await import("@codemirror/lang-markdown");
        languageSupport = markdown();
        break;
      case "css":
        const { css } = await import("@codemirror/lang-css");
        languageSupport = css();
        break;
      case "html":
      default:
        const { html } = await import("@codemirror/lang-html");
        // 依存関係もロード
        await import("@codemirror/lang-css");
        await import("@codemirror/lang-javascript");
        languageSupport = html();
        break;
    }

    // ここで dispatch して適用する
    this.editorView.dispatch({
      effects: this.languageCompartment.reconfigure([languageSupport]),
    });
  }

  // スポットライト用のプラグイン定義
  private createSpotlightPlugin(isActive: boolean) {
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = this.getDecorations(view);
        }
        update(update: ViewUpdate) {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged
          ) {
            this.decorations = this.getDecorations(update.view);
          }
        }
        getDecorations(view: EditorView) {
          if (!isActive || view.state.doc.length === 0) {
            // 空のドキュメントなら何もしない
            return Decoration.none;
          }

          const builder = new RangeSetBuilder<Decoration>();
          const { from } = view.state.selection.main;
          const doc = view.state.doc;

          let startPos = 0;
          let endPos = doc.length;
          let currentLevel = 0;

          // カーソル位置から上に向かって最初の見出しを探す
          for (
            let line = doc.lineAt(from);
            line.number >= 1;
            line = doc.line(line.number - 1)
          ) {
            const match = line.text.match(/^(#+)\s/);
            if (match) {
              startPos = line.from;
              currentLevel = match[1].length;
              break;
            }
          }

          // 見つけた見出しから下に向かって、次の同レベル以上の見出しを探す
          for (let i = doc.lineAt(startPos).number + 1; i <= doc.lines; i++) {
            const line = doc.line(i);
            const match = line.text.match(/^(#+)\s/);
            if (match && match[1].length <= currentLevel) {
              endPos = line.from - 1; // その行の手前まで
              break;
            }
          }

          // 計算した範囲の「外側」をぼかす Decoration を作成
          if (startPos > 0) {
            builder.add(
              0,
              startPos - 1,
              Decoration.mark({ class: "cm-unfocused" }),
            );
          }
          if (endPos < doc.length) {
            builder.add(
              endPos + 1,
              doc.length,
              Decoration.mark({ class: "cm-unfocused" }),
            );
          }

          return builder.finish();
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    );
  }

  private defineThemesAndFonts() {
    const dark = "#333333",
      lightText = "#DDDDDD";
    this.lightTheme = EditorView.theme(
      {
        "&": {
          color: "var(--editor-text-color, #1e1e1e)",
          backgroundColor: "var(--editor-bg-color, transparent)",
          outline: "none !important",
          cursor: "text !important",
        },
        ".cm-content": {
          lineHeight: "var(--editor-line-height, 1.6)",
          lineBreak: "var(--editor-line-break, strict)",
          wordBreak: "var(--editor-word-break, break-all)",
          caretColor: "var(--editor-text-color, #1e1e1e) !important",
          caretWidth: "2px !important",
          cursor: "text !important",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--editor-text-color, #1e1e1e) !important",
          borderLeftWidth: "2px !important",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          {
            backgroundColor:
              "var(--editor-selection-color, rgba(100, 150, 250, 0.3)) !important",
          },
        "&.cm-focused .cm-activeLine": {
          backgroundColor: "transparent",
        },
        "&.cm-focused": {
          outline: "none !important",
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor:
            "var(--editor-selection-color, rgba(100, 150, 250, 0.3)) !important",
        },
        "& ::-webkit-scrollbar": {
          width: "18px",
        },
        "& ::-webkit-scrollbar-track": {
          backgroundColor: "transparent",
        },
        "& ::-webkit-scrollbar-thumb": {
          backgroundColor: "var(--scrollbar-color, rgba(0, 0, 0, 0.2))",
          borderRadius: "9px",
          border: "3px solid transparent",
          backgroundClip: "content-box",
          minHeight: "40px",
        },
        "& ::-webkit-scrollbar-thumb:hover": {
          backgroundColor: "var(--scrollbar-color, rgba(0, 0, 0, 0.4))",
        },
      },
      { dark: false },
    );
    this.darkTheme = EditorView.theme(
      {
        "&": {
          color: lightText,
          backgroundColor: dark,
          cursor: "text !important",
        },
        ".cm-content": {
          lineHeight: "var(--editor-line-height, 1.6)",
          lineBreak: "var(--editor-line-break, strict)",
          wordBreak: "var(--editor-word-break, break-all)",
          caretColor: lightText,
          cursor: "text !important",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: lightText,
        },
        "&.cm-focused .cm-activeLine": {
          backgroundColor: "transparent",
        },
        "&.cm-focused": {
          outline: "none",
        },
        "& ::-webkit-scrollbar": {
          width: "18px",
        },
        "& ::-webkit-scrollbar-track": {
          backgroundColor: "transparent",
        },
        "& ::-webkit-scrollbar-thumb": {
          backgroundColor: "rgba(255, 255, 255, 0.15)",
          borderRadius: "9px",
          border: "3px solid transparent",
          backgroundClip: "content-box",
          minHeight: "40px",
        },
        "& ::-webkit-scrollbar-thumb:hover": {
          backgroundColor: "rgba(255, 255, 255, 0.4)",
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: "rgba(100, 100, 100, 0.4) !important",
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "rgba(100, 100, 100, 0.4) !important",
        },
      },
      { dark: true },
    );
    this.dynamicFontTheme = EditorView.theme({
      ".cm-content": {
        // CSS変数を参照させる (!importantで強制)
        fontFamily: "var(--dynamic-editor-font) !important",
      },
    });
  }

  private lightHighlightStyle = HighlightStyle.define([
    {
      tag: tags.heading,
      color: "var(--heading-color, #0550AE)",
      fontWeight: "bold",
    }, //  GitHubの青
  ]);
  private darkHighlightStyle = HighlightStyle.define([
    { tag: tags.heading, color: "#82AAFF", fontWeight: "bold" }, //  明るい青
  ]);

  private createFontSizeTheme = (size: number) =>
    EditorView.theme({
      "&": { fontSize: `${size}pt` },
      ".cm-gutters": { fontSize: `${size}pt` },
    });

    /**
       * BGMデータを準備・ロードする（Win/Macのみ事前にHTML5 Audio要素を作成）
       */
      private async loadBGMData() {
        if (this.currentOs !== "linux") {
          this.stopBGM();
          try {
            // 再生すべきファイルのパスを決定する
            let targetPath = "";
            // ユーザー指定がある場合
            if (this.userBgmPath && this.userBgmPath.trim() !== "") {
              targetPath = this.userBgmPath;
            } else {
              // デフォルトの場合：リソースパスを解決する
              const { resolveResource } = await import("@tauri-apps/api/path");
              targetPath = await resolveResource("resources/bgm/marine_snow.ogg");
            }

            const { convertFileSrc } = await import("@tauri-apps/api/core");
            const audioUrl = convertFileSrc(targetPath);

            this.bgmElement = new Audio(audioUrl);
            this.bgmElement.loop = true;
            this.bgmElement.volume = 0.5;
          } catch (e) {
            console.error("Failed to load BGM data:", e);
          }
        }
      }

  // --- イベントリスナー ---
  private setupEventListeners() {
    this.fileListContainer?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // 閉じるボタンがクリックされた場合
      const pathToClose = target.dataset.pathToClose;
      if (target.classList.contains("close-tab-btn") && pathToClose) {
        e.stopPropagation(); // 親のfile-entryのクリックイベントを発火させない
        this.closeTab(pathToClose);
        return;
      }
      this.handleSidebarClick(e);
    });
    this.outlineControls?.addEventListener("click", (e) =>
      this.handleSidebarClick(e),
    );
    this.outlineControls2?.addEventListener("click", (e) =>
      this.handleSidebarClick(e),
    );
    this.outlineContainer?.addEventListener("click", (e) =>
      this.handleSidebarClick(e),
    );

    document.addEventListener("keydown", (e) => this.handleKeyDown(e), {
      capture: true,
    });
    // ボタンのイベントリスナー
    document
      .querySelector("#btn-save")
      ?.addEventListener("click", () => this.saveActiveFile());
    document
      .querySelector("#btn-save-as")
      ?.addEventListener("click", () => this.saveActiveFileAs());
    document
      .querySelector("#btn-open")
      ?.addEventListener("click", () => this.openNewFile());
    document
      .querySelector("#btn-new")
      ?.addEventListener("click", () => this.createNewTab());
    document.querySelector("#btn-undo")?.addEventListener("click", () => {
      undo(this.editorView);
      this.editorView.focus();
    });
    document.querySelector("#btn-redo")?.addEventListener("click", () => {
      redo(this.editorView);
      this.editorView.focus();
    });
    document
      .querySelector("#btn-toggle-theme")
      ?.addEventListener("click", () => this.toggleDarkMode());
    document
      .querySelector("#btn-zen-mode")
      ?.addEventListener("click", () => this.toggleZenMode());
    document
      .querySelector("#btn-fullscreen")
      ?.addEventListener("click", async () => {
        this.toggleFullscreen();
      });
    document
      .querySelector("#btn-minimize")
      ?.addEventListener("click", async () => {
        this.setMinimize();
      });
    document.querySelector("#btn-close")?.addEventListener("click", () => {
      this.handleCloseRequest();
    });
    listen("tauri://on-close-requested", () => {
      this.handleCloseRequest();
    });
    document
      .querySelector("#btn-bgm-toggle")
      ?.addEventListener("click", () => this.toggleBGM());
    document
      .querySelector("#btn-font-dec")
      ?.addEventListener("click", () =>
        this.changeFontSize(this.currentFontSize - 1),
      );
    document
      .querySelector("#btn-font-reset")
      ?.addEventListener("click", () => this.changeFontSize(15));
    document
      .querySelector("#btn-font-inc")
      ?.addEventListener("click", () =>
        this.changeFontSize(this.currentFontSize + 1),
      );
    document
      .querySelector("#btn-typesound")
      ?.addEventListener("click", () => this.toggleTypeSound());
    document
      .querySelector("#btn-spotlight")
      ?.addEventListener("click", () => this.toggleSpotlightMode());
    document
      .querySelector("#btn-settings")
      ?.addEventListener("click", () => this.openSettingsWindow());
    document.querySelector("#btn-preview")?.addEventListener("click", () => {
      this.openPreviewWindowWithCheck();
    });
    document
      .querySelector("#btn-export")
      ?.addEventListener("click", async () => {
        try {
          await invoke("open_export_window");
        } catch (e) {
          console.error(e);
          await message(translateRustError(e), { kind: "error" });
        }
      });
    document.querySelector("#btn-vivliostyle")?.addEventListener("click", () => {
      this.openVivliostyle();
    });
    document.querySelector("#btn-ai-chat")?.addEventListener("click", () => {
      this.openAiChat();
    });
    document.querySelector("#btn-code")?.addEventListener("click", () => {
      this.toggleCodeMode();
    });
    document.querySelector("#btn-markdown")?.addEventListener("click", () => {
      this.openMarkdownPreviewWithCheck();
    });
    document
      .querySelector("#btn-idea-processor")
      ?.addEventListener("click", () => {
        this.openIdeaProcessor();
      });

    // ルビ挿入ボタン
    document
      .getElementById("btn-insert-ruby")
      ?.addEventListener("click", () => {
        // CodeMirrorのエディタインスタンスがある前提 (this.editor)
        if (!this.editorView) return;

        const insertText = "｜《》";
        const transaction = this.editorView.state.update({
          changes: {
            from: this.editorView.state.selection.main.head,
            insert: insertText,
          },
          selection: {
            // カーソルを "｜" の後ろ ("《" の前) に置くなら +1
            anchor: this.editorView.state.selection.main.head + 1,
          },
        });

        this.editorView.dispatch(transaction);
        this.editorView.focus();
      });

    // ダッシュ挿入ボタン
    document
      .getElementById("btn-insert-dash")
      ?.addEventListener("click", () => {
        if (!this.editorView) return;
        const insertText = "――";
        const transaction = this.editorView.state.update({
          changes: {
            from: this.editorView.state.selection.main.head,
            insert: insertText,
          },
          selection: { anchor: this.editorView.state.selection.main.head + 2 },
        });
        this.editorView.dispatch(transaction);
        this.editorView.focus();
      });

    // 三点リーダ挿入ボタン
    document
      .getElementById("btn-insert-ellipsis")
      ?.addEventListener("click", () => {
        if (!this.editorView) return;
        const insertText = "……";
        const transaction = this.editorView.state.update({
          changes: {
            from: this.editorView.state.selection.main.head,
            insert: insertText,
          },
          selection: { anchor: this.editorView.state.selection.main.head + 2 },
        });
        this.editorView.dispatch(transaction);
        this.editorView.focus();
      });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        this.cycleTab("prev");
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        this.cycleTab("next");
      }
    });

    // ★ OSからのファイルオープン要求（2回目以降の起動）をリッスン
    listen<string>("open-file-from-os", (event) => {
      const filePath = event.payload;
      if (filePath) {
        this.openOrSwitchTab(filePath);
      }
    });

    this.editorContainer?.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const { Menu, MenuItem, PredefinedMenuItem, Submenu } =
        await import("@tauri-apps/api/menu");

      // 履歴からMenuItemの配列を動的に生成
      const recentFileItems = await Promise.all(
        this.recentFiles.map(async (filePath) => {
          // パスの最後の部分（ファイル名）をラベルにする
          const fileName = filePath.split(/[/\\]/).pop() || filePath;
          return await MenuItem.new({
            text: fileName,
            // クリックされたら、そのファイルを開く
            action: () => this.openOrSwitchTab(filePath),
          });
        }),
      );

      const hasSelection = !this.editorView.state.selection.main.empty;

      const menu = await Menu.new({
        items: [
          await Submenu.new({
            text: t("editor.menu.recentFiles"),
            enabled: recentFileItems.length > 0,
            items: recentFileItems,
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("editor.menu.open"),
            action: () => this.openNewFile(),
          }),
          await MenuItem.new({
            text: t("editor.menu.save"),
            action: () => this.saveActiveFile(),
          }),
          await MenuItem.new({
            text: t("editor.menu.saveAs"),
            action: () => this.saveActiveFileAs(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("editor.menu.undo"),
            action: () => undo(this.editorView),
          }),
          await MenuItem.new({
            text: t("editor.menu.redo"),
            action: () => redo(this.editorView),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await PredefinedMenuItem.new({ item: "Cut" }),
          await PredefinedMenuItem.new({ item: "Copy" }),
          await PredefinedMenuItem.new({ item: "Paste" }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await PredefinedMenuItem.new({ item: "SelectAll" }),
          await MenuItem.new({
            text: t("editor.menu.countChars"),
            enabled: hasSelection,
            action: () => this.showSelectionCount(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("editor.menu.aiTranslate"),
            enabled: hasSelection,
            action: () => this.runAiEdit("translate"),
          }),
          await MenuItem.new({
            text: t("editor.menu.aiSummarize"),
            enabled: hasSelection,
            action: () => this.runAiEdit("summary"),
          }),
          await MenuItem.new({
            text: t("editor.menu.aiRewrite"),
            enabled: hasSelection,
            action: () => this.runAiEdit("rewrite"),
          }),
          await MenuItem.new({
            text: t("editor.menu.aiGenerateSdPrompt"), // 「AI: SDプロンプトを作成」
            enabled: hasSelection,
            action: () => this.runAiEdit("sd_prompt"),
          }),
          await MenuItem.new({
            text: t("editor.menu.aiVisualize"),
            enabled: hasSelection,
            action: () => this.visualizeSelection(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("editor.menu.importGeminiLog"),
            action: () => this.importGeminiLog(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),

          // この場所でターミナルを開く
          await MenuItem.new({
            text: t("editor.menu.openTerminalHere"),
            action: async () => {
              this.openTerminalHere();
            },
          }),

          // この場所でフォルダを開く
          await MenuItem.new({
            text: t("editor.menu.openFolderHere"),
            enabled: !!this.activeTabPath, // ファイルを開いている時だけ有効
            action: async () => {
              this.openFolderHere();
            },
          }),
        ],
      });

      await menu.popup();
    });

    this.editorContainer?.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    // --- 3. Safari用：スクロールバー使用時のバグ対策 ---
    const isMac = this.currentOs === "macos";
    if (isMac && this.editorContainer) {
      // キャプチャフェーズ (true) で、CodeMirrorが処理するより先に介入する
      this.editorContainer.addEventListener(
        "mousedown",
        (e) => {
          // 左クリック以外、または Shiftキー押し(意図的な範囲選択) なら何もしない
          if (e.button !== 0 || e.shiftKey) return;
          if (!this.editorView) return;

          // 1. スクロールバー領域のクリックなら無視
          const scroller = this.editorView.scrollDOM;
          const rect = scroller.getBoundingClientRect();
          const scrollbarWidth = 18;
          const isOnVerticalScrollbar =
            e.clientX >= rect.right - scrollbarWidth;
          const isOnHorizontalScrollbar =
            e.clientY >= rect.bottom - scrollbarWidth;
          if (isOnVerticalScrollbar || isOnHorizontalScrollbar) return;

          // 2. ネイティブ機能でクリック位置を特定
          if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(e.clientX, e.clientY);

            if (
              range &&
              this.editorView.contentDOM.contains(range.startContainer)
            ) {
              const clickPos = this.editorView.posAtDOM(
                range.startContainer,
                range.startOffset,
              );

              if (clickPos !== null) {
                // Safariがバグる前に、CodeMirrorに正しいカーソル位置を強制セットする
                this.editorView.dispatch({
                  selection: { anchor: clickPos, head: clickPos },
                  scrollIntoView: false, // 勝手なスクロールを防ぐ
                  userEvent: "select.pointer",
                });

                // Safariが保持している「古い選択状態」を念のためクリア
                window.getSelection()?.removeAllRanges();
              }
            }
          }
        },
        true,
      );
    }
  }

  // --- イベントハンドラ ---

  private handleSidebarClick(e: MouseEvent) {
    const target = e.target as HTMLElement;

    // --- 1. ファイル名 (file-entry) がクリックされたか ---
    const fileEntryTarget = target.closest(".file-entry");
    if (fileEntryTarget) {
      // .file-entry要素からdata-pathを取得
      const path = (fileEntryTarget as HTMLElement).dataset.path;
      if (path) {
        this.openOrSwitchTab(path);
        // ファイル名をクリックした場合は、他の処理は不要なのでここで終了
        return;
      }
    }

    // --- 2. アウトラインのテキスト (outline-text) がクリックされたか ---
    const outlineTextTarget = target.closest(".outline-text");
    if (outlineTextTarget) {
      const posStr = (outlineTextTarget as HTMLElement).dataset.pos;
      if (posStr) {
        const pos = parseInt(posStr, 10);
        this.editorView.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        this.editorView.focus();

        // Markdownプレビューへのジャンプ命令
        // 50,000文字制限のチェック
        const limit = 50000;
        if (pos < limit) {
          // 見出しのテキストを取得
          const headingText =
            (outlineTextTarget as HTMLElement).textContent || "";
          // Emit
          emit("markdown-jump", headingText);
        } else {
          // 必要なら通知などを出す
          // console.log("Jump target is outside of preview limit.");
        }

        return;
      }
    }

    // --- 3. アウトラインの開閉ボタン (toggle-collapse) がクリックされたか ---
    const toggleCollapseTarget = target.closest(".toggle-collapse");
    if (toggleCollapseTarget) {
      const posStr = (toggleCollapseTarget as HTMLElement).dataset.pos;
      if (posStr) {
        const heading = this.activeFileHeadings.find(
          (h) => h.pos === parseInt(posStr, 10),
        );
        if (heading) {
          heading.isCollapsed = !heading.isCollapsed;
          this.renderSidebar();
        }
        return;
      }
    }

    // --- 4. 全開/全閉ボタン (IDで判断) ---
    if (target.id === "collapse-all-btn") {
      this.activeFileHeadings.forEach((h) => (h.isCollapsed = true));
      this.renderSidebar();
      return;
    }

    if (target.id === "expand-all-btn") {
      this.activeFileHeadings.forEach((h) => (h.isCollapsed = false));
      this.renderSidebar();
      return;
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    const isMac = navigator.userAgent.includes("Mac");
    const isCtrl = e.ctrlKey;
    const isCmd = e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    // AI動作中のガード
    if (this.isAiProcessing) {
      // Escapeキーが押されたら中断を実行
      if (e.key === "Escape") {
        this.abortAiProcessing();
      }
      // 他のすべてのキー操作（ショートカット含む）を無視して終了
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (isCtrlOrCmd && key === "s") {
      e.preventDefault();
      this.saveActiveFile();
    }
    if (isCtrlOrCmd && key === "t" && !isShift) {
      e.preventDefault();
      this.toggleDarkMode();
    }
    if (isCtrlOrCmd && isShift && key === "f") {
      e.preventDefault();
      this.cycleEditorFont();
      return; // 処理が重複しないように、ここで関数を抜ける
    }
    if (isCtrlOrCmd && (e.code === "Equal" || e.code === "NumpadAdd")) {
      e.preventDefault();
      this.changeFontSize(this.currentFontSize + 1);
    }
    if (isCtrlOrCmd && (e.code === "Minus" || e.code === "NumpadSubtract")) {
      e.preventDefault();
      this.changeFontSize(this.currentFontSize - 1);
    }
    if (isCtrlOrCmd && (e.code === "Digit0" || e.code === "Numpad0")) {
      e.preventDefault();
      this.changeFontSize(15);
    }
    if (isCtrlOrCmd && key === "q") {
      e.preventDefault();
      this.handleCloseRequest();
    }
    if (isCtrlOrCmd && key === "o" && !isShift) {
      e.preventDefault();
      this.openNewFile();
    }
    if (isCtrlOrCmd && key === "o" && isShift) {
      e.preventDefault();
      this.openFolderHere();
    }
    if (isCtrlOrCmd && key === "n") {
      e.preventDefault();
      this.createNewTab();
    }
    if (isCtrlOrCmd && e.key === "Tab") {
      e.preventDefault();
      this.cycleTab(e.shiftKey ? "prev" : "next");
    }

    // --- Mac専用フルスクリーン (Ctrl + Cmd + F) ---
    if (isMac && isCtrl && isCmd && key === "f") {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    // --- Windows/Linux用フルスクリーン (F11) ---
    if (!isMac && e.key === "F11") {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (isCtrlOrCmd && key === "h") {
      e.preventDefault();
      this.setMinimize();
      return;
    }
    if (isCtrlOrCmd && key === "p" && isShift) {
      e.preventDefault();
      this.toggleBGM();
    }
    if (isCtrlOrCmd && key === "r") {
      e.preventDefault();
    } // リロードを無効化
    if (isCtrlOrCmd && key === "r" && isShift) {
      e.preventDefault();
    }
    // タイプ音トグル (Ctrl + Shift + T)
    if (isCtrlOrCmd && isShift && key === "t") {
      e.preventDefault();
      this.toggleTypeSound();
    }
    // スポットライトモード (Ctrl + L)
    if (isCtrlOrCmd && key === "l") {
      e.preventDefault();
      this.toggleSpotlightMode();
    }
    // 降雪エフェクト (Ctrl + Shift + E)
    if (isCtrlOrCmd && isShift && key === "e") {
      e.preventDefault();
      this.toggleSnowEffect();
    }
    // ショートカット (F1)
    if (e.key === "F1") {
      e.preventDefault();
      e.stopPropagation();
      this.openShortcut();
    }
    // 設定 (F2)
    if (e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      this.openSettingsWindow();
    }
    // ZENモード (Ctrl + Shift + C)
    if (isCtrlOrCmd && isShift && key === "c") {
      e.preventDefault();
      e.stopPropagation();
      this.toggleZenMode();
    }
    if (isCtrlOrCmd && isShift && key === "a") {
      e.preventDefault();
      e.stopPropagation();
      this.openAiChat();
    }
    if (isCtrlOrCmd && key === "p" && !isShift) {
      e.preventDefault();
      this.openPreviewWindowWithCheck();
    }
    if (isCtrlOrCmd && key === "m" && !isShift) {
      e.preventDefault();
      this.openMarkdownPreviewWithCheck();
    }
    if (isCtrlOrCmd && key === "i" && !isShift) {
      e.preventDefault();
      this.openIdeaProcessor();
    }
    if (isCtrlOrCmd && key === "e" && !isShift) {
      e.preventDefault();
      invoke("open_export_window");
    }
    if (isCtrlOrCmd && key === "b" && isShift) {
      e.preventDefault();
      this.openVivliostyle();
    }
    if (isCtrlOrCmd && key === "k" && !isShift) {
      e.preventDefault();
      this.toggleCodeMode();
    }
    if (isCtrlOrCmd && key === "k" && isShift) {
      e.preventDefault();
      this.openOpenCode();
    }
    if (isCtrlOrCmd && key === "j" && isShift) {
      e.preventDefault();
      this.openSillyTavern();
    }
    if (isCtrlOrCmd && key === "w" && isShift) {
      e.preventDefault();
      this.openStableDiffusion();
    }
    if (
      (isCtrlOrCmd && key === "`" && !isShift) ||
      (isCtrlOrCmd && key === "@" && !isShift)
    ) {
      e.preventDefault();
      e.stopPropagation();
      invoke("open_terminal_window");
      return;
    }
    if (
      (isCtrlOrCmd && key === "`" && isShift) ||
      (isCtrlOrCmd && key === "@" && isShift)
    ) {
      e.preventDefault();
      this.openTerminalHere();
    }
    if (e.altKey && e.shiftKey && e.code === "KeyF") {
      if (!this.isCodeMode) return;
      e.preventDefault();
      this.formatCode();
      return;
    }
  }

  private onEditorUpdate(update: ViewUpdate) {
    // 1. isDirtyフラグの管理 (既存)
    if (update.docChanged) {
      const activeTab = this.openTabs.find(
        (t) => t.path === this.activeTabPath,
      );
      if (activeTab && !activeTab.isDirty) {
        activeTab.isDirty = true;
        this.renderSidebar();
      }
    }

    // 2. タイプ音の再生 (Electron版の移植)
    // トランザクションがあり、かつユーザー操作(userEvent)による変更である場合
    if (
      this.isTypeSoundEnabled &&
      update.transactions.some((tr) => tr.annotation(Transaction.userEvent))
    ) {
      // ドキュメント変更(入力/削除) または 選択範囲変更(カーソル移動) で鳴る
      // もし「文字入力/削除の時だけ」鳴らしたい場合は update.docChanged を条件に加える
      if (update.docChanged) {
        this.playTypeSound();
      }
    }

    // 3. ステータスバーとアウトラインの更新 (既存)
    if (update.docChanged || update.selectionSet) {
      this.updateStatusBar(update.view);
      this.parseHeadingsFromEditor(update.view).then(() => {
        this.renderSidebar();
      });
    }
  }

  /**
   * サイドバー全体（開いているファイル一覧 ＋ アクティブなファイルのアウトライン）を再描画する
   * この関数が、サイドバーの見た目に関する唯一の真実となる
   */
  private renderSidebar() {
    if (
      !this.fileListContainer ||
      !this.outlineContainer ||
      !this.outlineControls ||
      !this.outlineControls2
    )
      return;

    // --- 1. ファイル一覧部分のHTMLを生成 ---
    let fileListHtml = "<ul>";
    for (const tab of this.openTabs) {
      const isActive = tab.path === this.activeTabPath;
      const isDirty = tab.isDirty;
      const fileName = tab.path.split(/[/\\]/).pop();
      fileListHtml += `
      <li>
        <div class="file-entry ${isActive ? "active" : ""}" data-path="${tab.path}">
          <span class="file-entry-title">${fileName} ${isDirty ? "*" : ""}</span>
          <button class="close-tab-btn" data-path-to-close="${tab.path}"></button>
        </div>
      </li>`;
    }
    fileListHtml += "</ul>";
    this.fileListContainer.innerHTML = fileListHtml;

    this.outlineControls.style.display = "flex";
    this.outlineControls2.style.display = "flex";

    // --- 2. アウトライン部分のHTMLを生成 ---
    if (this.activeTabPath && this.activeFileHeadings.length > 0) {
      let outlineHtml = "<ul>";
      let hiddenLevels: number[] = [];
      for (let i = 0; i < this.activeFileHeadings.length; i++) {
        const h = this.activeFileHeadings[i];
        while (
          hiddenLevels.length > 0 &&
          h.level <= hiddenLevels[hiddenLevels.length - 1]
        )
          hiddenLevels.pop();
        if (hiddenLevels.length > 0) continue;
        if (h.isCollapsed) hiddenLevels.push(h.level);
        const safeTitle = h.text.replace(/"/g, "&quot;");
        const hasChildren =
          i + 1 < this.activeFileHeadings.length &&
          this.activeFileHeadings[i + 1].level > h.level;
        const toggleIcon = h.isCollapsed ? "▶" : "▼";
        outlineHtml += `<li class="outline-item outline-level-${h.level}">
            ${hasChildren ? `<button class="toggle-collapse" data-pos="${h.pos}">${toggleIcon}</button>` : `<span class="toggle-collapse"></span>`}
            <span class="outline-text" data-pos="${h.pos}" title="${safeTitle}">${h.text}</span>
        </li>`;
      }
      outlineHtml += "</ul>";
      this.outlineContainer.innerHTML = outlineHtml;
    } else {
      this.outlineContainer.innerHTML = "<ul></ul>";
    }
  }

  private async updateBackground() {
    const rootStyle = document.documentElement.style;
    if (this.isDarkMode) {
      rootStyle.setProperty("--app-bg-image", "none");
      return;
    }

    let imageUrl = "";
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    if (this.userBackgroundImagePath) {
      if (this.userBackgroundImagePath === "nothing") {
        rootStyle.setProperty("--app-bg-image", "none");
        return;
      } else {
        // ユーザー指定パスがあるなら convertFileSrc でURL化
        imageUrl = convertFileSrc(this.userBackgroundImagePath);
        console.log(
          "User background image path:",
          this.userBackgroundImagePath,
        );
      }
    } else {
      try {
        const { resolveResource } = await import("@tauri-apps/api/path");
        const resourcePath = await resolveResource(
          "resources/img/default_bg.jpg",
        );
        imageUrl = convertFileSrc(resourcePath);
      } catch (e) {
        console.error("Failed to load default background:", e);
      }
    }

    // CSS変数を更新
    rootStyle.setProperty("--app-bg-image", `url('${imageUrl}')`);
  }

  /**
   * ステータスバー全体を更新する
   */
  private updateStatusBar(view: EditorView) {
    // ★ this.statusBarのnullチェックは関数の冒頭で行う
    if (!this.statusBar) return;
    const viewToUpdate = view || this.editorView;
    if (!viewToUpdate) return;
    const tab = this.openTabs.find((t) => t.path === this.activeTabPath);

    // デフォルト値を設定
    let lineEnding = "";
    let encoding = "";
    let lineColText = "";
    let charCountText = "";
    let filePathText = "";
    let breadcrumbsText = "";

    if (tab) {
      lineEnding = tab.lineEnding;
      encoding = tab.encoding;
      filePathText = tab.path;

      const state = view.state;
      const cursor = state.selection.main.head;
      const line = state.doc.lineAt(cursor);

      lineColText = `${line.number}L:${cursor - line.from}C / ${state.doc.lines}L`;
      charCountText = `${state.doc.length}C`;

      // --- パンくずリストの生成ロジック ---
      if (this.activeFileHeadings.length > 0) {
        const currentLineNum = line.number;
        // スタックを使って階層を構築
        // 配列のインデックスをレベル(1-6)に見立てる
        const hierarchy: string[] = [];

        // アウトラインは上から順に並んでいるので、現在行より前にある見出しを走査
        for (const h of this.activeFileHeadings) {
          const headingLine = view.state.doc.lineAt(h.pos).number;

          if (headingLine > currentLineNum) break; // カーソルより下の見出しに来たら終了

          // 現在のレベルに上書き（同レベルの新しい見出しが来たら入れ替わる）
          // かつ、それより深いレベルはクリアする（親が変わったため）
          hierarchy[h.level] = h.text;
          hierarchy.splice(h.level + 1); // h.levelより後ろを削除
        }
        // 空の要素（レベル飛び）を除去して結合
        breadcrumbsText = hierarchy.filter((t) => t).join(" > ");
      }
    }

    // --- DOM更新ヘルパー関数 ---
    const setText = (selector: string, text: string, tooltip: string = "") => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.textContent = text;
        // tooltip引数があれば title 属性にセットする
        if (tooltip) {
          el.title = tooltip;
        } else {
          el.removeAttribute("title"); // ない場合は属性を消しておく
        }
      }
    };

    // 各要素の更新
    setText("#status-line-col", lineColText);
    setText("#status-char-count", charCountText);
    setText("#status-encoding", encoding);
    setText("#status-line-ending", lineEnding);

    // ★ 第3引数にフルパス/フルテキストを渡すことで、ホバー時に表示されるようになる
    setText("#status-filepath", filePathText, filePathText);
    setText("#status-breadcrumbs", breadcrumbsText, breadcrumbsText);
  }

  /**
   * ステータスバーの時刻だけを更新する
   */
  private updateStatusBarTimeOnly() {
    const timeEl = document.querySelector<HTMLElement>("#status-time");
    if (timeEl) {
      const now = new Date();
      // 日付 (Dec 21)
      const dateStr = now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      // 時刻 (14:30)
      const timeStr = now.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      });

      timeEl.textContent = `${dateStr} ${timeStr}`;
    }
  }

  // --- 機能メソッド ---
  private async saveSettings() {
    if (this.isLoading) return;
    // 1. 個別の設定値をルートに保存
    await this.store.set("isDarkMode", this.isDarkMode);
    await this.store.set("isZenMode", this.isZenMode);
    await this.store.set("currentFontIndex", this.currentFontIndex);
    await this.store.set("currentFontSize", this.currentFontSize);
    await this.store.set("isTypeSoundEnabled", this.isTypeSoundEnabled);
    await this.store.set("isSpotlightMode", this.isSpotlightMode);
    await this.store.set("editorMaxWidth", this.editorMaxWidth);
    await this.store.set("editorPaddingX", this.editorPaddingX);
    await this.store.set("editorLineHeight", this.editorLineHeight);
    await this.store.set("editorLineBreak", this.editorLineBreak);
    await this.store.set("editorWordBreak", this.editorWordBreak);
    await this.store.set("editorAlign", this.editorAlign);
    await this.store.set("editorBlur", this.editorBlur);
    await this.store.set("customTextColor", this.customTextColor);
    await this.store.set("customUiTextColor", this.customUiTextColor);
    await this.store.set("customEditorBg", this.customEditorBg);
    await this.store.set("customWindowBg", this.customWindowBg);
    await this.store.set("customSelectionColor", this.customSelectionColor);
    await this.store.set("customScrollbarColor", this.customScrollbarColor);
    await this.store.set("customHeadingColor", this.customHeadingColor);
    await this.store.set("enableGlow", this.enableGlow);
    await this.store.set("glowColor", this.glowColor);
    await this.store.set("glowRadius", this.glowRadius);
    await this.store.set("mdHardBreaks", this.mdHardBreaks);

    // 画像と音楽のパス (存在する場合のみ保存、あるいは空文字で保存)
    if (this.userBackgroundImagePath) {
      await this.store.set(
        "userBackgroundImagePath",
        this.userBackgroundImagePath,
      );
    }
    if (this.userBgmPath) {
      await this.store.set("userBgmPath", this.userBgmPath);
    }

    // ★ 2. セッションパスのフィルタリングと保存
    const sessionPaths = this.openTabs
      .map((t) => t.path)
      .filter((path) => !this.isVirtualPath(path));

    await this.store.set("sessionFilePaths", sessionPaths);

    // 3. 最後に保存実行
    await this.store.save();
  }

  private addToHistory(filePath: string) {
    if (this.isVirtualPath(filePath)) return;
    // 1. 既存の履歴から同じパスを削除
    this.recentFiles = this.recentFiles.filter((p) => p !== filePath);
    // 2. 配列の先頭に新しいパスを追加
    this.recentFiles.unshift(filePath);
    // 3. 履歴を10件に制限
    if (this.recentFiles.length > 10) {
      this.recentFiles.pop();
    }
    // 4. 変更を保存
    this.saveSettings();
  }

  private toggleDarkMode() {
    if (this.isCodeMode) return;
    this.isDarkMode = !this.isDarkMode;
    this.editorView.dispatch({
      effects: this.mainCompartment.reconfigure(this.createEditorExtensions()),
    });
    document.body.classList.toggle("dark-mode", this.isDarkMode);
    this.updateBackground();
    this.saveSettings();
    this.updateGlowEffect();
    emit("preview-update-data", { isDarkMode: this.isDarkMode });
    emit("app:theme-changed", { isDarkMode: this.isDarkMode });
  }

  private async sendDataToPreview(truncate: boolean = false) {
    // エディタの内容などを取得
    let text = this.editorView.state.doc.toString();
    let cursorLine = 1;
    const limit = 50000;
    if (truncate && text.length > limit) {
      text = text.substring(0, limit) + "\n\n" + t("editor.preview.truncated");
    } else {
      cursorLine = this.getCursorLineSafe();
    }

    // 現在のフォント設定を取得
    const fontFamilyVal =
      this.userFontFamily && this.userFontFamily !== "default"
        ? `"${this.userFontFamily}"`
        : this.currentFontIndex === 0
          ? "serif"
          : this.currentFontIndex === 1
            ? "sans-serif"
            : "monospace";
    // ※簡易的にCSSの総称フォントファミリーを送るか、
    // 厳密にやるなら fontList[this.currentFontIndex] の中身を送る

    // 現在のフォントサイズと行間を取得
    const fontSizeVal = `${this.currentFontSize}pt`;
    const lineHeightVal = this.editorLineHeight.toString();

    // 送信
    await emit("preview-update-data", {
      text,
      isDarkMode: this.isDarkMode,
      cursorLine,
      fontFamily: fontFamilyVal,
      fontSize: fontSizeVal,
      lineHeight: lineHeightVal,
    });
  }

  private async openPreviewWindowWithCheck() {
    const textLength = this.editorView.state.doc.length;
    const limit = 50000;
    let shouldTruncate = false;

    // 巨大ファイルチェック
    if (textLength > limit) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const confirmed = await ask(
        t("editor.preview.longTextWarning", {
          charCount: textLength,
          limit: limit,
        }),
        {
          title: t("editor.preview.confirmTitle"),
          kind: "warning",
          okLabel: t("editor.preview.okLabel"),
          cancelLabel: t("editor.preview.cancelLabel"),
        },
      );

      if (!confirmed) return;

      shouldTruncate = true;
    }

    // ウィンドウを開く
    try {
      await invoke("open_preview_window");
    } catch (e) {
      console.error(e);
      await message(translateRustError(e), { kind: "error" });
      return;
    }

    // データを送る (ウィンドウの準備待ち時間を少し入れる)
    setTimeout(() => this.sendDataToPreview(shouldTruncate), 200);
  }

  private async openMarkdownPreviewWithCheck() {
    if (!this.isFullFeatureAvailable) return;
    const textLength = this.editorView.state.doc.length;
    const limit = 50000;
    let shouldTruncate = false;

    // 巨大ファイルチェック
    if (textLength > limit) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const confirmed = await ask(
        t("editor.preview.longTextWarning", {
          charCount: textLength,
          limit: limit,
        }),
        {
          title: t("editor.preview.confirmTitleMd"),
          kind: "warning",
          okLabel: t("editor.preview.okLabel"),
          cancelLabel: t("editor.preview.cancelLabel"),
        },
      );
      if (!confirmed) return;
      shouldTruncate = true;
    }

    // Rust側でウィンドウ作成 (visible: false)
    try {
      await invoke("open_markdown_preview");
    } catch (e) {
      console.error(e);
      await message(translateRustError(e), { kind: "error" });
      return;
    }

    // ウィンドウのロード待ちをしてからデータを送る
    setTimeout(() => this.sendDataToMarkdownPreview(shouldTruncate), 200);
  }

  private async sendDataToMarkdownPreview(truncate: boolean = false) {
    const state = this.editorView.state;
    let text = state.doc.toString();
    const limit = 50000;

    if (truncate && text.length > limit) {
      text =
        text.substring(0, limit) + "\n\n" + t("editor.preview.truncatedLong");
    }

    // アクティブなファイルパスを送る
    const filePath = this.activeTabPath || "Untitled";

    await emit("markdown-update", {
      text: text,
      isDarkMode: this.isDarkMode,
      filePath: filePath,
      mdHardBreaks: this.mdHardBreaks,
    });
  }

  // トグル関数
  private toggleSpotlightMode() {
    if (!this.isFullFeatureAvailable) return;
    if (this.isCodeMode) return;
    if (this.isSpotlightMode) {
      this.isSpotlightMode = false;
    } else {
      this.isSpotlightMode = true;
    }
    // ボタンの見た目を変える処理
    const btn = document.querySelector("#btn-spotlight") as HTMLElement;
    if (this.isSpotlightMode) {
      btn.classList.add("enabled");
    } else {
      btn.classList.remove("enabled");
    }

    this.editorView.dispatch({
      effects: this.mainCompartment.reconfigure(this.createEditorExtensions()),
    });
    this.saveSettings();
  }

  private cycleEditorFont() {
    if (this.isCodeMode) return;
    this.userFontFamily = "default";
    this.currentFontIndex = (this.currentFontIndex + 1) % this.fontList.length;
    this.updateFontSettings();
    this.saveSettings();
  }

  private changeFontSize(newSize: number) {
    if (this.isCodeMode) return;
    if (newSize < 8 || newSize > 72) return;
    this.currentFontSize = newSize;
    this.editorView.dispatch({
      effects: this.mainCompartment.reconfigure(
        this.isCodeMode
          ? this.createCodeExtensions()
          : this.createEditorExtensions(),
      ),
    });
    this.saveSettings();
    emit("preview-update-data", {
      fontSize: `${newSize}pt`,
    });
  }

  /**
   * BGMの再生/停止切り替え
   */
  private async toggleBGM() {
    const bgmButton = document.querySelector("#btn-bgm-toggle");

    if (this.isBgmPlaying) {
      await this.stopBGM();
      this.isBgmPlaying = false;
      if (bgmButton) bgmButton.classList.remove("playing");
    } else {
      document.body.style.cursor = "wait";
      await this.playBGM();
      document.body.style.cursor = "default";

      this.isBgmPlaying = true;
      if (bgmButton) bgmButton.classList.add("playing");
    }
  }

  /**
   * 実際の再生処理
   */
  private async playBGM() {
    if (this.currentOs === "linux") {
      // ⚠️ Linux用: Rustバックエンド (rodio) で再生
      try {
        let targetPath = "";
        if (this.userBgmPath && this.userBgmPath.trim() !== "") {
          targetPath = this.userBgmPath;
        } else {
          const { resolveResource } = await import("@tauri-apps/api/path");
          targetPath = await resolveResource("resources/bgm/marine_snow.ogg");
        }

        await invoke("play_bgm_rust", { path: targetPath });
      } catch (e) {
        console.error("Linux Rust BGM play failed:", e);
      }
    } else {
      // Win/Mac用 (HTML5 Audio 処理)
      if (!this.bgmElement) {
        await this.loadBGMData();
      }
      if (this.bgmElement) {
        this.bgmElement.volume = 0.5;
        this.bgmElement.play().catch((e) => console.error("BGM play failed:", e));
      }
    }
  }

  /**
   * 実際の停止処理
   */
  private async stopBGM() {
    if (this.currentOs === "linux") {
      // ⚠️ Linux用: Rust側のBGM停止コマンド
      try {
        await invoke("stop_bgm_rust");
      } catch (e) {
        console.error("Linux Rust BGM stop failed:", e);
      }
    } else {
      // Win/Mac用
      if (this.bgmElement) {
        this.bgmElement.pause();
      }
    }
  }

  private async initializeTypeSound() {
    try {
      // Web Audio APIのコンテキスト作成
      this.audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const { TYPE_SOUND_BASE64 } = await import("./assets/type-sound");

      // ★ Electron版と同様に、メタデータを付与してからBase64部分を取得する
      const fullBase64String = `data:audio/wav;base64,${TYPE_SOUND_BASE64}`;
      const base64Data = fullBase64String.split(",")[1];
      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 音声データをデコード
      this.typeSoundBuffer = await this.audioContext.decodeAudioData(
        bytes.buffer,
      );
    } catch (e) {
      console.error("Failed to load type sound", e);
    }
  }

  // 音を鳴らす関数
  private playTypeSound() {
    if (!this.isFullFeatureAvailable) return;
    if (!this.isTypeSoundEnabled || !this.audioContext || !this.typeSoundBuffer)
      return;

    // コンテキストがサスペンド状態なら、再開させる
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = this.typeSoundBuffer;

    // ★ボリューム調整用のノードを作成
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 0.1;

    // ソース -> ゲイン -> 出力 という経路で繋ぐ
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    source.start(0);
  }

  private async toggleTypeSound() {
    if (!this.isFullFeatureAvailable) return;
    if (this.isTypeSoundEnabled) {
      this.isTypeSoundEnabled = false;
    } else {
      this.isTypeSoundEnabled = true;
    }

    // ★ 有効化されたタイミングで、まだロードされていなければロードする
    if (this.isTypeSoundEnabled && !this.typeSoundBuffer) {
      await this.initializeTypeSound();
    }

    // UI反映 & 保存
    const btn = document.querySelector("#btn-typesound") as HTMLElement;
    if (this.isTypeSoundEnabled) {
      btn.classList.add("enabled");
    } else {
      btn.classList.remove("enabled");
    }

    // AudioContextの再開処理
    if (this.isTypeSoundEnabled && this.audioContext?.state === "suspended") {
      this.audioContext.resume();
    }

    this.saveSettings();
  }

  private async toggleFullscreen() {
    const appcontainer = document.querySelector(
      "#app-container",
    ) as HTMLElement;
    this.isSimpleFullscreen = !this.isSimpleFullscreen;
    await invoke("set_simple_fullscreen", { enable: this.isSimpleFullscreen });
    if (this.currentOs !== "macos" && appcontainer) {
      appcontainer.style.borderRadius = this.isSimpleFullscreen ? "0px" : "6px";
    }
  }

  private async setMinimize() {
    const window = getCurrentWindow();
    window.minimize();
  }

  private async handleCloseRequest() {
    const dirtyTabs = this.openTabs.filter((tab) => tab.isDirty);
    let shouldClose = true;

    if (dirtyTabs.length > 0) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      shouldClose = await ask(
        t("editor.app.unsavedFiles", { count: dirtyTabs.length }),
        { title: t("editor.app.appExitTitle"), kind: "warning" },
      );
    }

    if (shouldClose) {
      // 終了前にフルスクリーンを解除する
      const window = getCurrentWindow();
      if (await window.isFullscreen()) {
        await window.setFullscreen(false);
      }
      if (this.wasLightModeBeforeCode) {
        this.isDarkMode = false;
      }
      await this.saveSettings();
      await invoke("force_close_app");
    }
  }

  private async saveActiveFile() {
    if (!this.activeTabPath) return;

    if (this.isVirtualPath(this.activeTabPath)) {
      await this.saveActiveFileAs();
      return;
    }

    const activeTab = this.openTabs.find((t) => t.path === this.activeTabPath);
    if (!activeTab) return;

    try {
      const content = this.editorView.state.doc.toString();
      await invoke("write_file", {
        path: activeTab.path,
        content,
        encoding: activeTab.encoding,
      });
      await this.parseHeadingsFromEditor(this.editorView);
      activeTab.isDirty = false;
      this.renderSidebar(); // isDirty表示(*)を消すために再描画
      console.log(`File saved: ${activeTab.path}`);
      this.updatePreviewsOnSave();
    } catch (error) {
      console.error(`Failed to save file: ${activeTab.path}`, error);
      alert(t("editor.app.saveFailed", { error: translateRustError(error) }));
    }
  }

  private async saveActiveFileAs() {
    if (!this.activeTabPath) return;

    const activeTab = this.openTabs.find((t) => t.path === this.activeTabPath);
    if (!activeTab) return;

    const content = this.editorView.state.doc.toString();

    try {
      // 1. フロントエンドで「保存ダイアログ」を開く
      // 現在のパスを取得
      const currentName = this.activeTabPath.split(/[/\\]/).pop() || "Untitled";
      // 拡張子が付いていない場合は .txt を足して提案する
      const defaultName = currentName.includes(".")
        ? currentName
        : `${currentName}.txt`;

      const newPath = await save({
        title: t("editor.app.saveAs"),
        defaultPath: defaultName,
        filters: [{ name: "Text Document", extensions: ["txt", "md"] }],
      });

      // キャンセルされた場合は何もしない
      if (!newPath) return;

      // 2. 既存の write_file コマンドを使って、新しいパスに保存
      // エンコーディングは元のタブの設定を引き継ぐ
      await invoke("write_file", {
        path: newPath,
        content,
        encoding: activeTab.encoding,
      });

      // 3. タブの状態を更新

      // 元が "Untitled" だった場合などは履歴から消すなどの処理もここで行えるが、
      // 単純に現在のタブのパスを書き換えるのが最も直感的

      // パスを更新
      activeTab.path = newPath;
      this.activeTabPath = newPath;

      // 保存済み状態にする
      activeTab.isDirty = false;

      // 履歴に追加（新しいパスとして）
      this.addToHistory(newPath);

      // 4. UI更新
      await this.parseHeadingsFromEditor(this.editorView); // アウトライン更新
      this.renderSidebar(); // ファイル名変更を反映
      await this.saveSettings(); // 状態保存

      console.log(`File saved as: ${newPath}`);
      this.updatePreviewsOnSave();
    } catch (error) {
      console.error(`Failed to save file as:`, error);
      await message(
        t("editor.app.saveFailed", { error: translateRustError(error) }),
        { kind: "error" },
      );
    }
  }

  // プレビュー更新用のヘルパーメソッド
  private updatePreviewsOnSave() {
    const textLength = this.editorView.state.doc.length;
    const limit = 50000;
    const shouldTruncate = textLength > limit;

    // マークダウンプレビューへ送信（開いていなければ無視される）
    this.sendDataToMarkdownPreview(shouldTruncate);

    // 縦書きプレビューへ送信（開いていなければ無視される）
    this.sendDataToPreview(shouldTruncate);
  }

  private async openNewFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filePath = await open({
      multiple: false,
      // filters: [{
      //   name: 'Text Files',
      //   extensions: ['md', 'txt']
      // }]
    });
    if (typeof filePath === "string") {
      await this.openOrSwitchTab(filePath);
    }
  }

  private createNewTab(baseName: string = "Untitled") {
    // 1. 重複しない名前（仮想パス）を生成
    let newFilePath = baseName;
    let counter = 2;
    // 既に同じ名前のタブが開いている間は番号を増やす
    while (this.openTabs.some((tab) => tab.path === newFilePath)) {
      newFilePath = `${baseName} (${counter})`;
      counter++;
    }

    const initialExtensions = this.isCodeMode
      ? this.createCodeExtensions()
      : this.createEditorExtensions();

    const state = EditorState.create({
      extensions: this.mainCompartment.of(initialExtensions),
    });

    const tab: OpenTab = {
      path: newFilePath, // ここに "Untitled (2)" や "From IP" が入る
      state,
      isDirty: false,
      encoding: "UTF-8",
      lineEnding: "LF",
      headings: [],
    };

    this.openTabs.push(tab);
    this.openOrSwitchTab(newFilePath);
  }

  // --- 仮想ファイル（保存ダイアログが必要なファイル）かどうかを判定 ---
  private isVirtualPath(path: string | null): boolean {
    if (!path) return true;
    // 1. スラッシュやバックスラッシュを含まない（＝ディレクトリ構造がない）
    // 2. 且つ、Untitled や From IP で始まる
    const isNamedVirtual =
      path.startsWith("Untitled") || path.startsWith("From IP");
    const hasNoSeparator = !path.includes("/") && !path.includes("\\");

    return isNamedVirtual && hasNoSeparator;
  }

  // コンテンツを指定して新しいタブを開く
  private createNewTabWithContent(title: string, content: string) {
    const initialExtensions = this.isCodeMode
      ? this.createCodeExtensions()
      : this.createEditorExtensions();

    const state = EditorState.create({
      doc: content,
      extensions: this.mainCompartment.of(initialExtensions),
    });

    const tab: OpenTab = {
      path: title, // 保存前なので、これを仮のファイル名/IDとして扱う
      state,
      isDirty: true, // 新規作成かつ内容があるので保存が必要
      encoding: "UTF-8",
      lineEnding: "LF",
      headings: [], // 初期は空。後でupdateHeadings()が走れば更新されるはず
    };

    this.openTabs.push(tab);
    this.openOrSwitchTab(title); // タブを切り替え

    // もし見出し更新用のメソッドがあればここで呼ぶと親切
    // this.updateHeadings();
  }

  // Geminiログのインポート機能
  private async importGeminiLog() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "Import Gemini Log",
      });

      if (!selected || typeof selected !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");

      const fileContent = await readTextFile(selected);
      const history = this.parseGeminiLog(fileContent);

      // テキスト形式に変換
      const textContent = history
        .map((m) => `■ ${m.role === "user" ? "User" : "AI"}\n\n${m.content}`)
        .join("\n\n---\n\n");

      // ファイル名生成 (パスからファイル名を取得 + .txt)
      // Windows/Mac両対応のため簡易的にセパレータで分割
      const fileName = selected.split(/[/\\]/).pop() + ".txt";

      this.createNewTabWithContent(fileName, textContent);
    } catch (e: any) {
      console.error("Gemini Import Error:", e);
      // エラー表示
      await message(t("editor.app.geminiImportFailed", { error: String(e) }), {
        kind: "error",
      });
    }
  }

  // Geminiログパーサー
  private parseGeminiLog(
    jsonString: string,
  ): { role: string; content: string }[] {
    const data = JSON.parse(jsonString);

    if (
      data.chunkedPrompt?.chunks &&
      Array.isArray(data.chunkedPrompt.chunks)
    ) {
      return data.chunkedPrompt.chunks
        .filter((chunk: any) => !chunk.isThought && chunk.text)
        .map((chunk: any) => ({
          role: chunk.role === "model" ? "assistant" : "user",
          content: (chunk.text as string).trim(),
        }));
    } else {
      throw new Error("Unsupported Gemini log format.");
    }
  }

  private async closeTab(filePathToClose: string) {
    const tabToClose = this.openTabs.find((t) => t.path === filePathToClose);
    if (!tabToClose) return;

    // もしファイルが未保存なら、確認ダイアログを出す
    if (tabToClose.isDirty) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const confirmed = await ask(
        t("editor.app.closeTabUnsaved", {
          filename: tabToClose.path.split(/[/\\]/).pop() || "",
        }),
        { title: t("editor.app.closeTab"), kind: "warning" },
      );
      if (!confirmed) {
        return;
      }
    }

    const index = this.openTabs.findIndex((t) => t.path === filePathToClose);
    if (index > -1) {
      this.openTabs.splice(index, 1);

      // もし閉じたのがアクティブなタブだった場合
      if (this.activeTabPath === filePathToClose) {
        if (this.openTabs.length === 0) {
          // すべてのタブが閉じられた場合
          this.activeTabPath = null;
          this.createNewTab();
          return;
        } else {
          // 隣のタブ (左隣を優先) をアクティブにする
          const nextIndex = Math.max(0, index - 1);
          await this.openOrSwitchTab(this.openTabs[nextIndex].path);
        }
      }

      // UIを更新して設定を保存
      this.renderSidebar();
      await this.saveSettings();
    }
  }

  /** タブを循環させる */
  private cycleTab(direction: "next" | "prev") {
    if (this.openTabs.length <= 1) return;

    const currentIndex = this.openTabs.findIndex(
      (t) => t.path === this.activeTabPath,
    );
    if (currentIndex === -1) return;

    let nextIndex;
    if (direction === "next") {
      nextIndex = (currentIndex + 1) % this.openTabs.length;
    } else {
      nextIndex =
        (currentIndex - 1 + this.openTabs.length) % this.openTabs.length;
    }

    this.openOrSwitchTab(this.openTabs[nextIndex].path);
  }

  private async openSettingsWindow() {
    await invoke("open_settings_window");
  }

  private async openAiChat() {
    await invoke("open_ai_chat");
  }

  private async openShortcut() {
    await invoke("open_shortcut");
  }

  private async openVivliostyle() {
    await invoke("open_vivliostyle");
  }

  private async openIdeaProcessor() {
    console.log("openIdeaProcessor");
    await invoke("open_idea_processor");
  }

  private async openOpenCode() {
    // Linuxでの運用を試験的に開始
    // if (this.currentOs === 'linux') return;
    try {
      if (this.currentOs === "linux") {
        const runCmd = `opencode serve --port 4096`; //  \nはつけない
        // OpenCodeは通常PATHが通っているのでCWD指定は不要（またはプロジェクトルート等）
        await this.store.set(`terminalAutoRunCommand_oc`, runCmd);
        await this.store.save();

        await invoke("open_terminal_window", { id: "oc" });
        // ポート 4096 を監視してブラウザを開かせる
        await invoke("start_port_monitor", {
          port: 4096,
          url: "http://127.0.0.1:4096",
        });
        return;
      }

      await invoke("open_opencode");
    } catch (e) {
      console.error(e);
    }
  }

  private async openSillyTavern() {
    // Linuxでの運用を試験的に開始
    // if (this.currentOs === 'linux') return;

    // 起動中なら一瞬だけオーバーレイを出して、あとは Rust に任せる
    this.aiThinkingMode = "Starting SillyTavern...";
    this.setAiLoading(true);
    // 2秒でオーバーレイを消して操作可能にする
    setTimeout(() => this.setAiLoading(false), 2000);

    try {
      const stPath = await this.store.get<string>("sillyTavernPath");
      const enableStTerminal =
        (await this.store.get<boolean>("enableStTerminal")) ?? false;

      if (this.currentOs === "linux") {
        if (!stPath) return;

        const runCmd = `node server.js`; //  \nはつけない
        await this.store.set("terminalTempCwd_st", stPath);
        await this.store.set("terminalAutoRunCommand_st", runCmd);
        await this.store.save();

        await invoke("open_terminal_window", { id: "st" });
        // LinuxはMirrorShard側では開かない（SillyTavern本体の自動起動に任せる）
        // await invoke('start_port_monitor', { port: 8000, url: 'http://127.0.0.1:8000' });
        return;
      }

      await invoke("open_silly_tavern", {
        stPathSetting: stPath || null,
        enableStTerminal: enableStTerminal,
      });
      // 結果待ちは不要（Rust側でスレッドが回るため）
    } catch (e) {
      this.setAiLoading(false);
      await message(t("editor.app.sillytavernFailed", { error: String(e) }), {
        kind: "error",
      });
    }
  }

  private async openStableDiffusion() {
    // Linuxでの運用を試験的に開始
    // if (this.currentOs === 'linux') return;

    const fullPath = (await this.store.get<string>("sdWebUIPath")) || "";
    const isCppMode =
      fullPath.toLowerCase().endsWith("sd-cli.exe") ||
      fullPath.toLowerCase().endsWith("sd-cli");
    const isCppServer =
      fullPath.toLowerCase().endsWith("sd-server.exe") ||
      fullPath.toLowerCase().endsWith("sd-server");
    if (!fullPath) return;
    if (isCppMode) {
      alert(t("editor.app.cppModeError"));
      return;
    }

    if (isCppServer) {
      this.aiThinkingMode = "Starting sd-server...";
      this.setAiLoading(true);
      setTimeout(() => this.setAiLoading(false), 2000);

      try {
        const resolution =
          (await this.store.get<string>("sdResolution")) || "512x512";
        await invoke("open_sd_server", {
          exePath: fullPath,
          modelPath: (await this.store.get("sdModelPath")) || "",
          // 初期プロンプトを入れたい場合は設定から。不要なら空文字でOK
          prompt: (await this.store.get("imageSystemPrompt")) || "",
          negPrompt: (await this.store.get("sdNegativePrompt")) || "",
          steps: Number(await this.store.get("sdSteps")) || 20,
          cfg: Number(await this.store.get("sdCfgScale")) || 7.0,
          sampler: (await this.store.get("sdSampler")) || "euler_a",
          scheduler: (await this.store.get("sdScheduler")) || "default",
          resolution: resolution,
        });
      } catch (e) {
        console.error(e);
        await message(`Failed to start sd-server: ${e}`, { kind: "error" });
      }
      return;
    }

    this.aiThinkingMode = "Starting Stable Diffusion...";
    this.setAiLoading(true);
    setTimeout(() => this.setAiLoading(false), 2500);

    const separator = fullPath.includes("/") ? "/" : "\\";
    const lastIndex = fullPath.lastIndexOf(separator);
    const sdDir = fullPath.substring(0, lastIndex);
    const scriptFile = fullPath.substring(lastIndex + 1);

    try {
      if (this.currentOs === "windows") {
        // Windows: エクスプローラー丸投げ方式（uvエラー対策）
        await invoke("launch_stable_diffusion_external", { sdPath: sdDir });
      } else {
        // macOS: 内蔵ターミナル方式（ログ可視化）
        const sdSessionId = "sd";
        // 末尾の \n を削除（terminal.ts で付与するため）
        const runCmd = `export SD_WEBUI_RESTARTING=1 && ./"${scriptFile}" --api`;

        await this.store.set(`terminalTempCwd_${sdSessionId}`, sdDir);
        await this.store.set(`terminalAutoRunCommand_${sdSessionId}`, runCmd);
        await this.store.save();

        // ID: "sd" でターミナルを開く
        await invoke("open_terminal_window", { id: "sd" });
      }

      // 共通：ポート監視を開始して、準備ができたら自前窓でUIを表示
      invoke("start_port_monitor", {
        port: 7860,
        url: "http://127.0.0.1:7860",
      });
    } catch (e) {
      console.error("SD Launch Error:", e);
      this.setAiLoading(false);
    }
  }

  // Linux(Niri)専用のエディタサイズ指定
  private async applyMainWindowSizePreset() {
      // Linux以外は即リターン
      if (this.currentOs !== "linux") return;

      // ⚠️ ピンポイントガード: Niri環境以外（GNOME, KDE等）は即リターンして安全を保証
      const isNiri = await invoke<boolean>("is_niri_compositor");
      if (!isNiri) return;

      const preset = (await this.store.get<string>("mainEditorSizePreset")) ?? "default";
      if (preset === "default") return;

      try {
        // Rust経由で Niri IPC を直接叩いて幅と高さを反映させる
        await invoke("apply_niri_size_preset", { preset });
      } catch (e) {
        console.error("Niriサイズプリセットの適用に失敗しました:", e);
      }
    }

  /**
   * エディタから見出しを解析する
   */
  private parseHeadingsFromEditor(view: EditorView): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.time("Outline Parsing (Line by Line)");
        const newHeadings: Heading[] = [];
        const doc = view.state.doc;

        // ★ doc.linesを使って、ドキュメントの全行をループ処理
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          // ★ オリジナルと同じ正規表現
          const match = line.text.match(/^(#+)\s(.*)/);

          if (match) {
            const level = match[1].length;
            const text = match[2].trim();

            if (text) {
              newHeadings.push({
                level,
                text,
                pos: line.from, // 行の開始位置
                isCollapsed: false, // とりあえずデフォルトはfalse
              });
            }
          }
        }

        // 既存の折りたたみ状態を引き継ぐ (パフォーマンスのため)
        this.activeFileHeadings.forEach((oldHeading) => {
          if (oldHeading.isCollapsed) {
            const newHeading = newHeadings.find(
              (h) => h.pos === oldHeading.pos && h.text === oldHeading.text,
            );
            if (newHeading) {
              newHeading.isCollapsed = true;
            }
          }
        });

        this.activeFileHeadings = newHeadings;
        console.timeEnd("Outline Parsing (Line by Line)");
        resolve();
      }, 50);
    });
  }

  private async openOrSwitchTab(filePath: string) {
    // すでにアクティブなら何もしない
    if (this.activeTabPath === filePath) {
      this.editorView.focus();
      return;
    }
    // 切り替える「前」に、現在のアウトラインの状態を保存
    const previousTab = this.openTabs.find(
      (t) => t.path === this.activeTabPath,
    );
    if (previousTab) {
      previousTab.state = this.editorView.state;
      previousTab.headings = this.activeFileHeadings;
    }

    // 1. 既存のタブを探す
    let tab = this.openTabs.find((t) => t.path === filePath);

    if (!tab) {
      try {
        // ★ 新しいread_fileを呼び出し、返り値の型が変わる
        const fileData = (await invoke("read_file", { path: filePath })) as {
          content: string;
          encoding: string;
          lineEnding: "LF" | "CRLF";
        };

        const state = EditorState.create({
          doc: fileData.content,
          extensions: this.mainCompartment.of(this.createEditorExtensions()),
        });

        tab = {
          path: filePath,
          state,
          isDirty: false,
          encoding: fileData.encoding, // エンコーディングを保存
          lineEnding: fileData.lineEnding, // 改行コードを保存
          headings: [],
        };
        this.openTabs.push(tab);
        this.addToHistory(filePath);
      } catch (error) {
        console.error(
          `[openOrSwitchTab] Failed to open file: ${filePath}`,
          error,
        );
        const errStr = String(error);
        let msgTitle = t("editor.errors.loadError");
        let msgBody = t("editor.errors.loadFailed", { detail: errStr });

        if (errStr.includes("No such file") || errStr.includes("os error 2")) {
          msgTitle = t("editor.errors.fileNotFound");
          msgBody = t("editor.errors.fileNotFoundDetail", { path: filePath });
        } else {
          msgBody = t("editor.errors.encodingError", { detail: errStr });
        }

        await message(msgBody, { title: msgTitle, kind: "error" });
        return;
      }
    }

    // 3. 状態を更新
    this.activeTabPath = filePath;

    // 4. 最新設定が適用されたStateをビューにセット
    this.editorView.setState(tab.state);

    // モードに関わらず、拡張子から言語を判定して「予約」しておく
    const detectedLang = this.detectLanguageFromExtension(filePath);
    if (detectedLang) {
      this.currentCodeLanguage = detectedLang;
      // console.log(`Auto-detected language: ${detectedLang}`);
    }

    // モードの同期処理
    this.editorView.dispatch({
      effects: this.mainCompartment.reconfigure(
        this.isCodeMode
          ? this.createCodeExtensions()
          : this.createEditorExtensions(),
      ),
    });

    // コードモードなら言語設定と言語用CSSクラスも適用
    if (this.isCodeMode) {
      // 拡張子による自動判別
      const detectedLang = this.detectLanguageFromExtension(filePath);
      if (detectedLang) {
        console.log(`Auto-detected language: ${detectedLang}`);
        this.currentCodeLanguage = detectedLang;
        await this.store.set("codeLanguage", detectedLang);
        await this.store.save();
      }
      await this.getLanguageSupport(); // 言語読み込み・適用
      document.body.classList.add("code-mode");
      this.editorView.dispatch({
        effects: this.codeFontCompartment.reconfigure(
          this.createCodeFontTheme(),
        ),
      });
      this.updateCodeFontCss();
    } else {
      document.body.classList.remove("code-mode");
    }

    const view = this.editorView;

    // 5. 描画更新を待ってから、スクロールとUI設定の再適用を「同時」に行う
    requestAnimationFrame(() => {
      view.dispatch({
        effects: [
          // ★ effectsを配列にする
          // カーソル位置を中央にスクロール
          EditorView.scrollIntoView(view.state.selection.main.head, {
            y: "center",
          }),
        ],
      });
      view.focus();
    });
    // 新しくアクティブになったタブのheadingsを復元
    this.activeFileHeadings = tab.headings;
    this.renderSidebar(); // 先にファイル名だけ表示

    // 6. アウトラインの解析とUIの更新
    await this.parseHeadingsFromEditor(this.editorView);
    this.renderSidebar();

    // 7. 設定を保存し、フォーカスを当てる
    await this.saveSettings();
    this.updateStatusBar(this.editorView);
    this.editorView.focus();
  }
}

// --- アプリケーションのエントリーポイント ---
window.addEventListener("DOMContentLoaded", () => {
  App.create();
});

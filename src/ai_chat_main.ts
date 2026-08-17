// src/ai-chat-main.ts
import { AiChat, ChatSettings } from "./ai_chat";
import { initI18n, t, applyTranslationsToDOM } from "./i18n";
import { Store } from "@tauri-apps/plugin-store";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

// --- 型定義 ---
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// --- MirrorShard独自形式 (Pastel形式) の型定義 ---
interface PastelMessage {
  currentlySelected: number;
  versions: {
    role: string;
    type: string;
    content?: { type: string; text: string }[] | null;
    steps?:
      | { type: string; content: { type: string; text: string }[] }[]
      | null;
  }[];
}

interface PastelLog {
  name: string;
  createdAt: number;
  messages: PastelMessage[];
}

// --- DOM要素 ---
const chatLog = document.getElementById("chat-log")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const messageInput = document.getElementById(
  "message-input",
) as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const sdLinkBtn = document.getElementById("sd-link") as HTMLButtonElement;
const webSearchBtn = document.getElementById("web-search") as HTMLButtonElement;
const apiTrigger = document.getElementById("api-selector-trigger");
const apiOptions = document.getElementById("api-selector-options");
const searchTrigger = document.getElementById("search-selector-trigger");
const searchOptions = document.getElementById("search-selector-options");
const wrapper = document.getElementById("ai-wrapper");

const TRANSPARENT_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// --- State ---
let chatHistory: ChatMessage[] = [];
let isProcessing = false;
let currentFilePath: string | null = null;
let aiSettings: ChatSettings = { apiType: "gemini" };
let store: Store | null = null;
let userName = "User";
let aiName = "AI";
let userIconSrc = "";
let aiIconSrc = "";
let isChatDirty = false;
let agentAbortController: AbortController | null = null;
let imageGenAbortController: AbortController | null = null;
const osType = type();
let isSimpleFullscreen = false;

const aiChat = new AiChat(onAiUpdate);

async function downloadAndSaveImage(url: string) {
  try {
    const filePath = await save({
      filters: [{ name: "Image", extensions: ["jpg", "png"] }],
      defaultPath: `mistral_image_${Date.now()}.jpg`,
    });

    if (!filePath) return;

    // ブラウザの fetch ではなく tauriFetch を使うことで CORS をバイパス
    const response = await tauriFetch(url, {
      method: "GET",
      connectTimeout: 10000,
    });

    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // 既存の関数を再利用
    await invoke("force_save_file", {
      path: filePath,
      content: Array.from(uint8Array), // RustのVec<u8>に渡す
    });
  } catch (err) {
    console.error("Save failed:", err);
    // 最終手段としてブラウザで開く
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  }
}

/**
 * AIのメッセージを解析し、画像JSONをHTMLに変換してからMarkdownパースする
 */
function formatAiMessage(text: string): string {
  if (text === "...") return "...";

  let processedText = text;

  // A. 画像生成プロンプトのJSON {"prompt": "..."} を非表示にする（任意）
  // もしプロンプトを表示させたければここをコメントアウト
  processedText = processedText.replace(/\{"prompt":\s*"[\s\S]*?"\}/g, "");

  // B. 画像URLのJSONを、背景色が同期した画像ブロックに置換
  // ボタンを廃止し、画像そのものが「保存ボタン」を兼ねる
  processedText = processedText.replace(
    /\{"url":\s*"(https?:\/\/[^"]+|asset:\/\/[^"]+)"\}/g,
    (_, url) => {
      return `
<div class="ai-generated-image-container" style="display: block; margin: 0; border: none; border-radius: 12px; overflow: hidden; background: transparent;">
    <img src="${url}" class="generated-img" data-url="${url}"
         style="width: 100%; height: auto; cursor: pointer; display: block;"
         title="Click to download (Open in Browser)" />
</div>`;
    },
  );

  return marked.parse(processedText) as string;
}

function onAiUpdate(text: string, isFinal: boolean) {
  const lastMsgIdx = chatHistory.length - 1;
  if (lastMsgIdx >= 0 && chatHistory[lastMsgIdx].role === "assistant") {
    chatHistory[lastMsgIdx].content = text;
  } else {
    chatHistory.push({ role: "assistant", content: text });
  }

  const bubble = document.querySelector(
    `[data-message-id='${lastMsgIdx}'] .message-bubble`,
  );
  if (bubble) {
    bubble.innerHTML = formatAiMessage(text);
  } else {
    addMessageToLog("assistant", text, lastMsgIdx);
  }

  autoScroll();

  if (isFinal) {
    const sdMatch = text.match(/\[\[SD_PROMPT:\s*(.*?)\s*\]\]/);
    const isSdLinkActive = document
      .getElementById("sd-link")
      ?.classList.contains("enabled");

    if (sdMatch && isSdLinkActive) {
      const sdPrompt = sdMatch[1];

      // UIをロックしてそのまま「全文」と「インデックス」を渡して画像生成へ
      setUiLocked(true);
      generateImageFromChat(sdPrompt, text, lastMsgIdx);
      return; // 通常のアンロック処理をスキップ
    }

    // --- 通常のアンロック処理 ---
    const textarea = document.getElementById("message-input");
    if (textarea) {
      setUiLocked(false);
      textarea.focus();
      if (currentFilePath) saveLogOverwrite();
      else isChatDirty = true;
    }
  }
}

// --- AIセレクタの動的生成とイベント登録 ---
async function renderAiSelector() {
  if (!apiOptions || !store) return;

  // 1. HTMLを一旦空にして再構築
  apiOptions.innerHTML = "";

  apiOptions.innerHTML += `<div class="custom-option" data-value="gemini">Gemini (Cloud)</div>`;

  if (await store.get<boolean>("enableGroq")) {
    apiOptions.innerHTML += `<div class="custom-option" data-value="groq">Groq</div>`;
  }
  if (await store.get<boolean>("enableCerebras")) {
    apiOptions.innerHTML += `<div class="custom-option" data-value="cerebras">Cerebras</div>`;
  }
  if (await store.get<boolean>("enableOpenRouter")) {
    apiOptions.innerHTML += `<div class="custom-option" data-value="openrouter">OpenRouter</div>`;
  }
  if (await store.get<boolean>("enableCohere")) {
    apiOptions.innerHTML += `<div class="custom-option" data-value="cohere">Cohere</div>`;
  }
  if (await store.get<boolean>("enableMistral")) {
    apiOptions.innerHTML += `<div class="custom-option" data-value="mistral">Mistral</div>`;
  }

  apiOptions.innerHTML += `<div class="custom-option" data-value="local">Local AI</div>`;

  // 2. 新しく生成された要素を取得し直してイベントを付ける
  const newApiItems = apiOptions.querySelectorAll(".custom-option");

  newApiItems.forEach((item) => {
    item.addEventListener("click", async () => {
      const newType = item.getAttribute("data-value") as
        | "gemini"
        | "groq"
        | "cerebras"
        | "openrouter"
        | "cohere"
        | "mistral"
        | "local";
      const newText = item.textContent;

      if (newType && newText) {
        // ロジックの実行
        aiSettings.apiType = newType;
        await aiChat.updateSettings(aiSettings);

        if (store) {
          await store.set("selectedApiType", newType);
          await store.save();
        }
        showNotification(t("aiChat.notification.switchTo", { name: newText }));

        // UIの更新
        if (apiTrigger) apiTrigger.textContent = newText;
        apiOptions.classList.remove("open");

        // セッションのリセット（必要に応じて）
        if (newType === "gemini") {
          aiChat.startNewSession();
        }
      }
    });
  });
}

// --- 検索セレクタの動的生成とイベント登録 ---
async function renderSearchSelector() {
  if (!searchOptions || !store) return;

  // 1. HTMLを一旦空にして再構築
  searchOptions.innerHTML = "";

  // DuckDuckGoは常に利用可能
  searchOptions.innerHTML += `<div class="custom-option" data-value="duckduckgo">DuckDuckGo</div>`;

  // 設定でTavilyが有効な場合のみ追加
  if (await store.get<boolean>("enableTavily")) {
    searchOptions.innerHTML += `<div class="custom-option" data-value="tavily">Tavily API</div>`;
  }

  // 2. 現在保存されている検索エンジンを復元（なければデフォルトでDuckDuckGo）
  let currentSearch =
    (await store.get<string>("selectedSearchEngine")) || "duckduckgo";

  // もし「前回Tavilyを選んでいたが、設定画面でTavilyを無効化した場合」の安全策（フォールバック）
  if (
    currentSearch === "tavily" &&
    !(await store.get<boolean>("enableTavily"))
  ) {
    currentSearch = "duckduckgo";
    await store.set("selectedSearchEngine", currentSearch);
    await store.save();
  }

  // 起動時にトリガーボタンのテキストを正しいものにしておく
  if (searchTrigger) {
    searchTrigger.textContent =
      currentSearch === "tavily" ? "Tavily API" : "DuckDuckGo";
  }

  // 3. 新しく生成された要素を取得し直してイベントを付ける
  const newSearchItems = searchOptions.querySelectorAll(".custom-option");

  newSearchItems.forEach((item) => {
    item.addEventListener("click", async () => {
      const newType = item.getAttribute("data-value") as
        | "duckduckgo"
        | "tavily";
      const newText = item.textContent;

      if (newType && newText) {
        // Storeに状態を保存
        if (store) {
          await store.set("selectedSearchEngine", newType);
          await store.save();
        }

        // 通知（Tavily等の検索エンジン名の翻訳キーがあればそれに変更）
        // showNotification(t("aiChat.notification.switchToSearch", { name: newText }));
        showNotification(`Search Engine: ${newText}`);

        // UIの更新
        if (searchTrigger) searchTrigger.textContent = newText;
        searchOptions.classList.remove("open");
      }
    });
  });
}

async function applySdLinkSystemPrompt() {
  const baseSysPrompt = (await store?.get<string>("aiSystemPrompt")) || "";
  const isSdLinkActive = document
    .getElementById("sd-link")
    ?.classList.contains("enabled");

  if (isSdLinkActive) {
    const sdLinkInst = t("prompts.systemPrompt.sdLinkInstruction");
    aiSettings.systemPrompt = `${baseSysPrompt}\n\n${sdLinkInst}`;
  } else {
    aiSettings.systemPrompt = baseSysPrompt;
  }

  if (aiChat) {
    aiChat.updateSettings(aiSettings);
  }
}

// --- 初期化 ---
async function init() {
  try {
    store = await Store.load(".settings.dat");

    const apiKey = await store.get<string>("geminiApiKey");
    const model = await store.get<string>("geminiModel");
    const groqKey = await store.get<string>("groqApiKey");
    const groqModel = await store.get<string>("groqModel");
    const cerebrasKey = await store.get<string>("cerebrasApiKey");
    const cerebrasModel = await store.get<string>("cerebrasModel");
    const openRouterKey = await store.get<string>("openRouterApiKey");
    const openRouterModel = await store.get<string>("openRouterModel");
    const cohereKey = await store.get<string>("cohereApiKey");
    const cohereModel = await store.get<string>("cohereModel");
    const mistralKey = await store.get<string>("mistralApiKey");
    const mistralAgent = await store.get<string>("mistralAgentID");
    const mistralModel = await store.get<string>("mistralModel");
    const enableAgents = await store.get<boolean>("enableMistralAgents");
    const localUrl = await store.get<string>("localLlmUrl");
    const sysPrompt = await store.get<string>("aiSystemPrompt");
    const maxTokens = (await store.get<number>("aiMaxTokens")) || 2000;
    const savedApiType =
      (await store.get<string>("selectedApiType")) || "gemini";
    const isDark = await store.get<boolean>("isDarkMode");
    if (isDark) {
      document.body.classList.add("dark-mode");
    }
    const isSdLinkEnabled =
      (await store.get<boolean>("sdLinkEnabled")) ?? false;
    if (isSdLinkEnabled) {
      sdLinkBtn.classList.add("enabled");
    }
    const isWebSearchEnabled =
      (await store.get<boolean>("webSearchEnabled")) ?? false;
    if (isWebSearchEnabled) {
      webSearchBtn.classList.add("enabled");
    }

    aiSettings = {
      apiType: savedApiType as
        | "gemini"
        | "groq"
        | "cerebras"
        | "openrouter"
        | "cohere"
        | "mistral"
        | "local",
      geminiApiKey: apiKey || undefined,
      geminiModel: model || undefined,
      groqApiKey: groqKey || undefined,
      groqModel: groqModel || undefined,
      cerebrasApiKey: cerebrasKey || undefined,
      cerebrasModel: cerebrasModel || undefined,
      openRouterApiKey: openRouterKey || undefined,
      openRouterModel: openRouterModel || undefined,
      cohereApiKey: cohereKey || undefined,
      cohereModel: cohereModel || undefined,
      mistralApiKey: mistralKey || undefined,
      mistralAgentID: mistralAgent || undefined,
      mistralModel: mistralModel || undefined,
      localUrl: localUrl || undefined,
      systemPrompt: sysPrompt || undefined,
      maxTokens: maxTokens,
      enableMistralAgents: enableAgents || false,
    };

    if (apiTrigger) {
      if (savedApiType === "gemini") {
        apiTrigger.textContent = "Gemini";
      } else if (savedApiType === "groq") {
        apiTrigger.textContent = "Groq";
      } else if (savedApiType === "cerebras") {
        apiTrigger.textContent = "Cerebras";
      } else if (savedApiType === "openrouter") {
        apiTrigger.textContent = "OpenRouter";
      } else if (savedApiType === "cohere") {
        apiTrigger.textContent = "Cohere";
      } else if (savedApiType === "mistral") {
        apiTrigger.textContent = "Mistral";
      } else {
        apiTrigger.textContent = "Local LLM";
      }
    }
    await aiChat.updateSettings(aiSettings);
    await renderAiSelector();
    await renderSearchSelector();

    // 表示テキストの初期化
    if (apiTrigger && apiOptions) {
      const activeOption = apiOptions.querySelector(
        `.custom-option[data-value="${savedApiType}"]`,
      );
      apiTrigger.textContent = activeOption
        ? activeOption.textContent
        : "Gemini (Cloud)";
    }
    await loadProfileSettings();
    await applyAppearanceSettings();

    setupEventListeners();
    setupSettingsListener();
    setupThemeListener();
    const appLang = (await store.get("appLanguage")) ?? "ja";
    await initI18n(appLang === "en" ? "en" : "ja");
    applyTranslationsToDOM();
    listen("app:language-changed", async (event) => {
      await initI18n(event.payload === "en" ? "en" : "ja");
      applyTranslationsToDOM();
      const title: string = await invoke<string>("get_window_title", {
        windowKey: "ai_chat",
      }).catch((): string => "");
      if (title) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(title);
      }
    });
    await applyGlowEffect();

    // 前回セッションのロード
    const lastSessionPath = await store.get<string>("lastAiChatSessionPath");
    if (lastSessionPath) {
      console.log("Auto-loading session:", lastSessionPath);
      await loadLogFile(lastSessionPath);
    }
  } catch (e) {
    console.error("Init Error:", e);
  }

  const appWindow = getCurrentWindow();

  const title: string = await invoke<string>("get_window_title", {
    windowKey: "ai_chat",
  }).catch((): string => "");
  if (title) {
    await appWindow.setTitle(title);
  }

  appWindow.onCloseRequested(async (event) => {
    if (isChatDirty) {
      // 一旦ウィンドウが閉じるのをストップ
      event.preventDefault();

      const yes = await ask(t("aiChat.dialog.saveConfirmMsg"), {
        title: t("aiChat.dialog.saveConfirmTitle"),
        kind: "warning",
        okLabel: t("aiChat.dialog.saveOk"),
        cancelLabel: t("aiChat.dialog.saveCancel"),
      });

      if (yes) {
        // 保存処理を呼ぶ（ここでダイアログが出る）
        await saveLogOverwrite();
        // 保存が成功してパスが確定していれば閉じる
        if (!isChatDirty) {
          appWindow.destroy();
        }
      } else {
        // 保存せずに破棄して閉じる
        isChatDirty = false;
        appWindow.destroy();
      }
    }
  });
  await invoke("ping_window_ready", { label: "AI Chat" });
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();
  // Niriスタックウィンドウのトリガー (Linuxのみ)
  if (osType === "linux") {
    await invoke("trigger_niri_stack");
  }
}

// プロフィール読み込み関数
async function loadProfileSettings() {
  if (!store) return;
  userName = (await store.get<string>("aiChatUserName")) || "User";
  aiName = (await store.get<string>("aiChatAiName")) || "AI";

  const uPath = await store.get<string>("aiChatUserIconPath");
  userIconSrc = uPath ? convertFileSrc(uPath) : TRANSPARENT_ICON; // convertFileSrcでasset://URLに変換

  const aPath = await store.get<string>("aiChatAiIconPath");
  aiIconSrc = aPath ? convertFileSrc(aPath) : TRANSPARENT_ICON;
}

async function applyAppearanceSettings() {
  if (!store) return;
  const root = document.documentElement.style;

  // 1. 背景色 (customWindowBg)
  const bg = await store.get<string>("customWindowBg");
  if (bg) {
    root.setProperty("--window-bg-color", bg);
  } else {
    // 設定がない場合はデフォルト(CSSのフォールバック)に戻すため削除
    root.removeProperty("--window-bg-color");
  }

  // 2. フォント (userFontFamily)
  const font = await store.get<string>("userFontFamily");
  if (font && font !== "default") {
    root.setProperty("--user-font-family", `"${font}"`);
  } else {
    root.removeProperty("--user-font-family");
  }

  // フォントサイズ (aiFontSize)
  const fontSize = await store.get<number>("aiFontSize");
  if (fontSize) {
    root.setProperty("--user-font-size", `${fontSize}px`);
  } else {
    root.removeProperty("--user-font-size");
  }

  // 3. チャットバルーンの背景色 (chatBubbleBg)
  const bubbleBg = await store.get<string>("customEditorBg");
  if (bubbleBg) {
    root.setProperty("--editor-bg-color", bubbleBg);
  } else {
    root.removeProperty("--editor-bg-color");
  }

  // 4. テキスト色 (customTextColor)
  const textColor = await store.get<string>("customTextColor");
  if (textColor) {
    root.setProperty("--editor-text-color", textColor);
  } else {
    root.removeProperty("--editor-text-color");
  }

  // 5. 選択色 (customSelectionColor)
  const selectionColor = await store.get<string>("customSelectionColor");
  if (selectionColor) {
    root.setProperty("--selection-color", selectionColor);
  } else {
    root.removeProperty("--selection-color");
  }
  // 6. UIテキスト色 (customUiTextColor)
  const uiTextColor = await store.get<string>("customUiTextColor");
  if (uiTextColor) {
    root.setProperty("--ui-text-color", uiTextColor);
  } else {
    root.removeProperty("--ui-text-color");
  }
  // 7. スクロールバーの色 (customScrollbarColor)
  const scrollbarColor = await store.get<string>("customScrollbarColor");
  if (scrollbarColor) {
    root.setProperty("--scrollbar-color", scrollbarColor);
  } else {
    root.removeProperty("--scrollbar-color");
  }
}

// --- グロー適用ロジック (堅牢化版) ---
async function applyGlowEffect() {
  if (!store) return;
  // ストアから取得 (型を明示)
  const enableGlow = (await store.get<boolean>("enableGlow")) ?? false;
  const glowColor =
    (await store.get<string>("glowColor")) || "rgba(0, 255, 65, 0.5)";
  const glowRadius = (await store.get<number>("glowRadius")) || 5;

  const root = document.documentElement.style;
  const body = document.body;

  // 現在がダークモードかどうかチェック
  const isDark = body.classList.contains("dark-mode");

  // 「ライトモード(カスタムモード)」かつ「グロー有効」のときだけ発動
  if (!isDark && enableGlow) {
    body.classList.add("custom-glow");

    // 計算後のシャドウ文字列を入れる変数
    let shadowVal = "";

    // RGBAの解析
    const match = glowColor.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/,
    );

    if (match) {
      const r = match[1];
      const g = match[2];
      const b = match[3];
      const a = parseFloat(match[4] || "1");

      // 3段階の影を作成
      const shadow1 = `0 0 ${glowRadius}px rgba(${r}, ${g}, ${b}, ${a})`;
      const shadow2 = `0 0 ${glowRadius * 2}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.1)})`;
      const shadow3 = `0 0 ${glowRadius * 4}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.2)})`;

      shadowVal = `${shadow1}, ${shadow2}, ${shadow3}`;
    } else {
      // パース失敗時（HEXなどの場合）は単純な影にする
      console.warn("Glow color parse failed, using simple shadow:", glowColor);
      shadowVal = `0 0 ${glowRadius}px ${glowColor}, 0 0 ${glowRadius * 2}px ${glowColor}`;
    }

    // 変数をセット
    console.log("Applying Glow:", shadowVal); // デバッグ用
    root.setProperty("--custom-text-shadow", shadowVal);
  } else {
    // 無効化
    body.classList.remove("custom-glow");
    root.removeProperty("--custom-text-shadow");
  }
}

function setupSettingsListener() {
  listen("settings-changed", async (event: any) => {
    const p = event.payload;
    aiSettings.geminiApiKey = p.geminiApiKey ?? aiSettings.geminiApiKey;
    aiSettings.geminiModel = p.geminiModel ?? aiSettings.geminiModel;
    aiSettings.groqApiKey = p.groqApiKey ?? aiSettings.groqApiKey;
    aiSettings.groqModel = p.groqModel ?? aiSettings.groqModel;
    aiSettings.cerebrasApiKey = p.cerebrasApiKey ?? aiSettings.cerebrasApiKey;
    aiSettings.cerebrasModel = p.cerebrasModel ?? aiSettings.cerebrasModel;
    aiSettings.openRouterApiKey =
      p.openRouterApiKey ?? aiSettings.openRouterApiKey;
    aiSettings.openRouterModel =
      p.openRouterModel ?? aiSettings.openRouterModel;
    aiSettings.cohereApiKey = p.cohereApiKey ?? aiSettings.cohereApiKey;
    aiSettings.cohereModel = p.cohereModel ?? aiSettings.cohereModel;
    aiSettings.mistralApiKey = p.mistralApiKey ?? aiSettings.mistralApiKey;
    aiSettings.mistralAgentID = p.mistralAgentID ?? aiSettings.mistralAgentID;
    aiSettings.mistralModel = p.mistralModel ?? aiSettings.mistralModel;
    aiSettings.localUrl = p.localLlmUrl ?? aiSettings.localUrl;
    aiSettings.localModel = p.localLlmModel ?? aiSettings.localModel;
    aiSettings.systemPrompt = p.aiSystemPrompt ?? aiSettings.systemPrompt;
    aiSettings.maxTokens = p.aiMaxTokens ?? aiSettings.maxTokens;
    aiSettings.enableMistralAgents =
      p.enableMistralAgents ?? aiSettings.enableMistralAgents;

    // 外観設定のリアルタイム反映
    const root = document.documentElement.style;
    if (p.customWindowBg !== undefined) {
      if (p.customWindowBg)
        root.setProperty("--window-bg-color", p.customWindowBg);
      else root.removeProperty("--window-bg-color");
    }
    if (p.userFontFamily !== undefined) {
      if (p.userFontFamily && p.userFontFamily !== "default") {
        root.setProperty("--user-font-family", `"${p.userFontFamily}"`);
      } else {
        root.removeProperty("--user-font-family");
      }
    }
    if (p.aiFontSize !== undefined) {
      if (p.aiFontSize)
        root.setProperty("--user-font-size", `${p.aiFontSize}px`);
      else root.removeProperty("--user-font-size");
    }
    if (p.customEditorBg !== undefined) {
      if (p.customEditorBg)
        root.setProperty("--editor-bg-color", p.customEditorBg);
      else root.removeProperty("--editor-bg-color");
    }
    if (p.customTextColor !== undefined) {
      if (p.customTextColor)
        root.setProperty("--editor-text-color", p.customTextColor);
      else root.removeProperty("--editor-text-color");
    }
    if (p.customSelectionColor !== undefined) {
      if (p.customSelectionColor)
        root.setProperty("--selection-color", p.customSelectionColor);
      else root.removeProperty("--selection-color");
    }
    if (p.customUiTextColor !== undefined) {
      if (p.customUiTextColor)
        root.setProperty("--ui-text-color", p.customUiTextColor);
      else root.removeProperty("--ui-text-color");
    }
    if (p.customScrollbarColor !== undefined) {
      if (p.customScrollbarColor)
        root.setProperty("--scrollbar-color", p.customScrollbarColor);
      else root.removeProperty("--scrollbar-color");
    }
    // プロフィールの更新
    if (p.aiChatUserName !== undefined) userName = p.aiChatUserName;
    if (p.aiChatAiName !== undefined) aiName = p.aiChatAiName;
    // アイコンパスが送られてきたらURL変換
    if (p.aiChatUserIconPath !== undefined) {
      userIconSrc = p.aiChatUserIconPath
        ? convertFileSrc(p.aiChatUserIconPath)
        : TRANSPARENT_ICON;
    }
    if (p.aiChatAiIconPath !== undefined) {
      aiIconSrc = p.aiChatAiIconPath
        ? convertFileSrc(p.aiChatAiIconPath)
        : TRANSPARENT_ICON;
    }
    if (
      p.enableGlow !== undefined ||
      p.glowColor !== undefined ||
      p.glowRadius !== undefined
    ) {
      await applyGlowEffect();
    }
    // もし設定画面でプロバイダの有効/無効が切り替えられたら、メニューを再構築する
    if (p.enableCohere !== undefined || p.enableMistral !== undefined) {
      await renderAiSelector();
    }

    // もし設定画面から直接 apiType が変更された場合の処理 (同期)
    if (p.selectedApiType) {
      aiSettings.apiType = p.selectedApiType;
      if (apiTrigger) {
        const textMap: Record<string, string> = {
          gemini: "Gemini (Cloud)",
          groq: "Groq",
          cerebras: "Cerebras",
          openrouter: "OpenRouter",
          cohere: "Cohere",
          mistral: "Mistral",
          local: "Local AI",
        };
        apiTrigger.textContent = textMap[p.selectedApiType] || "Unknown API";
      }
    }

    await aiChat.updateSettings(aiSettings);
    // ログを再描画して新しい名前/アイコンを反映
    redrawLog();
  });
}

// テーマ同期リスナー
function setupThemeListener() {
  listen("app:theme-changed", (event: any) => {
    const isDark = event.payload.isDarkMode;
    if (isDark) {
      document.body.classList.add("dark-mode");
    } else {
      document.body.classList.remove("dark-mode");
    }
    applyGlowEffect();
  });
}

function setupEventListeners() {
  // --- AIセレクタの開閉 ---
  apiTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    apiOptions?.classList.toggle("open");
    searchOptions?.classList.remove("open"); // 開いた時に検索側を閉じる
  });

  // --- 検索セレクタの開閉 ---
  searchTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    searchOptions?.classList.toggle("open");
    apiOptions?.classList.remove("open"); // 開いた時にAI側を閉じる
  });

  document.addEventListener(
    "click",
    async (e) => {
      // 画面クリックでメニューを閉じる
      apiOptions?.classList.remove("open");
      searchOptions?.classList.remove("open");

      const targetEl = e.target as HTMLElement;

      // 1. 画像保存ボタン、または画像そのものがクリックされた場合
      const imgBtn = targetEl.closest(".save-img-btn");
      const genImg = targetEl.closest(".generated-img");

      if (imgBtn || genImg) {
        const url = (imgBtn || genImg)?.getAttribute("data-url");
        if (url) {
          e.preventDefault();
          downloadAndSaveImage(url);
        }
        return;
      }

      // 2. 通常のリンククリックのインターセプト
      const link = targetEl.closest("a");
      if (link && link.href && link.href.startsWith("http")) {
        e.preventDefault();
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(link.href);
      }
    },
    true,
  ); // キャプチャフェーズで確実に捕まえる

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || isProcessing) return;
    isChatDirty = true;
    await processUserMessage(text);
  });

  sdLinkBtn.addEventListener("click", async () => {
    sdLinkBtn.classList.toggle("enabled");
    const newState = sdLinkBtn.classList.contains("enabled");
    if (store) {
      await store.set("sdLinkEnabled", newState);
      await store.save();
    }
  });

  webSearchBtn.addEventListener("click", async () => {
    webSearchBtn.classList.toggle("enabled");
    const newState = webSearchBtn.classList.contains("enabled");
    if (store) {
      await store.set("webSearchEnabled", newState);
      await store.save();
    }
  });

  // --- 右クリックメニュー (Context Menu) ---
  document.addEventListener("contextmenu", async (e) => {
    e.preventDefault();

    // メニューの構築
    const menu = await Menu.new({
      items: [
        await MenuItem.new({
          text: t("aiChat.action.newChat"),
          action: clearLog,
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          text: t("aiChat.action.loadLog"),
          action: loadLog,
        }),
        await MenuItem.new({
          text: t("aiChat.action.saveLog"),
          action: saveLogOverwrite,
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          text: t("aiChat.action.sendToEditor"),
          action: sendToEditor,
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Copy" }),
        await PredefinedMenuItem.new({ item: "Paste" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          text: t("aiChat.action.closeWindow"),
          action: () => getCurrentWindow().close(),
        }),
      ],
    });

    // マウス位置にポップアップ
    await menu.popup();
  });

  // --- ショートカットキー ---
  document.addEventListener("keydown", async (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isMac = osType === "macos";
    const isCtrl = e.ctrlKey;
    const isCmd = e.metaKey;

    // 入力欄にフォーカスがある場合、一部のショートカットは無効化するか、挙動を変える
    // ただし Ctrl+S などは効かせたいので、ここでは除外判定は緩めに

    if (e.key === "Escape") {
      let aborted = false;

      if (agentAbortController) {
        e.preventDefault();
        agentAbortController.abort();
        aborted = true;
      }
      if (imageGenAbortController) {
        e.preventDefault();
        imageGenAbortController.abort();
        aborted = true;
      }

      if (aborted) {
        hideAiLoadingOverlay();
        setUiLocked(false);
        // WebUI用の中断信号を投げておく（念のため）
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        tauriFetch("http://127.0.0.1:7860/sdapi/v1/interrupt", {
          method: "POST",
        }).catch(() => {});
      }
    }

    // Ctrl + T : ダークモード切替
    if (isCtrlOrCmd && key === "t" && !isShift) {
      e.preventDefault();
      await emit("subwindow-toggle-theme");
      return;
    }

    // Ctrl + S : 上書き保存
    if (isCtrlOrCmd && !isShift && key === "s") {
      e.preventDefault();
      await saveLogOverwrite();
      return;
    }

    // Ctrl + O : 読み込み
    if (isCtrlOrCmd && !isShift && key === "o") {
      e.preventDefault();
      await loadLog();
      return;
    }

    // Ctrl + Shift + C : ログクリア
    if (isCtrlOrCmd && isShift && key === "c") {
      e.preventDefault();
      // 入力欄でのコピー操作と被らないよう注意が必要だが、
      // 何も選択されていなければ発動、あるいはShift付きはクリアに割り当ててあるのでOK
      await clearLog();
      return;
    }

    // F11 : 最大化トグル(Win/Linux)
    if (!isMac && e.key === "F11") {
      e.preventDefault();
      await AIToggleFullscreen();
      return;
    }
    // 最大化トグル(Mac)
    if (isMac && isCtrl && isCmd && key === "f") {
      e.preventDefault();
      await AIToggleFullscreen();
      return;
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

    if (
      (isCtrlOrCmd && key === "`") ||
      (isCtrlOrCmd && key === "@")
    ) {
      e.preventDefault();
      invoke("open_terminal_window");
    }

    if (isCtrlOrCmd && key === "f" && !isShift) {
      e.preventDefault();
    }
    if (isCtrlOrCmd && key === "p" && !isShift) {
      e.preventDefault();
    }
    if (isCtrlOrCmd && key === "r") {
      e.preventDefault();
    }
    if (isCtrlOrCmd && key === "r" && isShift) {
      e.preventDefault();
    }
  });

  messageInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      chatForm.dispatchEvent(new Event("submit"));
    }
  });

  document
    .getElementById("ai-close-btn")
    ?.addEventListener("click", () => getCurrentWindow().close());
  document
    .getElementById("ai-fullscreen-btn")
    ?.addEventListener("click", () => AIToggleFullscreen());

  document
    .getElementById("ai-clear-log-btn")
    ?.addEventListener("click", clearLog);
  document
    .getElementById("ai-save-log-btn")
    ?.addEventListener("click", saveLogAs);
  document
    .getElementById("ai-save-overwrite-btn")
    ?.addEventListener("click", saveLogOverwrite);
  document
    .getElementById("ai-load-log-btn")
    ?.addEventListener("click", loadLog);

  messageInput.addEventListener("input", resizeTextarea);
}

// フルスクリーン処理を他ウィンドウと統一
// （旧実装は await getCurrentWindow().toggleMaximize(); ）

async function AIToggleFullscreen() {
  isSimpleFullscreen = !isSimpleFullscreen;
  await invoke("set_simple_fullscreen", { enable: isSimpleFullscreen });
  if (osType !== "macos" && wrapper) {
    wrapper.style.borderRadius = isSimpleFullscreen ? "0px" : "6px";
  }
  if (!isSimpleFullscreen && osType === "linux") {
    setTimeout(async () => {
      try {
        await invoke("trigger_niri_stack");
      } catch (e) {
        console.error("再スタックに失敗しました:", e);
      }
    }, 150);
  }
}

// --- ロジック ---
async function processUserMessage(text: string) {
  setUiLocked(true);
  chatHistory.push({ role: "user", content: text });
  addMessageToLog("user", text, chatHistory.length - 1);

  messageInput.value = "";
  resizeTextarea();

  chatHistory.push({ role: "assistant", content: "..." });
  addMessageToLog("assistant", "...", chatHistory.length - 1);

  // SD-Link 等のシステムプロンプトを最新状態に合成
  await applySdLinkSystemPrompt();

  // Web検索トグルがオンか判定
  const isWebSearchActive = document
    .getElementById("web-search")
    ?.classList.contains("enabled");

  if (isWebSearchActive) {
    // --- 🌐 Rig (Rust) エージェントモード ---
    await runWebAgentViaRust();
  } else {
    // --- 💬 既存のストリーミングモード ---
    const historyToSend = chatHistory.slice(0, -1);
    await aiChat.sendMessage(historyToSend);
  }
}

function setUiLocked(locked: boolean) {
  isProcessing = locked;
  sendBtn.disabled = locked;
  messageInput.disabled = locked;
  const controls = document.querySelectorAll(".action-btn");
  controls.forEach((el) => ((el as HTMLButtonElement).disabled = locked));
}

function addMessageToLog(role: string, content: string, index: number) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  row.dataset.messageId = String(index);

  let htmlContent = "";
  if (role === "assistant") {
    htmlContent = formatAiMessage(content);
  } else {
    const escaped = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    htmlContent = escaped.replace(/\n/g, "<br>");
  }

  // ★ userName, aiName, userIconSrc, aiIconSrc 変数を使用
  const currentName = role === "user" ? userName : aiName;
  const currentIcon = role === "user" ? userIconSrc : aiIconSrc;

  row.innerHTML = `
        <div class="avatar-container">
            <img class="message-icon" src="${currentIcon}">
            <div class="message-actions">
                ${
                  role === "user"
                    ? `<button class="action-btn btn-edit" onclick="window.editMsg(${index})" title="${t("aiChat.action.edit")}"></button>
                       <button class="action-btn btn-delete" onclick="window.deleteMsg(${index})" title="${t("aiChat.action.delete")}"></button>`
                    : `<button class="action-btn btn-regenerate" onclick="window.regenMsg(${index})" title="${t("aiChat.action.regenerate")}"></button>
                       <button class="action-btn btn-copy" onclick="window.copyMsg(${index})" title="${t("aiChat.action.copy")}"></button>`
                }
            </div>
        </div>
        <div class="message-content">
            <div class="message-sender">${currentName}</div>
            <div class="message-bubble">${htmlContent}</div>
        </div>
    `;

  const existing = document.querySelector(`[data-message-id='${index}']`);
  if (existing) {
    existing.replaceWith(row);
  } else {
    chatLog.appendChild(row);
  }
  autoScroll();
}

function resizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 240) + "px";
}

function autoScroll() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function redrawLog() {
  chatLog.innerHTML = "";
  chatHistory.forEach((msg, idx) =>
    addMessageToLog(msg.role, msg.content, idx),
  );
}

function showNotification(msg: string) {
  const container = document.getElementById("notification-container")!;
  const div = document.createElement("div");
  div.className = "toast-notification show";
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// --- ログ保存/読込 (独自形式対応) ---

/**
 * 独自形式(Pastel)のJSONを読み込んでチャット履歴に変換
 */
function parsePastelLog(data: any): ChatMessage[] {
  if (!data.messages || !Array.isArray(data.messages)) return [];

  const history = data.messages
    .map((m: any) => {
      // currentlySelected を使ってバージョンを選択
      const selectedIdx = m.currentlySelected ?? 0;
      const v = m.versions?.[selectedIdx];
      if (!v) return null;

      // ロールの決定
      const finalRole =
        v.role === "model" || v.role === "AI" ? "assistant" : v.role;
      let t = "";

      // SingleStep (User等)
      if (v.type === "singleStep" && v.content?.[0]?.text) {
        t = v.content[0].text;
      }
      // MultiStep (Assistant等)
      else if (v.type === "multiStep" && v.steps) {
        // Electron版と同じく 'contentBlock' を探す
        const cs = v.steps.find((s: any) => s.type === "contentBlock");
        if (cs?.content?.[0]?.text) {
          t = cs.content[0].text;
        } else {
          return null;
        }
      } else {
        return null;
      }

      return { role: finalRole, content: t.trim() };
    })
    .filter((item: any) => item !== null) as ChatMessage[];

  return history;
}

/**
 * 標準的な LM Studio / OpenAI 形式の解析
 * { messages: [{ role: "user", content: "..." }] }
 */
function parseLmStudioLog(messages: any[]): ChatMessage[] {
  return messages
    .filter((m) => m && m.role && m.content)
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
}

/**
 * チャット履歴を独自形式(Pastel)のJSONに変換
 */
function convertToPastelLog(history: ChatMessage[]): PastelLog {
  return {
    name: "AI",
    createdAt: Date.now(),
    messages: history.map((msg) => ({
      currentlySelected: 0,
      versions: [
        {
          role: msg.role === "assistant" ? "assistant" : "user", // Electron版に合わせるなら 'assistant'
          type: msg.role === "user" ? "singleStep" : "multiStep",
          // userの場合はcontent
          content:
            msg.role === "user"
              ? [{ type: "text", text: msg.content }]
              : undefined,
          // assistantの場合はsteps (Electron版の実装に基づく)
          steps:
            msg.role === "assistant"
              ? [
                  {
                    type: "contentBlock",
                    content: [{ type: "text", text: msg.content }],
                  },
                ]
              : undefined,
        },
      ],
    })),
  };
}

/**
 * ログ読み込みのメイン関数 (自動判別)
 */
async function loadLogFile(path: string) {
  try {
    const assetUrl = convertFileSrc(path);
    const response = await fetch(assetUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch log file: ${response.statusText}`);
    }

    const text = await response.text();
    const parsed = JSON.parse(text);

    let loadedHistory: ChatMessage[] = [];

    // 1. Gemini形式 (chunkedPrompt)
    if (parsed.chunkedPrompt?.chunks) {
      console.log("Format: Gemini");
      loadedHistory = parsed.chunkedPrompt.chunks
        .filter((c: any) => !c.isThought && c.text)
        .map((c: any) => ({
          role: c.role === "model" ? "assistant" : "user",
          content: c.text,
        }));
    }
    // 2. MirrorShard独自形式 (Pastel)
    // messagesを持ち、かつ中身の構造が versions を持っている場合
    else if (
      parsed.messages &&
      Array.isArray(parsed.messages) &&
      parsed.messages.length > 0 &&
      parsed.messages[0].versions
    ) {
      console.log("Format: MirrorShard (Pastel)");
      loadedHistory = parsePastelLog(parsed);
    }
    // 3. LM Studio / OpenAI形式 (messages配列を持つ標準JSON)
    else if (parsed.messages && Array.isArray(parsed.messages)) {
      console.log("Format: LM Studio (Object)");
      loadedHistory = parseLmStudioLog(parsed.messages);
    }
    // 4. ルートが配列の標準形式
    else if (Array.isArray(parsed)) {
      console.log("Format: Generic Array");
      loadedHistory = parseLmStudioLog(parsed);
    } else {
      throw new Error("Unknown log format");
    }

    if (loadedHistory.length === 0) {
      throw new Error("Log parsed but no messages found.");
    }

    chatHistory = loadedHistory;
    currentFilePath = path;
    redrawLog();

    // 読み込み成功時のみ通知（自動ロード時はうるさいので抑制しても良い）
    if (document.activeElement !== document.body) {
      // 簡易判定: ユーザー操作中（フォーカスがある）なら通知
      showNotification(t("aiChat.notification.loaded"));
    }
    isChatDirty = false;

    if (store) {
      await store.set("lastAiChatSessionPath", currentFilePath);
      await store.save();
    }
  } catch (e) {
    console.error("Load failed:", e);
    // 自動ロードでの失敗時はアラートを出さない（ファイル移動・削除の可能性があるため）
    // 明示的な操作のときだけ出すのが理想ですが、一旦コンソールのみに
    // alert(`Load failed: ${e}`);
    showNotification(
      t("aiChat.notification.loadError") +
        ": " +
        String(e).substring(0, 30) +
        "...",
    );
  }
}

async function saveLogOverwrite() {
  if (!currentFilePath) return saveLogAs();
  try {
    // 独自形式に変換して保存
    const pastelData = convertToPastelLog(chatHistory);
    const logData = JSON.stringify(pastelData, null, 2);
    // await writeTextFile(currentFilePath, JSON.stringify(pastelData, null, 2));
    await invoke("force_save_chat_log", {
      path: currentFilePath,
      content: logData,
    });
    console.log("Saved!");
    isChatDirty = false;
    if (store) {
      await store.set("lastAiChatSessionPath", currentFilePath);
      await store.save();
    }
  } catch (e) {
    alert(t("aiChat.dialog.saveFailed") + ": " + String(e));
  }
}

async function saveLogAs() {
  const path = await save({
    filters: [{ name: "MirrorShard Log", extensions: ["json"] }],
  });
  if (!path) return;
  currentFilePath = path;
  await saveLogOverwrite();
  showNotification(t("aiChat.notification.saved"));
}

async function clearLog() {
  // 1. そもそも消去していいかどうかの大前提の確認
  const initialConfirm = await ask(t("aiChat.dialog.clearConfirmMsg"), {
    title: t("aiChat.dialog.clearConfirmTitle"),
    kind: "warning",
  });
  if (!initialConfirm) return;

  // 2. 消去はOKだが、未保存がある場合の救済措置
  if (isChatDirty) {
    const doSave = await ask(t("aiChat.dialog.unsavedMsg"), {
      title: t("aiChat.dialog.saveConfirmTitle"),
      kind: "warning",
      okLabel: t("aiChat.dialog.unsavedOk"),
      cancelLabel: t("aiChat.dialog.unsavedCancel"),
    });

    if (doSave) {
      await saveLogOverwrite();
      // 保存ダイアログでキャンセルされた場合などは isChatDirty が true のままなので、処理を中断
      if (isChatDirty) return;
    } else {
      // ユーザーが「破棄」を明示的に選んだ場合
      isChatDirty = false;
    }
  }

  // 3. クリア処理の実行
  chatHistory = [];
  if (chatLog) chatLog.innerHTML = "";
  currentFilePath = null;
  isChatDirty = false; // 状態をクリーンに

  if (store) {
    await store.set("lastAiChatSessionPath", null);
    await store.save();
  }

  showNotification(t("aiChat.notification.newSession"));
}

async function loadLog() {
  const path = await open({
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path || typeof path !== "string") return;
  await loadLogFile(path);
}

// --- ログを整形してメインエディタに送る ---
async function sendToEditor() {
  if (chatHistory.length === 0) return;

  // テキスト形式に変換 (Electron版のロジックを踏襲)
  const textContent = chatHistory
    .map((m) => {
      // 名前解決
      const name = m.role === "user" ? userName : aiName;
      return `■ ${name}\n\n${m.content}`;
    })
    .join("\n\n---\n\n");

  // メインウィンドウに送信
  // ファイル名は現在時刻などをつけてもいいですが、仮で AI_Log
  await emit("request-new-tab", {
    title: `AI_Log_${Date.now()}.txt`,
    content: textContent,
  });

  showNotification(t("aiChat.notification.sentToEditor"));
}

function showAiLoadingOverlay(text: string) {
  let overlay = document.getElementById("ai-loading-overlay");
  if (!overlay) {
    // オーバーレイの作成
    overlay = document.createElement("div");
    overlay.id = "ai-loading-overlay";
    Object.assign(overlay.style, {
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      backgroundColor: "rgba(0, 0, 0, 0.6)",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      zIndex: "1000",
      color: "white",
    });

    // スピナーの作成
    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
      width: "40px",
      height: "40px",
      border: "4px solid rgba(255, 255, 255, 0.3)",
      borderTopColor: "#fff",
      borderRadius: "50%",
      animation: "spin 1s linear infinite",
      marginBottom: "20px",
    });

    // スピナー用のアニメーション（初回のみ追加）
    if (!document.getElementById("spinner-style")) {
      const style = document.createElement("style");
      style.id = "spinner-style";
      style.innerHTML = `@keyframes spin { to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }

    const textDiv = document.createElement("div");
    textDiv.id = "ai-thinking-text";
    textDiv.textContent = text;

    overlay.appendChild(spinner);
    overlay.appendChild(textDiv);
    document.body.appendChild(overlay);
  } else {
    // 既に存在する場合はテキストだけ更新
    const textDiv = document.getElementById("ai-thinking-text");
    if (textDiv) textDiv.textContent = text;
  }
}

function hideAiLoadingOverlay() {
  const overlay = document.getElementById("ai-loading-overlay");
  if (overlay) {
    overlay.remove(); // 用が済んだらDOMごと消し去る
  }
}

// --- 画像生成と保存のコアロジック ---
async function generateImageFromChat(
  sdPrompt: string,
  originalText: string,
  msgIdx: number,
) {
  showAiLoadingOverlay(
    t("aiChat.generatingImage") || "Generating image with Local SD...",
  );
  imageGenAbortController = new AbortController();

  let finalContent = originalText; // 最終的に吹き出しに入るテキスト

  try {
    const exePath = (await store?.get<string>("sdWebUIPath")) || "";
    const isCppMode =
      exePath.toLowerCase().endsWith("sd-cli.exe") ||
      exePath.toLowerCase().endsWith("sd-cli");
    const isCppServer =
      exePath.toLowerCase().endsWith("sd-server.exe") ||
      exePath.toLowerCase().endsWith("sd-server");

    const imageSystemPrompt =
      (await store?.get<string>("imageSystemPrompt")) || "";
    const negPrompt =
      (await store?.get<string>("sdNegativePrompt")) ||
      "easynegative, low quality, bad anatomy";
    const steps = Number(await store?.get<number>("sdSteps")) || 20;
    const cfg = Number(await store?.get<number>("sdCfgScale")) || 7.0;
    const resolution = (await store?.get<string>("sdResolution")) || "512x512";
    const [widthStr, heightStr] = resolution.split("x");
    const width = Number(widthStr) || 512;
    const height = Number(heightStr) || 512;

    const finalPrompt = imageSystemPrompt
      ? `${imageSystemPrompt}, ${sdPrompt}`
      : sdPrompt;

    if (isCppMode) {
      // --- A. sd-cli.exe モード ---
      const { invoke } = await import("@tauri-apps/api/core");
      const savedPath = await invoke<string>("generate_image_cpp", {
        exePath: exePath,
        modelPath: await store?.get("sdModelPath"),
        prompt: finalPrompt,
        negPrompt: negPrompt,
        steps: steps,
        cfg: cfg,
        sampler: (await store?.get("sdSampler")) || "euler_a",
        scheduler: (await store?.get("sdScheduler")) || "default",
        width: width,
        height: height,
        saveDir: (await store?.get("imageAutoSavePath")) || "",
      });

      if (savedPath) {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const assetUrl = convertFileSrc(savedPath);
        finalContent = originalText.replace(
          /\[\[SD_PROMPT:.*?\]\]/g,
          `{"url": "${assetUrl}"}`,
        );
      }
    } else if (isCppServer) {
      // --- B. sd-server モード ---
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");

      const response = await tauriFetch(
        "http://127.0.0.1:8888/sdapi/v1/txt2img",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: finalPrompt,
            negative_prompt: negPrompt,
            steps: steps,
            cfg_scale: cfg,
            sample_method: (await store?.get<string>("sdSampler")) || "euler_a",
            schedule_method:
              (await store?.get<string>("sdScheduler")) || "default",
            width: width,
            height: height,
            seed: -1,
          }),
          connectTimeout: 60000,
          signal: imageGenAbortController.signal,
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(
          `sd-server API failed (Status: ${response.status}): ${errText}`,
        );
      }

      const data = await response.json();
      const savedPath = await saveBase64Image(data.images[0]);

      if (savedPath) {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const assetUrl = convertFileSrc(savedPath);

        // 元のテキストの [[SD_PROMPT: ...]] 部分だけを、画像表示用のJSONにすり替える
        finalContent = originalText.replace(
          /\[\[SD_PROMPT:.*?\]\]/g,
          `{"url": "${assetUrl}"}`,
        );
      }
    } else {
      // --- B. Web UI (API) モード ---
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
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
          signal: imageGenAbortController.signal, // fetchはsignalをサポート
        },
      );

      if (!response.ok)
        throw new Error(`SD API failed. Status: ${response.status}`);

      const data = await response.json();
      const savedPath = await saveBase64Image(data.images[0]);

      if (savedPath) {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const assetUrl = convertFileSrc(savedPath);

        // ★ 元のテキストの [[SD_PROMPT: ...]] 部分だけを、画像表示用のJSONにすり替える
        finalContent = originalText.replace(
          /\[\[SD_PROMPT:.*?\]\]/g,
          `{"url": "${assetUrl}"}`,
        );
      }
    }
  } catch (e: any) {
    if (e.name === "AbortError") {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("abort_image_cpp");
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      tauriFetch("http://127.0.0.1:7860/sdapi/v1/interrupt", {
        method: "POST",
      }).catch(() => {
        /* 失敗しても無視 */
      });
      console.log("Image generation aborted.");
      finalContent = originalText.replace(
        /\[\[SD_PROMPT:.*?\]\]/g,
        `\n\n> ❌ **Generation Aborted**\n\n`,
      );
    } else {
      console.error("SD Link Error:", e);
      finalContent = originalText.replace(
        /\[\[SD_PROMPT:.*?\]\]/g,
        `\n\n> ⚠️ **SD Image Generation Failed:** ${String(e)}\n\n`,
      );
    }
  } finally {
    imageGenAbortController = null;
    // --- UIの更新とアンロック ---

    // 履歴を書き換え
    chatHistory[msgIdx].content = finalContent;

    // 吹き出しのDOMを書き換え
    const bubble = document.querySelector(
      `[data-message-id='${msgIdx}'] .message-bubble`,
    );
    if (bubble) bubble.innerHTML = formatAiMessage(finalContent);

    autoScroll();
    hideAiLoadingOverlay();

    const textarea = document.getElementById("message-input");
    if (textarea) {
      setUiLocked(false);
      textarea.focus();
      if (currentFilePath) saveLogOverwrite();
      else isChatDirty = true;
    }
  }
}

// Base64を保存してパスを返す関数 (メインの handleImageGenerationResult とほぼ同じ)
async function saveBase64Image(base64Data: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { invoke } = await import("@tauri-apps/api/core");

  let savePath = (await store?.get<string>("imageAutoSavePath")) ?? null;

  if (!savePath || savePath.trim() === "") {
    savePath = await save({
      title: t("editor.ai.saveImageTitle"),
      defaultPath: `chat_img_${Date.now()}.png`,
      filters: [{ name: "Images", extensions: ["png"] }],
    });
  } else {
    const separator = savePath.includes("/") ? "/" : "\\";
    savePath = savePath.endsWith(separator)
      ? `${savePath}chat_img_${Date.now()}.png`
      : `${savePath}${separator}chat_img_${Date.now()}.png`;
  }

  if (!savePath) return null;

  const binaryString = window.atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  await invoke("force_save_file", {
    path: savePath,
    content: Array.from(bytes),
  });
  return savePath;
}

// Rigを呼び出す関数
async function runWebAgentViaRust() {
  agentAbortController = new AbortController();
  showAiLoadingOverlay(
    t("aiChat.agentThinking") || "Agent is researching and thinking...",
  );

  try {
    const obscuraPath = await store?.get<string>("obscuraPath");
    if (!obscuraPath) throw new Error("Obscura path is not set.");

    // 検索エンジンの設定を取得
    const searchEngine =
      (await store?.get<string>("selectedSearchEngine")) || "duckduckgo";
    const tavilyApiKey = (await store?.get<string>("tavilyApiKey")) || "";

    const apiType = aiSettings.apiType || "mistral";
    let baseUrl = "";
    let apiKey = "";
    let model = "";

    // APIごとの設定取得と分岐
    if (apiType === "groq") {
      baseUrl = "https://api.groq.com/openai/v1";
      apiKey = (await store?.get<string>("groqApiKey")) || "";
      model =
        (await store?.get<string>("groqModel")) || "openai/gpt-oss-20b";
    } else if (apiType === "cerebras") {
      baseUrl = "https://api.cerebras.ai/v1";
      apiKey = (await store?.get<string>("cerebrasApiKey")) || "";
      model = (await store?.get<string>("cerebrasModel")) || "gemma-4-31b";
    } else if (apiType === "openrouter") {
      baseUrl = "https://openrouter.ai/api/v1";
      apiKey = (await store?.get<string>("openRouterApiKey")) || "";
      model =
        (await store?.get<string>("openRouterModel")) || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
    } else if (apiType === "mistral") {
      baseUrl = "https://api.mistral.ai/v1";
      apiKey = (await store?.get<string>("mistralApiKey")) || "";
      model =
        (await store?.get<string>("mistralModel")) || "mistral-small-latest";
    } else if (apiType === "gemini") {
      apiKey = (await store?.get<string>("geminiApiKey")) || "";
      model = (await store?.get<string>("geminiModel")) || "gemini-1.5-pro";
    } else if (apiType === "cohere") {
      apiKey = (await store?.get<string>("cohereApiKey")) || "";
      model =
        (await store?.get<string>("cohereModel")) || "command-r-plus-08-2024";
    } else if (apiType === "local") {
      const rawLocalUrl =
        (await store?.get<string>("localLlmUrl")) ||
        "http://127.0.0.1:1234/v1/chat/completions";
      // Rigは内部で "/chat/completions" を自動付与するため、ここで削っておく
      baseUrl = rawLocalUrl.replace(/\/chat\/completions\/?$/, "");
      apiKey = "local";
      model = (await store?.get<string>("localLlmModel")) || "local-model";
    }

    // 1. システムプロンプト (Storeの設定 + i18nのエージェント指示)
    const baseSysPrompt =
      aiSettings.systemPrompt || "You are a helpful assistant.";
    const agentInstruction = t("prompts.systemPrompt.webAgentInstruction");

    // 2. 言語に応じた現在時刻と最終指示
    const now = new Date();
    const currentLocale = (await store?.get("appLanguage")) || "ja";

    let finalInstructions = "";
    if (currentLocale === "ja") {
      finalInstructions = `
[システム通知：現在の日時は ${now.toLocaleString("ja-JP")} であるという前提で回答せよ。]
【重要】
- 自分の知識（カットオフ）にない最新の事実は、この世界線の最新情報として 'web_search' ツールで確認し、その結果を「現在の事実」として扱うこと。
- 特に指示が無い限り、日本語で回答すること。
- ツールがエラーを返した場合は報告し、別のキーワードで検索すること。
`;
    } else {
      finalInstructions = `
[System: Current Date/Time is ${now.toLocaleString("en-US")}. This is an absolute fact and must override your internal knowledge cutoff.]
[IMPORTANT]
- For any facts beyond your internal knowledge, use 'web_search' and treat the results as the current reality of this timeline.
- If a tool fails, report it and try different keywords.
- Respond in English unless instructed otherwise.
`;
    }

    const finalSysPrompt = `${baseSysPrompt}\n\n${agentInstruction}\n\n${finalInstructions}`;

    // 過去の履歴をテキスト化（直近の文脈を伝えるため）
    const historyToSend = chatHistory.slice(0, -1);
    const promptString =
      historyToSend.map((h) => `${h.role}: ${h.content}`).join("\n\n") +
      "\n\nassistant: ";

    const { invoke } = await import("@tauri-apps/api/core");

    // Rust に投げる
    const finalAnswer = await invoke<string>("run_web_agent", {
      apiType: apiType,
      apiKey: apiKey,
      baseUrl: baseUrl,
      model: model,
      obscuraPath: obscuraPath,
      systemPrompt: finalSysPrompt,
      prompt: promptString,
      searchEngine: searchEngine,
      tavilyApiKey: tavilyApiKey,
      signal: agentAbortController.signal,
    });

    // 結果を onAiUpdate に流し込み、既存の SD-Link 等と連携させる
    onAiUpdate(finalAnswer, true);
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.log("Agent processing aborted.");
    } else {
      onAiUpdate(`⚠️ Error: ${String(e)}`, true);
    }
  } finally {
    hideAiLoadingOverlay();
    agentAbortController = null;
  }
}

// --- グローバル操作関数 ---

(window as any).editMsg = async (idx: number) => {
  if (isProcessing) return;
  const row = document.querySelector(`[data-message-id='${idx}']`);
  if (!row) return;
  const bubble = row.querySelector(".message-bubble") as HTMLElement;
  if (!bubble) return;
  if (row.querySelector(".edit-container")) return;

  const originalContent = chatHistory[idx].content;
  bubble.style.display = "none";

  const editContainer = document.createElement("div");
  editContainer.className = "edit-container";
  editContainer.style.width = "100%";

  const textarea = document.createElement("textarea");
  textarea.value = originalContent;
  textarea.rows = 3;
  textarea.className = "cyber-text";
  textarea.style.width = "100%";
  textarea.style.boxSizing = "border-box";
  textarea.style.marginTop = "5px";
  textarea.style.marginBottom = "5px";

  const btnContainer = document.createElement("div");
  btnContainer.style.display = "flex";
  btnContainer.style.gap = "10px";
  btnContainer.style.justifyContent = "flex-end";

  const saveBtn = document.createElement("button");
  saveBtn.className = "cyber-button";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cyber-button";

  const editOkText = t("aiChat.dialog.editOk") || "OK";
  const editCancelText = t("aiChat.dialog.editCancel") || "Cancel";
  saveBtn.textContent = editOkText;
  cancelBtn.textContent = editCancelText;

  saveBtn.onclick = async () => {
    const newText = textarea.value.trim();
    if (!newText || newText === originalContent) {
      cancelEdit();
      return;
    }
    chatHistory = chatHistory.slice(0, idx);
    redrawLog();
    await processUserMessage(newText);
  };

  const cancelEdit = () => {
    bubble.style.display = "block";
    editContainer.remove();
  };
  cancelBtn.onclick = cancelEdit;

  btnContainer.appendChild(cancelBtn);
  btnContainer.appendChild(saveBtn);
  editContainer.appendChild(textarea);
  editContainer.appendChild(btnContainer);
  bubble.parentElement?.appendChild(editContainer);
  textarea.focus();
};

(window as any).deleteMsg = async (idx: number) => {
  if (isProcessing) return;
  const yes = await ask(t("aiChat.dialog.deleteConfirmMsg"), {
    title: t("aiChat.dialog.deleteConfirmTitle"),
    kind: "warning",
  });
  if (!yes) return;
  chatHistory = chatHistory.slice(0, idx);
  redrawLog();
};

(window as any).regenMsg = async (idx: number) => {
  if (isProcessing) return;
  chatHistory = chatHistory.slice(0, idx);
  redrawLog();
  setUiLocked(true);
  chatHistory.push({ role: "assistant", content: "..." });
  addMessageToLog("assistant", "...", chatHistory.length - 1);
  await applySdLinkSystemPrompt();
  const isWebSearchActive = document
    .getElementById("web-search")
    ?.classList.contains("enabled");

  if (isWebSearchActive) {
    // --- 🌐 Rig (Rust) エージェントモード ---
    await runWebAgentViaRust();
  } else {
    // --- 💬 既存のストリーミングモード ---
    const historyToSend = chatHistory.slice(0, -1);
    await aiChat.sendMessage(historyToSend);
  }
};

(window as any).copyMsg = async (idx: number) => {
  const content = chatHistory[idx].content;
  await writeText(content);
  showNotification(t("aiChat.notification.copied"));
};

init();

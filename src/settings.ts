// src/settings.ts
import { Store } from "@tauri-apps/plugin-store";
import { applyTranslationsToDOM, initI18n, t } from "./i18n";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { type } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import Picker from "vanilla-picker";
// CSSのインポート
import "./settings.css";

async function setupSettings() {
  try {
  // --- 0. タブ切り替えロジック ---
      const tabs = document.querySelectorAll(".tab-btn");
      const contents = document.querySelectorAll(".tab-content");
      const updateStatusMsg = document.getElementById("update-status-msg");

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          // 全て非アクティブ化
          tabs.forEach((t) => t.classList.remove("active"));
          contents.forEach((c) => c.classList.remove("active"));

          // クリックされたものをアクティブ化
          tab.classList.add("active");
          const targetId = tab.getAttribute("data-tab");
          if (targetId) {
            document.getElementById(targetId)?.classList.add("active");
          }

          // タブを切り替えたらステータスメッセージをクリア
          if (updateStatusMsg) {
            updateStatusMsg.textContent = "";
          }
        });
      });
    // --- 1. OSごとの見た目調整 ---
    const wrapper = document.querySelector("#settings-wrapper") as HTMLElement;
    const body = document.querySelector("body") as HTMLElement;
    // Linuxでの外部ツール連携を試験的に復活
    // const st = document.querySelector('#silly-tavern-group') as HTMLElement;
    // const sd = document.querySelector('#sd-group') as HTMLElement;
    const md = document.querySelector("#markdown-group") as HTMLElement;
    const osType = type();
    if (osType !== "macos") {
      wrapper.style.backgroundImage =
        "radial-gradient(circle, #bdd6daff, grey)";
      body.style.backgroundColor = "silver";
    }
    if (osType === "linux") {
      // st.style.display = 'none';
      // sd.style.display = 'none';
      md.style.display = "none";
    }

    // --- 2. Storeのロード ---
    const store = await Store.load(".settings.dat");

    // --- 3. UI要素の取得 ---
    const widthInput = document.querySelector(
      "#editor-width-input",
    ) as HTMLInputElement;
    const editorPaddingXInput = document.querySelector(
      "#editor-padding-x",
    ) as HTMLInputElement;
    const heightInput = document.querySelector(
      "#line-height-input",
    ) as HTMLInputElement;
    const lineBreakSelect = document.querySelector(
      "#line-break-select",
    ) as HTMLSelectElement;
    const appLanguageSelect = document.querySelector(
      "#app-language",
    ) as HTMLSelectElement;

    const bgPathDisplay = document.querySelector(
      "#current-bg-image-path",
    ) as HTMLElement;
    const bgmPathDisplay = document.querySelector(
      "#current-bgm-path",
    ) as HTMLElement;

    const applyBtn = document.querySelector(
      "#save-settings-btn",
    ) as HTMLButtonElement;
    const closeBtn = document.querySelector(
      "#settings-btn-close",
    ) as HTMLButtonElement;

    const wordBreakSelect = document.querySelector(
      "#word-break-select",
    ) as HTMLSelectElement;

    const fontSelect = document.querySelector(
      "#font-family-select",
    ) as HTMLSelectElement;

    const alignSelect = document.querySelector(
      "#editor-align-select",
    ) as HTMLSelectElement;
    const blurRange = document.querySelector(
      "#editor-blur-range",
    ) as HTMLInputElement;
    const blurVal = document.querySelector("#blur-val");
    const inputTextColor = document.querySelector(
      "#input-text-color",
    ) as HTMLInputElement;
    const pickerTextColor = document.querySelector(
      "#picker-text-color",
    ) as HTMLElement;
    const inputUiTextColor = document.querySelector(
      "#input-ui-text-color",
    ) as HTMLInputElement;
    const pickerUiTextColor = document.querySelector(
      "#picker-ui-text-color",
    ) as HTMLElement;
    const inputEditorBg = document.querySelector(
      "#input-editor-bg",
    ) as HTMLInputElement;
    const pickerEditorBg = document.querySelector(
      "#picker-editor-bg",
    ) as HTMLElement;
    const inputWindowBg = document.querySelector(
      "#input-window-bg",
    ) as HTMLInputElement;
    const pickerWindowBg = document.querySelector(
      "#picker-window-bg",
    ) as HTMLElement;
    const inputSelectionColor = document.querySelector(
      "#input-selection-color",
    ) as HTMLInputElement;
    const pickerSelectionColor = document.querySelector(
      "#picker-selection-color",
    ) as HTMLElement;
    const inputScrollbarColor = document.querySelector(
      "#input-scrollbar-color",
    ) as HTMLInputElement;
    const pickerScrollbarColor = document.querySelector(
      "#picker-scrollbar-color",
    ) as HTMLElement;
    const inputHeadingColor = document.querySelector(
      "#input-heading-color",
    ) as HTMLInputElement;
    const pickerHeadingColor = document.querySelector(
      "#picker-heading-color",
    ) as HTMLElement;
    const checkEnableGlow = document.querySelector(
      "#check-enable-glow",
    ) as HTMLInputElement;
    const inputGlowColor = document.querySelector(
      "#input-glow-color",
    ) as HTMLInputElement;
    const pickerGlowColor = document.querySelector(
      "#picker-glow-color",
    ) as HTMLElement;
    const inputGlowRadius = document.querySelector(
      "#input-glow-radius",
    ) as HTMLInputElement;
    const glowRadiusVal = document.querySelector(
      "#glow-radius-val",
    ) as HTMLElement;
    const useUiBgCheck = document.querySelector(
      "#use-ui-bg",
    ) as HTMLInputElement;
    const pandocPath = document.querySelector(
      "#pandoc-path",
    ) as HTMLInputElement;
    const sillyTavernPath = document.querySelector(
      "#silly-tavern-path",
    ) as HTMLInputElement;
    const sdPath = document.querySelector("#sd-path") as HTMLInputElement;
    const sdModelPath = document.querySelector(
      "#sd-model-path",
    ) as HTMLInputElement;
    const obscuraPath = document.querySelector(
      "#obscura-path",
    ) as HTMLInputElement;
    const tavilyApiKey = document.querySelector(
      "#tavily-api-key",
    ) as HTMLInputElement;
    const enableTavily = document.querySelector(
      "#enable-tavily",
    ) as HTMLInputElement;
    const imageAutoSavePath = document.querySelector(
      "#image-auto-save-path",
    ) as HTMLInputElement;
    const shellPath = document.querySelector("#shell-path") as HTMLInputElement;
    const terminalDefaultCwd = document.querySelector(
      "#terminal-cwd",
    ) as HTMLInputElement;

    // --- 3.1. UI要素の取得 (AI新規) ---
    const geminiApiKeyInput = document.querySelector(
      "#gemini-api-key",
    ) as HTMLInputElement;
    const groqApiKeyInput = document.querySelector(
      "#groq-api-key",
    ) as HTMLInputElement;
    const cerebrasApiKeyInput = document.querySelector(
      "#cerebras-api-key",
    ) as HTMLInputElement;
    const openRouterApiKeyInput = document.querySelector(
      "#openrouter-api-key",
    ) as HTMLInputElement;
    const cohereApiKeyInput = document.querySelector(
      "#cohere-api-key",
    ) as HTMLInputElement;
    const mistralApiKeyInput = document.querySelector(
      "#mistral-api-key",
    ) as HTMLInputElement;
    const mistralAgentIDInput = document.querySelector(
      "#mistral-agent-id",
    ) as HTMLInputElement;
    const geminiModelInput = document.querySelector(
      "#gemini-model",
    ) as HTMLInputElement | null;
    const groqModelInput = document.querySelector(
      "#groq-model",
    ) as HTMLInputElement;
    const cerebrasModelInput = document.querySelector(
      "#cerebras-model",
    ) as HTMLInputElement;
    const openRouterModelInput = document.querySelector(
      "#openrouter-model",
    ) as HTMLInputElement;
    const cohereModelInput = document.querySelector(
      "#cohere-model",
    ) as HTMLInputElement;
    const mistralModelInput = document.querySelector(
      "#mistral-model",
    ) as HTMLInputElement;
    const enableGroq = document.querySelector(
      "#enable-groq",
    ) as HTMLInputElement;
    const enableCerebras = document.querySelector(
      "#enable-cerebras",
    ) as HTMLInputElement;
    const enableOpenRouter = document.querySelector(
      "#enable-openrouter",
    ) as HTMLInputElement;
    const enableCohere = document.querySelector(
      "#enable-cohere",
    ) as HTMLInputElement;
    const enableAutoTcy = document.querySelector(
          "#enable-auto-tcy",
        ) as HTMLInputElement;
    const enableMistral = document.querySelector(
      "#enable-mistral",
    ) as HTMLInputElement;
    const enableMistralAgents = document.querySelector(
      "#enable-mistral-agents",
    ) as HTMLInputElement;
    const enableStTerminal = document.querySelector(
      "#enable-st-terminal",
    ) as HTMLInputElement;
    const localLlmUrlInput = document.querySelector(
      "#local-llm-url",
    ) as HTMLInputElement;
    const aiSystemPromptInput = document.querySelector(
      "#ai-system-prompt",
    ) as HTMLTextAreaElement;
    const imageSystemPromptInput = document.querySelector(
      "#image-system-prompt",
    ) as HTMLTextAreaElement;
    const imageNegativePromptInput = document.querySelector(
      "#image-negative-prompt",
    ) as HTMLTextAreaElement;
    const sdStepsInput = document.querySelector(
      "#sd-steps",
    ) as HTMLInputElement;
    const sdCfgInput = document.querySelector("#sd-cfg") as HTMLInputElement;
    const aiMaxTokensInput = document.querySelector(
      "#ai-max-tokens",
    ) as HTMLInputElement;
    const faMaxTokensInput = document.querySelector(
      "#fa-max-tokens",
    ) as HTMLInputElement;
    const aiContextLimitInput = document.querySelector(
      "#ai-context-limit",
    ) as HTMLInputElement;
    const userNameInput = document.querySelector(
      "#user-name",
    ) as HTMLInputElement;
    const userIconDisplay = document.querySelector(
      "#user-icon-path",
    ) as HTMLElement;
    const aiNameInput = document.querySelector("#ai-name") as HTMLInputElement;
    const aiIconDisplay = document.querySelector(
      "#ai-icon-path",
    ) as HTMLElement;
    const modelPresetSelect = document.querySelector(
      "#gemini-model-preset",
    ) as HTMLSelectElement;
    const groqModelPresetSelect = document.querySelector(
      "#groq-model-preset",
    ) as HTMLSelectElement;
    const cerebrasModelPresetSelect = document.querySelector(
      "#cerebras-model-preset",
    ) as HTMLSelectElement;
    const openRouterModelPresetSelect = document.querySelector(
      "#openrouter-model-preset",
    ) as HTMLSelectElement;
    const cohereModelPresetSelect = document.querySelector(
      "#cohere-model-preset",
    ) as HTMLSelectElement;
    const mistralModelPresetSelect = document.querySelector(
      "#mistral-model-preset",
    ) as HTMLSelectElement;
    const localLlmModelInput = document.querySelector(
      "#local-llm-model",
    ) as HTMLInputElement;
    const urlPresetSelect = document.querySelector(
      "#local-llm-url-preset",
    ) as HTMLSelectElement;
    const aiThinkingOverlayCheck = document.querySelector(
      "#check-ai-thinking-overlay",
    ) as HTMLInputElement;
    const visualizeAi = document.querySelector(
      "#visualize-ai",
    ) as HTMLSelectElement;
    const sdResolution = document.querySelector(
      "#sd-resolution",
    ) as HTMLSelectElement;
    const sdSampler = document.querySelector(
      "#sd-sampler",
    ) as HTMLSelectElement;
    const sdScheduler = document.querySelector(
      "#sd-scheduler",
    ) as HTMLSelectElement;

    // --- 3.2. Code Editor UI要素の取得 ---
    const codeLanguageSelect = document.querySelector(
      "#code-language-select",
    ) as HTMLSelectElement;
    const codeFontSelect = document.querySelector(
      "#code-font-family-select",
    ) as HTMLSelectElement;
    const codeFontSizeInput = document.querySelector(
      "#code-font-size-input",
    ) as HTMLInputElement;
    const checkCodeWrap = document.querySelector(
      "#code-line-wrapping",
    ) as HTMLInputElement;

    // --- 3.3. Markdown Preview UI要素の取得 ---
    const checkMdHardBreaks = document.querySelector(
      "#check-md-hard-breaks",
    ) as HTMLInputElement;

    if (!applyBtn || !closeBtn) {
      console.error("Critical UI elements not found");
      return;
    }

    // Linux固有の設定
    const checkDisableGpuCompositing = document.querySelector(
      "#disable-gpu-compositing",
    ) as HTMLInputElement;
    const editorSizeSelect = document.querySelector(
      "#main-editor-size-preset",
    ) as HTMLSelectElement;
    const checkSubWindowHalfHeight = document.querySelector(
      "#sub-window-half-height",
    ) as HTMLInputElement;


    // --- 4. 一時保存用変数 & 初期値の読み込み ---
    let pendingBgPath =
      (await store.get<string>("userBackgroundImagePath")) || null;
    let pendingBgmPath = (await store.get<string>("userBgmPath")) || null;
    let pendingUserIcon =
      (await store.get<string>("aiChatUserIconPath")) || null;
    let pendingAiIcon = (await store.get<string>("aiChatAiIconPath")) || null;

    const initWidth = await store.get<string | number>("editorMaxWidth");
    widthInput.value =
      initWidth !== null && initWidth !== undefined
        ? initWidth.toString()
        : "80";

    const initEditorPaddingX = await store.get<number>("editorPaddingX");
    if (editorPaddingXInput)
      editorPaddingXInput.value = (initEditorPaddingX ?? 10).toString();

    const initHeight = await store.get<number>("editorLineHeight");
    if (heightInput) heightInput.value = (initHeight ?? 1.6).toString();

    const initLineBreak = await store.get<string>("editorLineBreak");
    if (lineBreakSelect) lineBreakSelect.value = initLineBreak ?? "strict";

    const initAppLanguage = await store.get<string>("appLanguage");
    if (appLanguageSelect) appLanguageSelect.value = initAppLanguage ?? "ja";
    await initI18n((initAppLanguage as "ja" | "en") ?? "ja");
    applyTranslationsToDOM();
    const title: string = await invoke<string>("get_window_title", {
      windowKey: "settings",
    }).catch((): string => "");
    if (title) {
      await getCurrentWindow().setTitle(title);
    }

    appLanguageSelect?.addEventListener("change", async () => {
      const newLocale = appLanguageSelect.value as "ja" | "en";
      await store.set("appLanguage", newLocale);
      await store.save();
      await initI18n(newLocale);
      applyTranslationsToDOM();
      const newTitle: string = await invoke<string>("get_window_title", {
        windowKey: "settings",
      }).catch((): string => "");
      if (newTitle) {
        await getCurrentWindow().setTitle(newTitle);
      }
    });

    const initWordBreak = await store.get<string>("editorWordBreak");
    if (wordBreakSelect) wordBreakSelect.value = initWordBreak ?? "break-all";

    const initFontFamily = await store.get<string>("userFontFamily");
    if (fontSelect) fontSelect.value = initFontFamily ?? "default";

    const align = await store.get<string>("editorAlign");
    alignSelect.value = align ?? "center";

    const blur = (await store.get<number>("editorBlur")) ?? 0;
    blurRange.value = blur.toString();
    if (blurVal) blurVal.textContent = `${blur}px`;

    const valTextColor =
      (await store.get<string>("customTextColor")) || "#1e1e1e";
    const valUiTextColor =
      (await store.get<string>("customUiTextColor")) || "#1e1e1e";
    const valEditorBg =
      (await store.get<string>("customEditorBg")) || "rgba(255, 255, 255, 0)";
    const valWindowBg =
      (await store.get<string>("customWindowBg")) || "#eeeeee";
    const valSelectionColor =
      (await store.get<string>("customSelectionColor")) ||
      "rgba(100, 150, 250, 0.3)";
    const valScrollbarColor =
      (await store.get<string>("customScrollbarColor")) || "rgba(0, 0, 0, 0.2)";
    const valHeadingColor =
      (await store.get<string>("customHeadingColor")) || "#0550AE";
    const valEnableGlow = (await store.get<boolean>("enableGlow")) ?? false;
    const valGlowColor =
      (await store.get<string>("glowColor")) || "rgba(0, 50, 255, 0.5)";
    const valGlowRadius = (await store.get<number>("glowRadius")) ?? 5;
    checkEnableGlow.checked = valEnableGlow;

    // --- ピッカーセットアップ用ヘルパー ---
    const setupPicker = (
      previewEl: HTMLElement,
      inputEl: HTMLInputElement,
      initColor: string,
      alignment: "bottom" | "left" | "right" = "bottom",
    ) => {
      previewEl.style.backgroundColor = initColor;
      inputEl.value = initColor;

      new Picker({
        parent: previewEl,
        popup: alignment,
        alpha: true,
        color: initColor,
        editor: true,
        onDone: (color) => {
          const c = color.rgbaString;
          previewEl.style.backgroundColor = c;
          inputEl.value = c;
        },
        onChange: (color) => {
          previewEl.style.backgroundColor = color.rgbaString;
        },
      });

      // input手入力時の同期
      inputEl.addEventListener("change", () => {
        previewEl.style.backgroundColor = inputEl.value;
      });
    };

    // --- 汎用的なテキスト入力UI（promptの代わり） ---
    const showDynamicTextInput = (
      title: string,
      defaultValue: string,
    ): Promise<string | null> => {
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;backdrop-filter:blur(2px);`;
        const container = document.createElement("div");
        container.style.cssText = `background:#1a1b26;border:1px solid #7aa2f7;padding:20px;border-radius:8px;width:280px;box-shadow:0 0 20px rgba(0,0,0,0.5);color:#eee;font-family:sans-serif;`;
        container.innerHTML = `
            <div style="margin-bottom:15px;font-weight:bold;border-bottom:1px solid #555;padding-bottom:5px;">${title}</div>
            <input type="text" id="dyn-text-input" value="${defaultValue}" style="width:100%;background:rgba(0,0,0,0.3);color:inherit;border:1px solid #555;padding:5px;margin-bottom:20px;box-sizing:border-box;">
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button id="dyn-btn-cancel" style="padding:5px 12px;cursor:pointer;background:transparent;border:1px solid #888;color:#888;">Cancel</button>
                <button id="dyn-btn-ok" style="padding:5px 12px;cursor:pointer;background:transparent;border:1px solid #7aa2f7;color:#7aa2f7;">Save</button>
            </div>
        `;
        overlay.appendChild(container);
        document.body.appendChild(overlay);
        const input = overlay.querySelector(
          "#dyn-text-input",
        ) as HTMLInputElement;
        input.focus();
        input.select();
        const done = (val: string | null) => {
          document.body.removeChild(overlay);
          resolve(val);
        };
        overlay
          .querySelector("#dyn-btn-ok")
          ?.addEventListener("click", () => done(input.value.trim()));
        overlay
          .querySelector("#dyn-btn-cancel")
          ?.addEventListener("click", () => done(null));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") done(input.value.trim());
          if (e.key === "Escape") done(null);
        });
      });
    };

    // --- テーマ統合管理のメインロジック ---
    async function setupUnifiedThemes(mainStore: any) {
      const themeSelect = document.getElementById(
        "unified-theme-select",
      ) as HTMLSelectElement;
      const userGroup = document.getElementById(
        "user-themes-group",
      ) as HTMLOptGroupElement;
      const saveBtn = document.getElementById("btn-save-user-theme");
      const deleteBtn = document.getElementById("btn-delete-user-theme");
      const resetBtn = document.getElementById("btn-reset-custom");

      if (!themeSelect || !userGroup) {
        console.error("Theme elements not found! Check HTML IDs.");
        return;
      }

      const themeStore = await Store.load(".themes.dat");

      // --- 設定を一括適用・保存・通知する内部関数 ---
      const applyAndSaveTheme = async (data: any) => {
        // 1. DOM要素（入力欄）の更新
        // 左側の列など、既存の変数（inputTextColor等）がスコープ外の場合は
        // ここで再度取得するか、値をセットする共通ロジックを書く
        const setters: Record<string, string> = {
          "input-text-color": data.textColor || "#1e1e1e",
          "input-ui-text-color": data.uiColor || "#1e1e1e",
          "input-editor-bg": data.editorBg || "rgba(0,0,0,0)",
          "input-window-bg": data.windowBg || "#eeeeee",
          "input-selection-color": data.selection || "rgba(100,150,250,0.3)",
          "input-heading-color": data.heading || "#005cc5",
          "input-scrollbar-color": data.scrollbar || "rgba(0,0,0,0.2)",
          "input-glow-color": data.glowColor || "rgba(0, 255, 65, 0.5)",
          "input-glow-radius": (data.glowRadius ?? 5).toString(),
        };

        for (const [id, val] of Object.entries(setters)) {
          const el = document.getElementById(id) as HTMLInputElement;
          if (el) {
            el.value = val;
            // 隣接するカラーピッカー（preview）の色も更新
            const preview = el.previousElementSibling as HTMLElement;
            if (preview && preview.classList.contains("color-preview")) {
              preview.style.backgroundColor = val;
            }
          }
        }

        const glowCheck = document.getElementById(
          "check-enable-glow",
        ) as HTMLInputElement;
        if (glowCheck) glowCheck.checked = data.enableGlow ?? false;

        // データに指定があればそれを使う、なければ 'nothing' (画像なし) を強制
        const newBgPath = data.bgImage || "nothing";

        // UI更新 (パス表示)
        const bgPathDisplay = document.getElementById("current-bg-image-path");
        if (bgPathDisplay) {
          bgPathDisplay.textContent =
            newBgPath === "nothing" ? t("settings.bgImage.none") : newBgPath;
        }

        // 2. .settings.dat (mainStore) への保存
        // ここで渡された mainStore を使う
        await mainStore.set("customTextColor", setters["input-text-color"]);
        await mainStore.set(
          "customUiTextColor",
          setters["input-ui-text-color"],
        );
        await mainStore.set("customEditorBg", setters["input-editor-bg"]);
        await mainStore.set("customWindowBg", setters["input-window-bg"]);
        await mainStore.set(
          "customSelectionColor",
          setters["input-selection-color"],
        );
        await mainStore.set(
          "customHeadingColor",
          setters["input-heading-color"],
        );
        await mainStore.set(
          "customScrollbarColor",
          setters["input-scrollbar-color"],
        );
        await mainStore.set("enableGlow", glowCheck?.checked ?? false);
        await mainStore.set("glowColor", setters["input-glow-color"]);
        await mainStore.set(
          "glowRadius",
          parseInt(setters["input-glow-radius"]),
        );
        await mainStore.set("userBackgroundImagePath", newBgPath);

        await mainStore.save();

        pendingBgPath = newBgPath;

        // 3. メインプロセスへ通知 (emit)
        // これでエディタの見た目が即座に変わる
        await emit("settings-changed", {
          customTextColor: setters["input-text-color"],
          customUiTextColor: setters["input-ui-text-color"],
          customEditorBg: setters["input-editor-bg"],
          customWindowBg: setters["input-window-bg"],
          customSelectionColor: setters["input-selection-color"],
          customHeadingColor: setters["input-heading-color"],
          customScrollbarColor: setters["input-scrollbar-color"],
          enableGlow: glowCheck?.checked ?? false,
          glowColor: setters["input-glow-color"],
          glowRadius: parseInt(setters["input-glow-radius"]),
          userBackgroundImagePath: newBgPath,
        });
      };

      // --- リスト更新ロジック ---
      const refreshList = async () => {
        userGroup.innerHTML = "";
        const keys = await themeStore.keys();
        keys.forEach((key) => {
          const opt = document.createElement("option");
          opt.value = `user:${key}`;
          opt.textContent = key;
          userGroup.appendChild(opt);
        });
        if (keys.length === 0) {
          const opt = document.createElement("option");
          opt.textContent = "(No user themes)";
          opt.disabled = true;
          userGroup.appendChild(opt);
        }
      };

      // 保存処理
      saveBtn?.addEventListener("click", async () => {
        const themeName = await showDynamicTextInput("Theme Name", "My Theme");
        if (!themeName) return;

        // 現在の値を収集（ID指定で取得）
        const themeData = {
          textColor: (
            document.getElementById("input-text-color") as HTMLInputElement
          ).value,
          uiColor: (
            document.getElementById("input-ui-text-color") as HTMLInputElement
          ).value,
          editorBg: (
            document.getElementById("input-editor-bg") as HTMLInputElement
          ).value,
          windowBg: (
            document.getElementById("input-window-bg") as HTMLInputElement
          ).value,
          selection: (
            document.getElementById("input-selection-color") as HTMLInputElement
          ).value,
          heading: (
            document.getElementById("input-heading-color") as HTMLInputElement
          ).value,
          scrollbar: (
            document.getElementById("input-scrollbar-color") as HTMLInputElement
          ).value,
          enableGlow: (
            document.getElementById("check-enable-glow") as HTMLInputElement
          ).checked,
          glowColor: (
            document.getElementById("input-glow-color") as HTMLInputElement
          ).value,
          glowRadius: parseInt(
            (document.getElementById("input-glow-radius") as HTMLInputElement)
              .value,
            10,
          ),
          bgImage:
            (await mainStore.get("userBackgroundImagePath")) || "nothing",
        };

        await themeStore.set(themeName, themeData);
        await themeStore.save();
        await refreshList();
        themeSelect.value = `user:${themeName}`;
        alert(`Theme "${themeName}" saved.`);
      });

      // 削除処理
      deleteBtn?.addEventListener("click", async () => {
        const val = themeSelect.value;
        if (!val.startsWith("user:")) {
          alert("システムテーマは削除できません。");
          return;
        }
        const themeName = val.replace("user:", "");
        const confirmed = await ask(
          `テーマ "${themeName}" を削除してもよろしいですか？`,
          {
            title: "Confirm Delete",
            kind: "warning", // 警告アイコンを出す
            okLabel: "削除",
            cancelLabel: "キャンセル",
          },
        );
        if (!confirmed) return;
        console.log(`Deleting theme: ${themeName}`);
        await themeStore.delete(themeName);
        await themeStore.save();
        await refreshList();
        themeSelect.value = "sys:default";
        await applyAndSaveTheme(SYSTEM_PRESETS["sys:default"]);
      });

      // リセットボタン（デフォルトに戻す）
      resetBtn?.addEventListener("click", async () => {
        themeSelect.value = "sys:default";
        await applyAndSaveTheme(SYSTEM_PRESETS["sys:default"]);
        await mainStore.delete("userBackgroundImagePath");
        await mainStore.save();
        pendingBgPath = null;
        const bgPathDisplay = document.getElementById("current-bg-image-path");
        if (bgPathDisplay)
          bgPathDisplay.textContent = t("settings.bgImage.default");
        await emit("settings-changed", {
          userBackgroundImagePath: null,
        });
      });

      // 選択変更
      themeSelect.addEventListener("change", async () => {
        const val = themeSelect.value;
        if (!val) return;
        if (val.startsWith("sys:")) {
          await applyAndSaveTheme(SYSTEM_PRESETS[val]);
        } else if (val.startsWith("user:")) {
          const data = await themeStore.get<any>(val.replace("user:", ""));
          if (data) await applyAndSaveTheme(data);
        }
      });

      await refreshList();
    }

    // --- システムプリセットの定義 ---
    const SYSTEM_PRESETS: Record<string, any> = {
      "sys:default": {
        textColor: "#1e1e1e",
        uiColor: "#1e1e1e",
        editorBg: "rgba(0,0,0,0)",
        windowBg: "#eeeeee",
        selection: "rgba(100, 150, 250, 0.3)",
        heading: "#005cc5",
        scrollbar: "rgba(0, 0, 0, 0.2)",
        enableGlow: false,
        glowColor: "rgba(0, 255, 65, 0.5)",
        glowRadius: 1,
        bgImage: "nothing",
      },
      "sys:paper": {
        textColor: "#3b3b3b",
        uiColor: "#5a4632",
        editorBg: "rgba(0,0,0,0)",
        windowBg: "#f4ecd8",
        selection: "rgba(140, 100, 50, 0.2)",
        heading: "#8b4513",
        scrollbar: "rgba(90, 70, 50, 0.2)",
        enableGlow: false,
        glowColor: "rgba(0, 255, 65, 0.5)",
        glowRadius: 1,
        bgImage: "nothing",
      },
      "sys:cyber": {
        textColor: "#00ff41",
        uiColor: "#00ff41",
        editorBg: "rgba(0, 0, 0, 0)",
        windowBg: "rgba(0, 0, 0, 0.8)",
        selection: "rgba(0, 255, 65, 0.3)",
        heading: "#00ff41",
        scrollbar: "rgba(0, 255, 65, 0.2)",
        enableGlow: true,
        glowColor: "rgba(0, 255, 0, 0.5)",
        glowRadius: 2,
        bgImage: "nothing",
      },
      "sys:tokyo": {
        textColor: "#a9b1d6",
        uiColor: "#7aa2f7",
        editorBg: "rgba(0, 0, 0, 0)",
        windowBg: "rgba(26, 27, 38, 1)",
        selection: "rgba(81, 92, 126, 0.4)",
        heading: "#bb9af7",
        scrollbar: "rgba(122, 162, 247, 0.3)",
        enableGlow: false,
        glowColor: "rgba(0, 50, 255, 0.5)",
        glowRadius: 5,
        bgImage: "nothing",
      },
      "sys:depth": {
        textColor: "#8ab2f8",
        uiColor: "#7aa2f7",
        editorBg: "rgba(0, 0, 0, 0)",
        windowBg: "rgba(16, 17, 28, 0.85)",
        selection: "rgba(81, 92, 126, 0.4)",
        heading: "rgba(247,144,246,1)",
        scrollbar: "rgba(122, 162, 247, 0.3)",
        enableGlow: true,
        glowColor: "rgba(50, 100, 255, 0.8)",
        glowRadius: 5,
        bgImage: "nothing",
      },
    };

    // --- ピッカー適用 ---
    setupPicker(pickerTextColor, inputTextColor, valTextColor, "bottom");
    setupPicker(pickerUiTextColor, inputUiTextColor, valUiTextColor, "bottom");
    setupPicker(pickerEditorBg, inputEditorBg, valEditorBg, "left");
    setupPicker(pickerWindowBg, inputWindowBg, valWindowBg, "left");
    setupPicker(
      pickerSelectionColor,
      inputSelectionColor,
      valSelectionColor,
      "bottom",
    );
    setupPicker(
      pickerScrollbarColor,
      inputScrollbarColor,
      valScrollbarColor,
      "left",
    );
    setupPicker(
      pickerHeadingColor,
      inputHeadingColor,
      valHeadingColor,
      "bottom",
    );
    setupPicker(pickerGlowColor, inputGlowColor, valGlowColor, "left");

    const pandoc = (await store.get<string>("pandocPath")) ?? "";
    if (pandocPath) pandocPath.value = pandoc;

    const sillyTavern = (await store.get<string>("sillyTavernPath")) ?? "";
    if (sillyTavernPath) sillyTavernPath.value = sillyTavern;

    const stableDiffusion = (await store.get<string>("sdWebUIPath")) ?? "";
    if (sdPath) sdPath.value = stableDiffusion;

    const sdModel = (await store.get<string>("sdModelPath")) ?? "";
    if (sdModelPath) sdModelPath.value = sdModel;

    const obscura = (await store.get<string>("obscuraPath")) ?? "";
    if (obscuraPath) obscuraPath.value = obscura;

    const tavily = (await store.get<string>("tavilyApiKey")) ?? "";
    if (tavilyApiKey) tavilyApiKey.value = tavily;

    const imageAutoSave = (await store.get<string>("imageAutoSavePath")) ?? "";
    if (imageAutoSavePath) imageAutoSavePath.value = imageAutoSave;

    const shell = (await store.get<string>("shellPath")) ?? "";
    if (shellPath) shellPath.value = shell;

    const cwd = (await store.get<string>("terminalDefaultCwd")) ?? "";
    if (terminalDefaultCwd) terminalDefaultCwd.value = cwd;

    const initVisualizeAi =
      (await store.get<string>("imageGenProvider")) || "mistral";
    if (visualizeAi) visualizeAi.value = initVisualizeAi;

    const initSdResolution =
      (await store.get<string>("sdResolution")) || "512x512";
    if (sdResolution) sdResolution.value = initSdResolution;

    const initSdSampler = (await store.get<string>("sdSampler")) || "euler";
    if (sdSampler) sdSampler.value = initSdSampler;

    const initSdScheduler =
      (await store.get<string>("sdScheduler")) || "default";
    if (sdScheduler) sdScheduler.value = initSdScheduler;

    const initCodeLanguage =
      (await store.get<string>("codeLanguage")) || "html";
    if (codeLanguageSelect) codeLanguageSelect.value = initCodeLanguage;

    const initCodeFont =
      (await store.get<string>("codeFontFamily")) || "default";
    invoke<string[]>("get_system_fonts")
      .then((fonts) => {
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "default";
        defaultOpt.text = "Monospace (Default)";
        codeFontSelect.appendChild(defaultOpt);

        fonts.forEach((fontName) => {
          const opt = document.createElement("option");
          opt.value = fontName;
          opt.text = fontName;
          codeFontSelect.appendChild(opt);
        });
        codeFontSelect.value = initCodeFont;
      })
      .catch((err) => console.error("Code Font loading failed:", err));

    const initCodeSize = (await store.get<number>("codeFontSize")) || 10;
    if (codeFontSizeInput) codeFontSizeInput.value = initCodeSize.toString();

    const initCodeWrap = (await store.get<boolean>("codeLineWrap")) || false;
    if (checkCodeWrap) checkCodeWrap.checked = initCodeWrap;

    const initMdHardBreaks =
      (await store.get<boolean>("mdHardBreaks")) || false;
    if (checkMdHardBreaks) checkMdHardBreaks.checked = initMdHardBreaks;

    const isUiBg = (await store.get<boolean>("useUiBg")) ?? false;
    useUiBgCheck.checked = isUiBg;

    inputGlowRadius.value = valGlowRadius.toString();
    glowRadiusVal.textContent = `${valGlowRadius}px`;

    // スライダーの数値表示更新
    inputGlowRadius.addEventListener("input", () => {
      glowRadiusVal.textContent = `${inputGlowRadius.value}px`;
    });

    bgPathDisplay.textContent = pendingBgPath
      ? pendingBgPath.split(/[/\\]/).pop() || ""
      : t("settings.bgImage.noFile");
    bgmPathDisplay.textContent = pendingBgmPath
      ? pendingBgmPath.split(/[/\\]/).pop() || ""
      : t("settings.bgMusic.noFile");

    // AI Settings
    geminiApiKeyInput.value = (await store.get<string>("geminiApiKey")) || "";
    groqApiKeyInput.value = (await store.get<string>("groqApiKey")) || "";
    cerebrasApiKeyInput.value =
      (await store.get<string>("cerebrasApiKey")) || "";
    openRouterApiKeyInput.value =
      (await store.get<string>("openRouterApiKey")) || "";
    cohereApiKeyInput.value = (await store.get<string>("cohereApiKey")) || "";
    mistralApiKeyInput.value = (await store.get<string>("mistralApiKey")) || "";
    mistralAgentIDInput.value =
      (await store.get<string>("mistralAgentID")) || "";
    if (geminiModelInput) {
      geminiModelInput.value =
        (await store.get<string>("geminiModel")) || "gemini-3.1-flash-lite";
    }
    groqModelInput.value =
      (await store.get<string>("groqModel")) || "llama-3.3-70b-versatile";
    cerebrasModelInput.value =
      (await store.get<string>("cerebrasModel")) || "gemma-4-31b";
    openRouterModelInput.value =
      (await store.get<string>("openRouterModel")) || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
    cohereModelInput.value = (await store.get<string>("cohereModel")) || "";
    mistralModelInput.value = (await store.get<string>("mistralModel")) || "";
    enableGroq.checked = (await store.get<boolean>("enableGroq")) ?? false;
    enableCerebras.checked =
      (await store.get<boolean>("enableCerebras")) ?? false;
    enableOpenRouter.checked =
      (await store.get<boolean>("enableOpenRouter")) ?? false;
    enableTavily.checked = (await store.get<boolean>("enableTavily")) ?? false;
    enableCohere.checked = (await store.get<boolean>("enableCohere")) ?? false;
    enableAutoTcy.checked = (await store.get<boolean>("enableAutoTcy")) ?? false;
    enableMistral.checked =
      (await store.get<boolean>("enableMistral")) ?? false;
    enableMistralAgents.checked =
      (await store.get<boolean>("enableMistralAgents")) ?? false;
    enableStTerminal.checked =
      (await store.get<boolean>("enableStTerminal")) ?? false;
    localLlmUrlInput.value =
      (await store.get<string>("localLlmUrl")) ||
      "http://127.0.0.1:1234/v1/chat/completions";
    aiSystemPromptInput.value =
      (await store.get<string>("aiSystemPrompt")) || "";
    imageSystemPromptInput.value =
      (await store.get<string>("imageSystemPrompt")) || "";
    imageNegativePromptInput.value =
      (await store.get<string>("sdNegativePrompt")) || "";
    sdStepsInput.value = (
      (await store.get<number>("sdSteps")) || 20
    ).toString();
    sdCfgInput.value = (
      (await store.get<number>("sdCfgScale")) || 7.0
    ).toString();
    aiMaxTokensInput.value = (
      (await store.get<number>("aiMaxTokens")) || 2000
    ).toString();
    faMaxTokensInput.value = (
      (await store.get<number>("faMaxTokens")) || 30
    ).toString();
    aiContextLimitInput.value = (
      (await store.get<number>("aiContextLimit")) || 2000
    ).toString();
    aiThinkingOverlayCheck.checked =
      (await store.get<boolean>("showAiThinkingOverlay")) ?? true;
    userNameInput.value = (await store.get<string>("aiChatUserName")) || "User";
    localLlmModelInput.value =
      (await store.get<string>("localLlmModel")) || "local-model";
    if (pendingUserIcon)
      userIconDisplay.textContent = pendingUserIcon.split(/[/\\]/).pop() || "";
    aiNameInput.value = (await store.get<string>("aiChatAiName")) || "AI";
    if (pendingAiIcon)
      aiIconDisplay.textContent = pendingAiIcon.split(/[/\\]/).pop() || "";
    if (modelPresetSelect) {
      // 保存されている値がプルダウンの選択肢に含まれているかチェック
      const options = Array.from(modelPresetSelect.options).map((o) => o.value);
      const currentVal = geminiModelInput ? geminiModelInput.value : null;
      if (currentVal && options.includes(currentVal)) {
        modelPresetSelect.value = currentVal;
      } else {
        // 含まれていなければ「手動入力」等の空欄やデフォルト位置にする
        // (HTML側で <option value="">手動入力</option> としている場合)
        modelPresetSelect.value = "";
      }
    }
    if (groqModelPresetSelect) {
      const options = Array.from(groqModelPresetSelect.options).map(
        (o) => o.value,
      );
      if (options.includes(groqModelInput.value)) {
        groqModelPresetSelect.value = groqModelInput.value;
      } else {
        groqModelPresetSelect.value = "";
      }
    }
    if (cerebrasModelPresetSelect) {
      const options = Array.from(cerebrasModelPresetSelect.options).map(
        (o) => o.value,
      );
      if (options.includes(cerebrasModelInput.value)) {
        cerebrasModelPresetSelect.value = cerebrasModelInput.value;
      } else {
        cerebrasModelPresetSelect.value = "";
      }
    }
    if (openRouterModelPresetSelect) {
      const options = Array.from(openRouterModelPresetSelect.options).map(
        (o) => o.value,
      );
      if (options.includes(openRouterModelInput.value)) {
        openRouterModelPresetSelect.value = openRouterModelInput.value;
      } else {
        openRouterModelPresetSelect.value = "";
      }
    }
    if (cohereModelPresetSelect) {
      const options = Array.from(cohereModelPresetSelect.options).map(
        (o) => o.value,
      );
      if (options.includes(cohereModelInput.value)) {
        cohereModelPresetSelect.value = cohereModelInput.value;
      } else {
        cohereModelPresetSelect.value = "";
      }
    }
    if (mistralModelPresetSelect) {
      const options = Array.from(mistralModelPresetSelect.options).map(
        (o) => o.value,
      );
      if (options.includes(mistralModelInput.value)) {
        mistralModelPresetSelect.value = mistralModelInput.value;
      } else {
        mistralModelPresetSelect.value = "";
      }
    }
    if (urlPresetSelect) {
      const options = Array.from(urlPresetSelect.options).map((o) => o.value);
      if (options.includes(localLlmUrlInput.value)) {
        urlPresetSelect.value = localLlmUrlInput.value;
      } else {
        urlPresetSelect.value = ""; // カスタムURLの場合は選択解除
      }
    }

    if (checkDisableGpuCompositing) {
      checkDisableGpuCompositing.checked = (await store.get<boolean>("disableGpuCompositing")) ?? false;
    }
    if (editorSizeSelect) {
      editorSizeSelect.value = (await store.get<string>("mainEditorSizePreset")) ?? "default";
    }
    if (checkSubWindowHalfHeight) {
      checkSubWindowHalfHeight.checked = (await store.get<boolean>("subWindowHalfHeight")) ?? false;
    }

    // --- 5. イベントリスナー (ファイル選択) ---

    document
      .querySelector("#btn-select-bg-image")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.bgImage.selectTitle"),
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "gif", "webp"],
            },
          ],
        });

        if (path && typeof path === "string") {
          // 即座に保存
          pendingBgPath = path;
          await store.set("userBackgroundImagePath", path);
          await store.save();

          // 表示更新
          bgPathDisplay.textContent = path.split(/[/\\]/).pop() || path;

          // 即座に通知
          await emit("settings-changed", { userBackgroundImagePath: path });
        }
      });

    document
      .querySelector("#btn-clear-bg-image")
      ?.addEventListener("click", async () => {
        pendingBgPath = null;
        await store.delete("userBackgroundImagePath"); // 削除して保存
        await store.save();

        bgPathDisplay.textContent = t("settings.bgImage.default");

        // nullを通知してデフォルトに戻させる
        await emit("settings-changed", { userBackgroundImagePath: null });
      });

    document
      .querySelector("#btn-none-bg-image")
      ?.addEventListener("click", async () => {
        pendingBgPath = "nothing";
        await store.set("userBackgroundImagePath", "nothing");
        await store.save();
        bgPathDisplay.textContent = t("settings.bgImage.none");
        await emit("settings-changed", { userBackgroundImagePath: "nothing" });
      });

    document
      .querySelector("#btn-select-bgm")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.bgMusic.selectTitle"),
          filters: [{ name: "Audio", extensions: ["mp3", "wav", "ogg"] }],
        });

        if (path && typeof path === "string") {
          // 即座に保存
          pendingBgmPath = path;
          await store.set("userBgmPath", path);
          await store.save();

          bgmPathDisplay.textContent = path.split(/[/\\]/).pop() || path;

          // 即座に通知
          await emit("settings-changed", { userBgmPath: path });
        }
      });

    document
      .querySelector("#btn-clear-bgm")
      ?.addEventListener("click", async () => {
        pendingBgmPath = null;
        await store.delete("userBgmPath");
        await store.save();

        bgmPathDisplay.textContent = t("settings.bgMusic.default");

        // nullを通知
        await emit("settings-changed", { userBgmPath: null });
      });

    document
      .querySelector("#btn-select-pandoc")
      ?.addEventListener("click", async () => {
        const osType = type();
        const extensions = osType === "windows" ? ["exe"] : [""];
        const path = await open({
          filters: [{ name: "Executables", extensions: extensions }],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#pandoc-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-cwd")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.terminal.selectDirTitle"),
          directory: true,
          properties: ["openDirectory"],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#terminal-cwd",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-silly-tavern")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.terminal.selectDirTitle"),
          directory: true,
          properties: ["openDirectory"],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#silly-tavern-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-sd")
      ?.addEventListener("click", async () => {
        const osType = type();

        const options: any = {
          title: t("settings.terminal.selectDirTitle"),
        };
        if (osType === "windows") {
          options.filters = [
            { name: "Executables", extensions: ["bat", "exe"] },
          ];
        } else {
        }
        const path = await open(options);

        if (path && typeof path === "string") {
          const input = document.querySelector("#sd-path") as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-sd-model")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.terminal.selectDirTitle"),
          filters: [
            { name: "Executables", extensions: ["safetensors", "gguf"] },
          ],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#sd-model-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-obscura")
      ?.addEventListener("click", async () => {
        const osType = type();

        const options: any = {
          title: t("settings.terminal.selectDirTitle"),
        };
        if (osType === "windows") {
          options.filters = [
            { name: "Executables", extensions: ["bat", "exe"] },
          ];
        } else {
        }
        const path = await open(options);

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#obscura-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-auto-save")
      ?.addEventListener("click", async () => {
        const path = await open({
          title: t("settings.terminal.selectDirTitle"),
          directory: true,
          properties: ["openDirectory"],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#image-auto-save-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    document
      .querySelector("#btn-select-shell")
      ?.addEventListener("click", async () => {
        const osType = type();
        const extensions = osType === "windows" ? ["exe"] : [""];
        const path = await open({
          title: t("settings.terminal.selectShellTitle"),
          filters: [{ name: "Executables", extensions: extensions }],
        });

        if (path && typeof path === "string") {
          const input = document.querySelector(
            "#shell-path",
          ) as HTMLInputElement;
          if (input) input.value = path;
        }
      });

    // User Icon
    document
      .querySelector("#btn-select-user-icon")
      ?.addEventListener("click", async () => {
        const path = await open({
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "webp", "gif"],
            },
          ],
        });
        if (path && typeof path === "string") {
          pendingUserIcon = path;
          userIconDisplay.textContent = path.split(/[/\\]/).pop() || path;
        }
      });
    document
      .querySelector("#btn-clear-user-icon")
      ?.addEventListener("click", () => {
        pendingUserIcon = null;
        userIconDisplay.textContent = "(Default)";
      });

    // AI Icon
    document
      .querySelector("#btn-select-ai-icon")
      ?.addEventListener("click", async () => {
        const path = await open({
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "webp", "gif"],
            },
          ],
        });
        if (path && typeof path === "string") {
          pendingAiIcon = path;
          aiIconDisplay.textContent = path.split(/[/\\]/).pop() || path;
        }
      });
    document
      .querySelector("#btn-clear-ai-icon")
      ?.addEventListener("click", () => {
        pendingAiIcon = null;
        aiIconDisplay.textContent = "(Default)";
      });

    blurRange.addEventListener("input", () => {
      if (blurVal) blurVal.textContent = `${blurRange.value}px`;
    });

    // --- 5. フォントセレクト ---

    // 現在の設定値を読み込み
    const currentFont =
      (await store.get<string>("userFontFamily")) || "default";

    // 非同期でシステムフォントを取得してリスト生成
    invoke<string[]>("get_system_fonts")
      .then((fonts) => {
        // デフォルト選択肢
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "default";
        defaultOpt.text = t("settings.font.defaultOption");
        fontSelect.appendChild(defaultOpt);

        // システムフォント
        fonts.forEach((fontName) => {
          const opt = document.createElement("option");
          opt.value = fontName;
          opt.text = fontName;
          fontSelect.appendChild(opt);
        });

        // 値をセット
        fontSelect.value = currentFont;
      })
      .catch((err) => console.error("Font loading failed:", err));

    // --- 6. 適用ボタン (保存・通知・閉じる) ---
    applyBtn.addEventListener("click", async () => {
      try {
        const rawValue = parseInt(widthInput.value, 10);
        // NaNかチェックし、NaNでなければその値を、NaNならデフォルトを使う
        const numValue = isNaN(rawValue) ? 80 : rawValue;
        const rawPaddingX = parseInt(editorPaddingXInput.value, 10);
        const newPaddingX = isNaN(rawPaddingX) ? 10 : rawPaddingX;
        const newHeight = parseFloat(heightInput.value);
        const newLineBreak = lineBreakSelect.value;
        const newAppLanguage = appLanguageSelect.value;
        const newWordBreak = wordBreakSelect.value;
        const fontSelect = document.querySelector(
          "#font-family-select",
        ) as HTMLSelectElement;
        const newUserFont = fontSelect ? fontSelect.value : "default";
        console.log("Applying Font:", newUserFont);
        const newAlign = alignSelect.value;
        const newPandocPath = pandocPath.value;
        const newSillyTavernPath = sillyTavernPath.value;
        const newSDPath = sdPath.value;
        const newSDModelPath = sdModelPath.value;
        const newObscuraPath = obscuraPath.value;
        const newTavilyApiKey = tavilyApiKey.value;
        const newImageAutoSavePath = imageAutoSavePath.value;
        const newShellPath = shellPath.value;
        const newTerminalDefaultCwd = terminalDefaultCwd.value;
        const newVisualizeAi = visualizeAi.value;
        const newSdResolution = sdResolution.value;
        const newSdSampler = sdSampler.value;
        const newSdScheduler = sdScheduler.value;
        const newCodeLanguage = codeLanguageSelect.value;
        const newCodeFont = codeFontSelect.value;
        console.log("Applying Code Font:", newCodeFont);
        const newCodeWrap = checkCodeWrap.checked;
        const newMdHardBreaks = checkMdHardBreaks.checked;
        const newCodeSize = parseInt(codeFontSizeInput.value, 10) || 10;
        const newBlur = parseInt(blurRange.value, 10);

        const newTextColor = inputTextColor.value;
        const newUiTextColor = inputUiTextColor.value;
        const newEditorBg = inputEditorBg.value;
        const newWindowBg = inputWindowBg.value;
        const newSelectionColor = inputSelectionColor.value;
        const newScrollbarColor = inputScrollbarColor.value;
        const newHeadingColor = inputHeadingColor.value;

        const newUseUiBg = useUiBgCheck.checked;

        // AI Params
        const newGeminiApiKey = geminiApiKeyInput.value.trim();
        const newGroqApiKey = groqApiKeyInput.value.trim();
        const newCerebrasApiKey = cerebrasApiKeyInput.value.trim();
        const newOpenRouterApiKey = openRouterApiKeyInput.value.trim();
        const newCohereApiKey = cohereApiKeyInput.value.trim();
        const newMistralApiKey = mistralApiKeyInput.value.trim();
        const newMistralAgentID = mistralAgentIDInput.value.trim();
        const newGeminiModel = geminiModelInput
          ? geminiModelInput.value.trim()
          : "";
        const newGroqModel = groqModelInput.value.trim();
        const newCerebrasModel = cerebrasModelInput.value.trim();
        const newOpenRouterModel = openRouterModelInput.value.trim();
        const newCohereModel = cohereModelInput.value.trim();
        const newMistralModel = mistralModelInput.value.trim();
        const newEnableGroq = enableGroq.checked;
        const newEnableCerebras = enableCerebras.checked;
        const newEnableOpenRouter = enableOpenRouter.checked;
        const newEnableTavily = enableTavily.checked;
        const newEnableCohere = enableCohere.checked;
        const newEnableAutoTcy = enableAutoTcy.checked;
        const newEnableMistral = enableMistral.checked;
        const newEnableMistralAgents = enableMistralAgents.checked;
        const newEnableStTerminal = enableStTerminal.checked;
        const newLocalUrl = localLlmUrlInput.value.trim();
        const newSystemPrompt = aiSystemPromptInput.value;
        const newImageSystemPrompt = imageSystemPromptInput.value;
        const newImageNegativePrompt = imageNegativePromptInput.value;
        const newSdSteps = parseInt(sdStepsInput.value, 10) || 20;
        const newSdCfg = parseInt(sdCfgInput.value, 10) || 7.0;
        const newAiMaxTokens = parseInt(aiMaxTokensInput.value, 10) || 2000;
        const newFaMaxTokens = parseInt(faMaxTokensInput.value, 10) || 30;
        const newAiContextLimit =
          parseInt(aiContextLimitInput.value, 10) || 2000;
        const newLocalModel = localLlmModelInput.value.trim();
        const newAiThinkingOverlay = aiThinkingOverlayCheck.checked;
        const newDisableGpuCompositing = checkDisableGpuCompositing?.checked;
        const newEditorSizePreset = editorSizeSelect?.value;
        const newSubWindowHalfHeight = checkSubWindowHalfHeight?.checked;

        // Storeに保存
        await store.set("editorMaxWidth", numValue.toString());
        await store.set("editorPaddingX", newPaddingX);
        await store.set("editorLineHeight", newHeight);
        await store.set("editorLineBreak", newLineBreak);
        await store.set("appLanguage", newAppLanguage);
        await store.set("editorWordBreak", newWordBreak);
        await store.set("userFontFamily", newUserFont);
        await store.set("editorAlign", newAlign);
        await store.set("editorBlur", newBlur);
        await store.set("pandocPath", newPandocPath);
        await store.set("sillyTavernPath", newSillyTavernPath);
        await store.set("sdWebUIPath", newSDPath);
        await store.set("sdModelPath", newSDModelPath);
        await store.set("obscuraPath", newObscuraPath);
        await store.set("tavilyApiKey", newTavilyApiKey);
        await store.set("imageAutoSavePath", newImageAutoSavePath);
        await store.set("shellPath", newShellPath);
        await store.set("terminalDefaultCwd", newTerminalDefaultCwd);
        await store.set("imageGenProvider", newVisualizeAi);
        await store.set("sdResolution", newSdResolution);
        await store.set("sdSampler", newSdSampler);
        await store.set("sdScheduler", newSdScheduler);
        await store.set("codeLanguage", newCodeLanguage);
        await store.set("codeFontFamily", newCodeFont);
        await store.set("codeFontSize", newCodeSize);
        await store.set("codeLineWrap", newCodeWrap);
        await store.set("mdHardBreaks", newMdHardBreaks);
        await store.set("customTextColor", newTextColor);
        await store.set("customUiTextColor", newUiTextColor);
        await store.set("customEditorBg", newEditorBg);
        await store.set("customWindowBg", newWindowBg);
        await store.set("customSelectionColor", newSelectionColor);
        await store.set("customScrollbarColor", newScrollbarColor);
        await store.set("customHeadingColor", newHeadingColor);
        await store.set("useUiBg", newUseUiBg);
        await store.set("enableGlow", checkEnableGlow.checked);
        await store.set("glowColor", inputGlowColor.value);
        await store.set("glowRadius", parseInt(inputGlowRadius.value));

        // AI設定の保存
        if (newGeminiApiKey) await store.set("geminiApiKey", newGeminiApiKey);
        await store.set("geminiModel", newGeminiModel);
        if (newGroqApiKey) await store.set("groqApiKey", newGroqApiKey);
        if (newCerebrasApiKey)
          await store.set("cerebrasApiKey", newCerebrasApiKey);
        if (newOpenRouterApiKey)
          await store.set("openRouterApiKey", newOpenRouterApiKey);
        if (newCohereApiKey) await store.set("cohereApiKey", newCohereApiKey);
        if (newMistralApiKey)
          await store.set("mistralApiKey", newMistralApiKey);
        if (newMistralAgentID)
          await store.set("mistralAgentID", newMistralAgentID);
        await store.set("groqModel", newGroqModel);
        await store.set("cerebrasModel", newCerebrasModel);
        await store.set("openRouterModel", newOpenRouterModel);
        await store.set("cohereModel", newCohereModel);
        await store.set("mistralModel", newMistralModel);
        await store.set("enableGroq", newEnableGroq);
        await store.set("enableCerebras", newEnableCerebras);
        await store.set("enableOpenRouter", newEnableOpenRouter);
        await store.set("enableTavily", newEnableTavily);
        await store.set("enableCohere", newEnableCohere);
        await store.set("enableAutoTcy", newEnableAutoTcy);
        await store.set("enableMistral", newEnableMistral);
        await store.set("enableMistralAgents", newEnableMistralAgents);
        await store.set("enableStTerminal", newEnableStTerminal);
        await store.set("localLlmUrl", newLocalUrl);
        await store.set("aiSystemPrompt", newSystemPrompt);
        await store.set("imageSystemPrompt", newImageSystemPrompt);
        await store.set("sdNegativePrompt", newImageNegativePrompt);
        const currentApiType = await store.get<string>("selectedApiType");
        if (!currentApiType) {
          await store.set("selectedApiType", "gemini");
        }
        await store.set("sdSteps", newSdSteps);
        await store.set("sdCfgScale", newSdCfg);
        await store.set("aiMaxTokens", newAiMaxTokens);
        await store.set("faMaxTokens", newFaMaxTokens);
        await store.set("aiContextLimit", newAiContextLimit);
        await store.set("showAiThinkingOverlay", newAiThinkingOverlay);
        // User Profile
        await store.set("aiChatUserName", userNameInput.value || "User");
        if (pendingUserIcon)
          await store.set("aiChatUserIconPath", pendingUserIcon);
        else await store.delete("aiChatUserIconPath");
        // AI Profile
        await store.set("aiChatAiName", aiNameInput.value || "AI");
        if (pendingAiIcon) await store.set("aiChatAiIconPath", pendingAiIcon);
        else await store.delete("aiChatAiIconPath");
        await store.set("localLlmModel", newLocalModel);

        await store.set("useUiBg", newUseUiBg);

        if (pendingBgPath)
          await store.set("userBackgroundImagePath", pendingBgPath);
        else await store.delete("userBackgroundImagePath");

        if (pendingBgmPath) await store.set("userBgmPath", pendingBgmPath);
        else await store.delete("userBgmPath");

        if (newDisableGpuCompositing !== undefined)
          await store.set("disableGpuCompositing", newDisableGpuCompositing);
        if (newEditorSizePreset !== undefined) {
          await store.set("mainEditorSizePreset", newEditorSizePreset);
          // Niri環境なら「適用」を押した瞬間に即座にリアルタイムリサイズを実行！
          try {
            await invoke("apply_niri_size_preset", { preset: newEditorSizePreset });
        } catch (e) {
          console.error("Niri resize failed:", e);
          }
        }
        if (newSubWindowHalfHeight !== undefined)
          await store.set("subWindowHalfHeight", newSubWindowHalfHeight);


        await store.save();

        // メインウィンドウに通知
        await emit("settings-changed", {
          editorMaxWidth: numValue,
          editorPaddingX: newPaddingX,
          editorLineHeight: newHeight,
          editorLineBreak: newLineBreak,
          appLanguage: newAppLanguage,
          userBackgroundImagePath: pendingBgPath,
          userBgmPath: pendingBgmPath,
          editorWordBreak: newWordBreak,
          userFontFamily: newUserFont,
          editorAlign: newAlign,
          editorBlur: newBlur,
          useUiBg: newUseUiBg,
          pandocPath: newPandocPath,
          sillyTavernPath: newSillyTavernPath,
          sdWebUIPath: newSDPath,
          sdModelPath: newSDModelPath,
          obscuraPath: newObscuraPath,
          tavilyApiKey: newTavilyApiKey,
          imageAutoSavePath: newImageAutoSavePath,
          shellPath: newShellPath,
          terminalDefaultCwd: newTerminalDefaultCwd,
          geminiApiKey: newGeminiApiKey,
          groqApiKey: newGroqApiKey,
          cerebrasApiKey: newCerebrasApiKey,
          openRouterApiKey: newOpenRouterApiKey,
          cohereApiKey: newCohereApiKey,
          mistralApiKey: newMistralApiKey,
          mistralAgentID: newMistralAgentID,
          geminiModel: newGeminiModel,
          groqModel: newGroqModel,
          cerebrasModel: newCerebrasModel,
          openRouterModel: newOpenRouterModel,
          cohereModel: newCohereModel,
          mistralModel: newMistralModel,
          enableGroq: newEnableGroq,
          enableCerebras: newEnableCerebras,
          enableOpenRouter: newEnableOpenRouter,
          enableTavily: newEnableTavily,
          enableCohere: newEnableCohere,
          enableAutoTcy: newEnableAutoTcy,
          enableMistral: newEnableMistral,
          enableMistralAgents: newEnableMistralAgents,
          enableStTerminal: newEnableStTerminal,
          localLlmUrl: newLocalUrl,
          aiSystemPrompt: newSystemPrompt,
          imageSystemPrompt: newImageSystemPrompt,
          sdNegativePrompt: newImageNegativePrompt,
          selectedApiType: currentApiType || "gemini",
          aiMaxTokens: newAiMaxTokens,
          sdSteps: newSdSteps,
          sdCfgScale: newSdCfg,
          faMaxTokens: newFaMaxTokens,
          aiContextLimit: newAiContextLimit,
          aiChatUserName: userNameInput.value || "User",
          aiChatUserIconPath: pendingUserIcon,
          aiChatAiName: aiNameInput.value || "AI",
          aiChatAiIconPath: pendingAiIcon,
          localLlmModel: newLocalModel,
          imageGenProvider: newVisualizeAi,
          sdResolution: newSdResolution,
          sdSampler: newSdSampler,
          sdScheduler: newSdScheduler,
          codeLanguage: newCodeLanguage,
          codeFontFamily: newCodeFont,
          codeFontSize: newCodeSize,
          codeLineWrap: newCodeWrap,
          mdHardBreaks: newMdHardBreaks,
          customTextColor: newTextColor,
          customUiTextColor: newUiTextColor,
          customEditorBg: newEditorBg,
          customWindowBg: newWindowBg,
          customSelectionColor: newSelectionColor,
          customScrollbarColor: newScrollbarColor,
          customHeadingColor: newHeadingColor,
          enableGlow: checkEnableGlow.checked,
          glowColor: inputGlowColor.value,
          glowRadius: parseInt(inputGlowRadius.value),
          showAiThinkingOverlay: newAiThinkingOverlay,
        });
        await initI18n(newAppLanguage as "ja" | "en");
        applyTranslationsToDOM();
        const title: string = await invoke<string>("get_window_title", {
          windowKey: "settings",
        }).catch((): string => "");
        if (title) {
          await getCurrentWindow().setTitle(title);
        }
      } catch (err) {
        alert(`設定の保存に失敗しました: ${err}`);
      }
    });

    // --- 7. 閉じるボタン & ショートカット ---
    const hideWindow = async () => {
      await getCurrentWindow().close();
    };

    closeBtn.addEventListener("click", hideWindow);

    document.addEventListener("keydown", (e) => {
      const isShift = e.shiftKey;
      const key = e.key.toLowerCase();
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (isCtrlOrCmd && key === "f" && !isShift) {
        e.preventDefault();
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

      if (isCtrlOrCmd && key === "r") {
        e.preventDefault();
      }
      if (isCtrlOrCmd && key === "r" && isShift) {
        e.preventDefault();
      }
    });

    await setupUnifiedThemes(store);

    // --- 右クリックメニューの無効化 ---
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });

    // バージョン比較のヘルパー (例: "1.12.0" < "1.13.0")
    function isNewerVersion(current: string, latest: string): boolean {
      const c = current.split(".").map(Number);
      const l = latest.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((l[i] || 0) > (c[i] || 0)) return true;
        if ((l[i] || 0) < (c[i] || 0)) return false;
      }
      return false;
    }

    // アップデート確認処理
    async function setupAboutTab() {
      const versionEl = document.getElementById("current-app-version");
      const checkBtn = document.getElementById("btn-check-update");
      const statusEl = document.getElementById("update-status-msg");

      // Tauriアプリの package.json から現在のバージョンを取得して表示
      const currentVersion = await getVersion();
      if (versionEl) versionEl.textContent = `v${currentVersion}`;

      checkBtn?.addEventListener("click", async () => {
        if (statusEl) statusEl.textContent = t("settings.about.updateChecking");

        try {
          const res = await fetch("https://api.github.com/repos/DroicheadNua/MirrorShard_2/releases/latest");
          if (!res.ok) throw new Error("API error");

          const data = await res.json();
          const latestTag = data.tag_name || ""; // 例: "v1.13.0"
          const latestVersion = latestTag.replace(/^v/, "");

          if (isNewerVersion(currentVersion, latestVersion)) {
            if (statusEl) {
              const msg = t("settings.about.updateAvailable", { version: latestTag });
              const linkText = t("settings.about.downloadLink");

              statusEl.innerHTML = `${msg} <a href="#" id="link-download">${linkText}</a>`;

              document.getElementById("link-download")?.addEventListener("click", (e) => {
                e.preventDefault();
                open(data.html_url);
              });
            }
          } else {
            if (statusEl) statusEl.textContent = t("settings.about.updateNotAvailable");
          }
        } catch (e) {
          if (statusEl) statusEl.textContent = t("settings.about.updateError");
          console.error("Update check failed:", e);
        }
      });
    }

    await setupAboutTab();

  } catch (error) {
    // スクリプト全体のエラーをキャッチ
    alert(`設定画面のエラー: ${error}`);
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", setupSettings);

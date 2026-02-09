// src/settings.ts
import { Store } from '@tauri-apps/plugin-store';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { type } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import Picker from 'vanilla-picker';
// CSSのインポート
import './settings.css';

async function setupSettings() {
    try {
        // --- 0. タブ切り替えロジック ---
        const tabs = document.querySelectorAll('.tab-btn');
        const contents = document.querySelectorAll('.tab-content');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // 全て非アクティブ化
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));

                // クリックされたものをアクティブ化
                tab.classList.add('active');
                const targetId = tab.getAttribute('data-tab');
                if (targetId) {
                    document.getElementById(targetId)?.classList.add('active');
                }
            });
        });
        // --- 1. OSごとの見た目調整 ---
        const wrapper = document.querySelector('#settings-wrapper') as HTMLElement;
        const body = document.querySelector('body') as HTMLElement;
        const osType = await type();
        if (osType !== 'macos') {
            wrapper.style.backgroundImage = 'radial-gradient(circle, #bdd6daff, grey)';
            body.style.backgroundColor = 'silver';
        }

        // --- 2. Storeのロード ---
        const store = await Store.load('.settings.dat');

        // --- 3. UI要素の取得 ---
        const widthInput = document.querySelector('#editor-width-input') as HTMLInputElement;
        const editorPaddingXInput = document.querySelector('#editor-padding-x') as HTMLInputElement;
        const heightInput = document.querySelector('#line-height-input') as HTMLInputElement;
        const lineBreakSelect = document.querySelector('#line-break-select') as HTMLSelectElement;

        const bgPathDisplay = document.querySelector('#current-bg-image-path') as HTMLElement;
        const bgmPathDisplay = document.querySelector('#current-bgm-path') as HTMLElement;

        const applyBtn = document.querySelector('#save-settings-btn') as HTMLButtonElement;
        const closeBtn = document.querySelector('#settings-btn-close') as HTMLButtonElement;

        const wordBreakSelect = document.querySelector('#word-break-select') as HTMLSelectElement;

        const fontSelect = document.querySelector('#font-family-select') as HTMLSelectElement;

        const alignSelect = document.querySelector('#editor-align-select') as HTMLSelectElement;
        const blurRange = document.querySelector('#editor-blur-range') as HTMLInputElement;
        const blurVal = document.querySelector('#blur-val');
        const inputTextColor = document.querySelector('#input-text-color') as HTMLInputElement;
        const pickerTextColor = document.querySelector('#picker-text-color') as HTMLElement;
        const inputUiTextColor = document.querySelector('#input-ui-text-color') as HTMLInputElement;
        const pickerUiTextColor = document.querySelector('#picker-ui-text-color') as HTMLElement;
        const inputEditorBg = document.querySelector('#input-editor-bg') as HTMLInputElement;
        const pickerEditorBg = document.querySelector('#picker-editor-bg') as HTMLElement;
        const inputWindowBg = document.querySelector('#input-window-bg') as HTMLInputElement;
        const pickerWindowBg = document.querySelector('#picker-window-bg') as HTMLElement;
        const inputSelectionColor = document.querySelector('#input-selection-color') as HTMLInputElement;
        const pickerSelectionColor = document.querySelector('#picker-selection-color') as HTMLElement;
        const inputScrollbarColor = document.querySelector('#input-scrollbar-color') as HTMLInputElement;
        const pickerScrollbarColor = document.querySelector('#picker-scrollbar-color') as HTMLElement;
        const inputHeadingColor = document.querySelector('#input-heading-color') as HTMLInputElement;
        const pickerHeadingColor = document.querySelector('#picker-heading-color') as HTMLElement;
        const checkEnableGlow = document.querySelector('#check-enable-glow') as HTMLInputElement;
        const inputGlowColor = document.querySelector('#input-glow-color') as HTMLInputElement;
        const pickerGlowColor = document.querySelector('#picker-glow-color') as HTMLElement;
        const inputGlowRadius = document.querySelector('#input-glow-radius') as HTMLInputElement;
        const glowRadiusVal = document.querySelector('#glow-radius-val') as HTMLElement;
        const useUiBgCheck = document.querySelector('#use-ui-bg') as HTMLInputElement;
        const pandocPath = document.querySelector('#pandoc-path') as HTMLInputElement;

        // --- 3.1. UI要素の取得 (AI新規) ---
        const geminiApiKeyInput = document.querySelector('#gemini-api-key') as HTMLInputElement;
        const geminiModelInput = document.querySelector('#gemini-model') as HTMLInputElement;
        const localLlmUrlInput = document.querySelector('#local-llm-url') as HTMLInputElement;
        const aiSystemPromptInput = document.querySelector('#ai-system-prompt') as HTMLTextAreaElement;
        const aiMaxTokensInput = document.querySelector('#ai-max-tokens') as HTMLInputElement;
        const userNameInput = document.querySelector('#user-name') as HTMLInputElement;
        const userIconDisplay = document.querySelector('#user-icon-path') as HTMLElement;
        const aiNameInput = document.querySelector('#ai-name') as HTMLInputElement;
        const aiIconDisplay = document.querySelector('#ai-icon-path') as HTMLElement;
        const modelPresetSelect = document.querySelector('#gemini-model-preset') as HTMLSelectElement;
        const localLlmModelInput = document.querySelector('#local-llm-model') as HTMLInputElement;
        const urlPresetSelect = document.querySelector('#local-llm-url-preset') as HTMLSelectElement;

        // --- 3.2. Code Editor UI要素の取得 ---
        const codeLanguageSelect = document.querySelector('#code-language-select') as HTMLSelectElement;
        const codeFontSelect = document.querySelector('#code-font-family-select') as HTMLSelectElement;
        const codeFontSizeInput = document.querySelector('#code-font-size-input') as HTMLInputElement;

        if (!applyBtn || !closeBtn) {
            console.error("Critical UI elements not found");
            return;
        }

        // --- 4. 一時保存用変数 & 初期値の読み込み ---
        let pendingBgPath = await store.get<string>('userBackgroundImagePath') || null;
        let pendingBgmPath = await store.get<string>('userBgmPath') || null;
        let pendingUserIcon = await store.get<string>('aiChatUserIconPath') || null;
        let pendingAiIcon = await store.get<string>('aiChatAiIconPath') || null;


        const initWidth = await store.get<string | number>('editorMaxWidth');
        widthInput.value = (initWidth !== null && initWidth !== undefined) ? initWidth.toString() : '80';

        const initEditorPaddingX = await store.get<number>('editorPaddingX');
        if (editorPaddingXInput) editorPaddingXInput.value = (initEditorPaddingX ?? 10).toString();

        const initHeight = await store.get<number>('editorLineHeight');
        if (heightInput) heightInput.value = (initHeight ?? 1.6).toString();

        const initLineBreak = await store.get<string>('editorLineBreak');
        if (lineBreakSelect) lineBreakSelect.value = initLineBreak ?? 'strict';

        const initWordBreak = await store.get<string>('editorWordBreak');
        if (wordBreakSelect) wordBreakSelect.value = initWordBreak ?? 'break-all';

        const initFontFamily = await store.get<string>('userFontFamily');
        if (fontSelect) fontSelect.value = initFontFamily ?? 'default';

        const align = await store.get<string>('editorAlign');
        alignSelect.value = align ?? 'center';

        const blur = await store.get<number>('editorBlur') ?? 0;
        blurRange.value = blur.toString();
        if (blurVal) blurVal.textContent = `${blur}px`;

        const valTextColor = await store.get<string>('customTextColor') || '#1e1e1e';
        const valUiTextColor = await store.get<string>('customUiTextColor') || '#1e1e1e';
        const valEditorBg = await store.get<string>('customEditorBg') || 'rgba(255, 255, 255, 0)';
        const valWindowBg = await store.get<string>('customWindowBg') || '#ffffff';
        const valSelectionColor = await store.get<string>('customSelectionColor') || 'rgba(100, 150, 250, 0.3)';
        const valScrollbarColor = await store.get<string>('customScrollbarColor') || 'rgba(0, 0, 0, 0.2)';
        const valHeadingColor = await store.get<string>('customHeadingColor') || '#0550AE';
        const valEnableGlow = await store.get<boolean>('enableGlow') ?? false;
        const valGlowColor = await store.get<string>('glowColor') || 'rgba(0, 50, 255, 0.5)';
        const valGlowRadius = await store.get<number>('glowRadius') ?? 5;
        checkEnableGlow.checked = valEnableGlow;

        // --- ピッカーセットアップ用ヘルパー ---
        const setupPicker = (previewEl: HTMLElement, inputEl: HTMLInputElement, initColor: string, alignment: 'bottom' | 'left' | 'right' = 'bottom') => {
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
                }
            });

            // input手入力時の同期
            inputEl.addEventListener('change', () => {
                previewEl.style.backgroundColor = inputEl.value;
            });
        };

        // --- テーマ適用ヘルパー ---
        const applyThemeData = async (data: any) => {
            // 1. UIへの反映
            if (data.textColor) {
                inputTextColor.value = data.textColor;
                pickerTextColor.style.backgroundColor = data.textColor;
            }
            if (data.uiColor) {
                inputUiTextColor.value = data.uiColor;
                pickerUiTextColor.style.backgroundColor = data.uiColor;
            }
            if (data.editorBg) {
                inputEditorBg.value = data.editorBg;
                pickerEditorBg.style.backgroundColor = data.editorBg;
            }
            if (data.windowBg) {
                inputWindowBg.value = data.windowBg;
                pickerWindowBg.style.backgroundColor = data.windowBg;
            }
            if (data.selection) {
                inputSelectionColor.value = data.selection;
                pickerSelectionColor.style.backgroundColor = data.selection;
            }
            if (data.scrollbar) {
                inputScrollbarColor.value = data.scrollbar;
                pickerScrollbarColor.style.backgroundColor = data.scrollbar;
            }
            if (data.heading) {
                inputHeadingColor.value = data.heading;
                pickerHeadingColor.style.backgroundColor = data.heading;
            }

            await store.set('customTextColor', inputTextColor.value);
            await store.set('customUiTextColor', inputUiTextColor.value);
            await store.set('customEditorBg', inputEditorBg.value);
            await store.set('customWindowBg', inputWindowBg.value);
            await store.set('customSelectionColor', inputSelectionColor.value);
            await store.set('customScrollbarColor', inputScrollbarColor.value);
            await store.set('customHeadingColor', inputHeadingColor.value);

            await store.save();

            await emit('settings-changed', {
                customTextColor: inputTextColor.value,
                customUiTextColor: inputUiTextColor.value,
                customEditorBg: inputEditorBg.value,
                customWindowBg: inputWindowBg.value,
                customSelectionColor: inputSelectionColor.value,
                customScrollbarColor: inputScrollbarColor.value,
                customHeadingColor: inputHeadingColor.value,
            });
        };

        // --- プリセット定義 ---
        const presets: Record<string, any> = {
            default: {
                textColor: '#1e1e1e',
                uiColor: '#1e1e1e',
                editorBg: 'rgba(255, 255, 255, 0)',
                windowBg: '#ffffff',
                selection: 'rgba(100, 150, 250, 0.3)',
                heading: '#005cc5',
                scrollbar: 'rgba(0, 0, 0, 0.2)'
            },
            paper: {
                textColor: '#3b3b3b',
                uiColor: '#5a4632',
                editorBg: 'rgba(255, 255, 255, 0)',
                windowBg: '#f4ecd8',
                selection: 'rgba(140, 100, 50, 0.2)',
                heading: '#8b4513',
                scrollbar: 'rgba(90, 70, 50, 0.2)'
            },
            cyber: {
                textColor: '#00ff41',
                uiColor: '#00ff41',
                editorBg: 'rgba(0, 0, 0, 0)',
                windowBg: 'rgba(0, 0, 0, 0.8)',
                selection: 'rgba(0, 255, 65, 0.3)',
                heading: '#00ff41',
                scrollbar: 'rgba(0, 255, 65, 0.2)'
            },
            'cyber-tokyo': {
                textColor: '#a9b1d6',
                uiColor: '#7aa2f7',
                editorBg: 'rgba(0, 0, 0, 0)',
                windowBg: 'rgba(26, 27, 38, 0.95)',
                selection: 'rgba(81, 92, 126, 0.4)', // Selection
                heading: '#bb9af7',   // Purple
                scrollbar: 'rgba(122, 162, 247, 0.3)'
            }
        };

        // --- プルダウンのイベント ---
        const themeSelect = document.querySelector('#theme-select') as HTMLSelectElement;

        themeSelect?.addEventListener('change', () => {
            const selected = themeSelect.value;
            const data = presets[selected];

            if (data) {
                // 定義済みのヘルパー関数を使って、ピッカー更新・保存・Emitを一括で行う
                applyThemeData(data);
            }
        });

        // リセットボタン（デフォルトに戻す）
        const resetThemeBtn = document.querySelector('#btn-reset-custom');
        resetThemeBtn?.addEventListener('click', () => {
            themeSelect.value = 'default';
            applyThemeData(presets['default']);
        });

        // --- ピッカー適用 ---
        setupPicker(pickerTextColor, inputTextColor, valTextColor, 'bottom');
        setupPicker(pickerUiTextColor, inputUiTextColor, valUiTextColor, 'bottom');
        setupPicker(pickerEditorBg, inputEditorBg, valEditorBg, 'left');
        setupPicker(pickerWindowBg, inputWindowBg, valWindowBg, 'left');
        setupPicker(pickerSelectionColor, inputSelectionColor, valSelectionColor, 'bottom');
        setupPicker(pickerScrollbarColor, inputScrollbarColor, valScrollbarColor, 'left');
        setupPicker(pickerHeadingColor, inputHeadingColor, valHeadingColor, 'bottom');
        setupPicker(pickerGlowColor, inputGlowColor, valGlowColor, 'bottom');

        const pandoc = await store.get<string>('pandocPath') ?? '';
        if (pandocPath) pandocPath.value = pandoc;

        const initCodeLanguage = await store.get<string>('codeLanguage') || 'html';
        if (codeLanguageSelect) codeLanguageSelect.value = initCodeLanguage;

        const initCodeFont = await store.get<string>('codeFontFamily') || 'default';
        invoke<string[]>('get_system_fonts').then(fonts => {
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'default';
            defaultOpt.text = 'Monospace (Default)';
            codeFontSelect.appendChild(defaultOpt);

            fonts.forEach(fontName => {
                const opt = document.createElement('option');
                opt.value = fontName;
                opt.text = fontName;
                codeFontSelect.appendChild(opt);
            });
            codeFontSelect.value = initCodeFont;
        }).catch(err => console.error("Code Font loading failed:", err));

        const initCodeSize = await store.get<number>('codeFontSize') || 10;
        if (codeFontSizeInput) codeFontSizeInput.value = initCodeSize.toString();

        const isUiBg = await store.get<boolean>('useUiBg') ?? false;
        useUiBgCheck.checked = isUiBg;

        inputGlowRadius.value = valGlowRadius.toString();
        glowRadiusVal.textContent = `${valGlowRadius}px`;

        // スライダーの数値表示更新
        inputGlowRadius.addEventListener('input', () => {
            glowRadiusVal.textContent = `${inputGlowRadius.value}px`;
        });

        if (pendingBgPath) bgPathDisplay.textContent = pendingBgPath.split(/[/\\]/).pop() || '';
        if (pendingBgmPath) bgmPathDisplay.textContent = pendingBgmPath.split(/[/\\]/).pop() || '';

        // AI Settings
        geminiApiKeyInput.value = await store.get<string>('geminiApiKey') || '';
        geminiModelInput.value = await store.get<string>('geminiModel') || 'gemini-2.5-flash';
        localLlmUrlInput.value = await store.get<string>('localLlmUrl') || 'http://127.0.0.1:1234/v1/chat/completions';
        aiSystemPromptInput.value = await store.get<string>('aiSystemPrompt') || '';
        aiMaxTokensInput.value = (await store.get<number>('aiMaxTokens') || 2000).toString();
        userNameInput.value = await store.get<string>('aiChatUserName') || 'User';
        localLlmModelInput.value = await store.get<string>('localLlmModel') || 'local-model';
        if (pendingUserIcon) userIconDisplay.textContent = pendingUserIcon.split(/[/\\]/).pop() || '';
        aiNameInput.value = await store.get<string>('aiChatAiName') || 'AI';
        if (pendingAiIcon) aiIconDisplay.textContent = pendingAiIcon.split(/[/\\]/).pop() || '';
        if (modelPresetSelect) {
            // 保存されている値がプルダウンの選択肢に含まれているかチェック
            const options = Array.from(modelPresetSelect.options).map(o => o.value);
            if (options.includes(geminiModelInput.value)) {
                modelPresetSelect.value = geminiModelInput.value;
            } else {
                // 含まれていなければ「手動入力」等の空欄やデフォルト位置にする
                // (HTML側で <option value="">手動入力</option> としている場合)
                modelPresetSelect.value = "";
            }
        }
        if (urlPresetSelect) {
            const options = Array.from(urlPresetSelect.options).map(o => o.value);
            if (options.includes(localLlmUrlInput.value)) {
                urlPresetSelect.value = localLlmUrlInput.value;
            } else {
                urlPresetSelect.value = ""; // カスタムURLの場合は選択解除
            }
        }

        // --- 5. イベントリスナー (ファイル選択) ---

        document.querySelector('#btn-select-bg-image')?.addEventListener('click', async () => {
            const path = await open({
                title: '背景画像を選択',
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
            });

            if (path && typeof path === 'string') {
                // 即座に保存
                pendingBgPath = path;
                await store.set('userBackgroundImagePath', path);
                await store.save();

                // 表示更新
                bgPathDisplay.textContent = path.split(/[/\\]/).pop() || path;

                // 即座に通知
                await emit('settings-changed', { userBackgroundImagePath: path });
            }
        });

        document.querySelector('#btn-clear-bg-image')?.addEventListener('click', async () => {
            pendingBgPath = null;
            await store.delete('userBackgroundImagePath'); // 削除して保存
            await store.save();

            bgPathDisplay.textContent = '(デフォルト)';

            // nullを通知してデフォルトに戻させる
            await emit('settings-changed', { userBackgroundImagePath: null });
        });

        document.querySelector('#btn-none-bg-image')?.addEventListener('click', async () => {
            pendingBgPath = 'nothing';
            await store.set('userBackgroundImagePath', 'nothing');
            await store.save();
            bgPathDisplay.textContent = '(なし)';
            await emit('settings-changed', { userBackgroundImagePath: 'nothing' });
        });

        document.querySelector('#btn-select-bgm')?.addEventListener('click', async () => {
            const path = await open({
                title: 'BGMを選択',
                filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }]
            });

            if (path && typeof path === 'string') {
                // 即座に保存
                pendingBgmPath = path;
                await store.set('userBgmPath', path);
                await store.save();

                bgmPathDisplay.textContent = path.split(/[/\\]/).pop() || path;

                // 即座に通知
                await emit('settings-changed', { userBgmPath: path });
            }
        });

        document.querySelector('#btn-clear-bgm')?.addEventListener('click', async () => {
            pendingBgmPath = null;
            await store.delete('userBgmPath');
            await store.save();

            bgmPathDisplay.textContent = '(デフォルト)';

            // nullを通知
            await emit('settings-changed', { userBgmPath: null });
        });

        document.querySelector('#btn-select-pandoc')?.addEventListener('click', async () => {
            // Windowsはexe, Mac/Linuxは拡張子なしを想定
            const path = await open({
                filters: [{ name: 'Executables', extensions: [''] }]
            });

            if (path && typeof path === 'string') {
                const input = document.querySelector('#pandoc-path') as HTMLInputElement;
                if (input) input.value = path;
            }
        });

        // User Icon
        document.querySelector('#btn-select-user-icon')?.addEventListener('click', async () => {
            const path = await open({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
            if (path && typeof path === 'string') {
                pendingUserIcon = path;
                userIconDisplay.textContent = path.split(/[/\\]/).pop() || path;
            }
        });
        document.querySelector('#btn-clear-user-icon')?.addEventListener('click', () => {
            pendingUserIcon = null;
            userIconDisplay.textContent = '(Default)';
        });

        // AI Icon
        document.querySelector('#btn-select-ai-icon')?.addEventListener('click', async () => {
            const path = await open({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
            if (path && typeof path === 'string') {
                pendingAiIcon = path;
                aiIconDisplay.textContent = path.split(/[/\\]/).pop() || path;
            }
        });
        document.querySelector('#btn-clear-ai-icon')?.addEventListener('click', () => {
            pendingAiIcon = null;
            aiIconDisplay.textContent = '(Default)';
        });

        blurRange.addEventListener('input', () => { if (blurVal) blurVal.textContent = `${blurRange.value}px`; });

        // --- 5. フォントセレクト ---

        // 現在の設定値を読み込み
        const currentFont = await store.get<string>('userFontFamily') || 'default';

        // 非同期でシステムフォントを取得してリスト生成
        invoke<string[]>('get_system_fonts').then(fonts => {
            // デフォルト選択肢
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'default';
            defaultOpt.text = 'デフォルト (Ctrl+Shift+Fで切替)';
            fontSelect.appendChild(defaultOpt);

            // システムフォント
            fonts.forEach(fontName => {
                const opt = document.createElement('option');
                opt.value = fontName;
                opt.text = fontName;
                fontSelect.appendChild(opt);
            });

            // 値をセット
            fontSelect.value = currentFont;
        }).catch(err => console.error("Font loading failed:", err));

        // --- 6. 適用ボタン (保存・通知・閉じる) ---
        applyBtn.addEventListener('click', async () => {
            try {
                const rawValue = parseInt(widthInput.value, 10);
                // NaNかチェックし、NaNでなければその値を、NaNならデフォルトを使う
                const numValue = isNaN(rawValue) ? 80 : rawValue;
                const rawPaddingX = parseInt(editorPaddingXInput.value, 10);
                const newPaddingX = isNaN(rawPaddingX) ? 10 : rawPaddingX;
                const newHeight = parseFloat(heightInput.value);
                const newLineBreak = lineBreakSelect.value;
                const newWordBreak = wordBreakSelect.value;
                const fontSelect = document.querySelector('#font-family-select') as HTMLSelectElement;
                const newUserFont = fontSelect ? fontSelect.value : 'default';
                console.log('Applying Font:', newUserFont);
                const newAlign = alignSelect.value;
                const newPandocPath = pandocPath.value;
                const newCodeLanguage = codeLanguageSelect.value;
                const newCodeFont = codeFontSelect.value;
                console.log('Applying Code Font:', newCodeFont);
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
                const newGeminiModel = geminiModelInput.value.trim();
                const newLocalUrl = localLlmUrlInput.value.trim();
                const newSystemPrompt = aiSystemPromptInput.value;
                const newAiMaxTokens = parseInt(aiMaxTokensInput.value, 10) || 2000;
                const newLocalModel = localLlmModelInput.value.trim();

                // Storeに保存
                await store.set('editorMaxWidth', numValue.toString());
                await store.set('editorPaddingX', newPaddingX);
                await store.set('editorLineHeight', newHeight);
                await store.set('editorLineBreak', newLineBreak);
                await store.set('editorWordBreak', newWordBreak);
                await store.set('userFontFamily', newUserFont);
                await store.set('editorAlign', newAlign);
                await store.set('editorBlur', newBlur);
                await store.set('pandocPath', newPandocPath);
                await store.set('codeLanguage', newCodeLanguage);
                await store.set('codeFontFamily', newCodeFont);
                await store.set('codeFontSize', newCodeSize);
                await store.set('customTextColor', newTextColor);
                await store.set('customUiTextColor', newUiTextColor);
                await store.set('customEditorBg', newEditorBg);
                await store.set('customWindowBg', newWindowBg);
                await store.set('customSelectionColor', newSelectionColor);
                await store.set('customScrollbarColor', newScrollbarColor);
                await store.set('customHeadingColor', newHeadingColor);
                await store.set('useUiBg', newUseUiBg);
                await store.set('enableGlow', checkEnableGlow.checked);
                await store.set('glowColor', inputGlowColor.value);
                await store.set('glowRadius', parseInt(inputGlowRadius.value));

                // AI設定の保存
                if (newGeminiApiKey) await store.set('geminiApiKey', newGeminiApiKey);
                await store.set('geminiModel', newGeminiModel);
                await store.set('localLlmUrl', newLocalUrl);
                await store.set('aiSystemPrompt', newSystemPrompt);
                const currentApiType = await store.get<string>('selectedApiType');
                if (!currentApiType) {
                    await store.set('selectedApiType', 'gemini');
                }
                await store.set('aiMaxTokens', newAiMaxTokens);
                // User Profile
                await store.set('aiChatUserName', userNameInput.value || 'User');
                if (pendingUserIcon) await store.set('aiChatUserIconPath', pendingUserIcon);
                else await store.delete('aiChatUserIconPath');
                // AI Profile
                await store.set('aiChatAiName', aiNameInput.value || 'AI');
                if (pendingAiIcon) await store.set('aiChatAiIconPath', pendingAiIcon);
                else await store.delete('aiChatAiIconPath');
                await store.set('localLlmModel', newLocalModel);

                await store.set('useUiBg', newUseUiBg);

                if (pendingBgPath) await store.set('userBackgroundImagePath', pendingBgPath);
                else await store.delete('userBackgroundImagePath');

                if (pendingBgmPath) await store.set('userBgmPath', pendingBgmPath);
                else await store.delete('userBgmPath');

                await store.save();

                // メインウィンドウに通知
                await emit('settings-changed', {
                    editorMaxWidth: numValue,
                    editorPaddingX: newPaddingX,
                    editorLineHeight: newHeight,
                    editorLineBreak: newLineBreak,
                    userBackgroundImagePath: pendingBgPath,
                    userBgmPath: pendingBgmPath,
                    editorWordBreak: newWordBreak,
                    userFontFamily: newUserFont,
                    editorAlign: newAlign,
                    editorBlur: newBlur,
                    useUiBg: newUseUiBg,
                    pandocPath: newPandocPath,
                    geminiApiKey: newGeminiApiKey,
                    geminiModel: newGeminiModel,
                    localLlmUrl: newLocalUrl,
                    aiSystemPrompt: newSystemPrompt,
                    selectedApiType: currentApiType || 'gemini',
                    aiMaxTokens: newAiMaxTokens,
                    aiChatUserName: userNameInput.value || 'User',
                    aiChatUserIconPath: pendingUserIcon,
                    aiChatAiName: aiNameInput.value || 'AI',
                    aiChatAiIconPath: pendingAiIcon,
                    localLlmModel: newLocalModel,
                    codeLanguage: newCodeLanguage,
                    codeFontFamily: newCodeFont,
                    codeFontSize: newCodeSize,
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
                });

            } catch (err) {
                alert(`設定の保存に失敗しました: ${err}`);
            }
        });

        // --- 7. 閉じるボタン & ショートカット ---
        const hideWindow = async () => {
            await getCurrentWindow().close();
        };

        closeBtn.addEventListener('click', hideWindow);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'F2') {
                e.preventDefault();
                hideWindow();
            }
        });

        // --- 右クリックメニューの無効化 ---
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

    } catch (error) {
        // スクリプト全体のエラーをキャッチ
        alert(`設定画面のエラー: ${error}`);
        console.error(error);
    }
}

window.addEventListener('DOMContentLoaded', setupSettings);
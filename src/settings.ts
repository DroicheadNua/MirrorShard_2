// src/settings.ts
import { Store } from '@tauri-apps/plugin-store';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { type } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
// CSSのインポート (Viteが処理します)
import './settings.css';

async function setupSettings() {
    try {
        // --- 1. OSごとの見た目調整 ---
        const wrapper = document.querySelector('#settings-wrapper') as HTMLElement;
        const osType = await type();
        if (osType === 'linux') {
            wrapper.style.backgroundImage = 'radial-gradient(circle, #22d3ee, #8b5cf6eb)';
        }

        // --- 2. Storeのロード ---
        const store = await Store.load('.settings.dat');

        // --- 3. UI要素の取得 ---
        const widthInput = document.querySelector('#editor-width-input') as HTMLInputElement;
        const heightInput = document.querySelector('#line-height-input') as HTMLInputElement;
        const lineBreakSelect = document.querySelector('#line-break-select') as HTMLSelectElement;

        const bgPathDisplay = document.querySelector('#current-bg-image-path') as HTMLElement;
        const bgmPathDisplay = document.querySelector('#current-bgm-path') as HTMLElement;

        const applyBtn = document.querySelector('#save-settings-btn') as HTMLButtonElement;
        const closeBtn = document.querySelector('#settings-btn-close') as HTMLButtonElement;

        const wordBreakSelect = document.querySelector('#word-break-select') as HTMLSelectElement;

        const fontSelect = document.querySelector('#font-family-select') as HTMLSelectElement;

        const alignSelect = document.querySelector('#editor-align-select') as HTMLSelectElement;
        const editorBgDark = document.querySelector('#editor-bg-dark') as HTMLInputElement;
        const bgOpacityRange = document.querySelector('#editor-bg-opacity') as HTMLInputElement;
        const bgOpacityVal = document.querySelector('#bg-opacity-val');
        const blurRange = document.querySelector('#editor-blur-range') as HTMLInputElement;
        const blurVal = document.querySelector('#blur-val');

        const uiTextWhite = document.querySelector('#ui-text-white') as HTMLInputElement;
        const useUiTextShadow = document.querySelector('#use-ui-text-shadow') as HTMLInputElement;

        if (!applyBtn || !closeBtn) {
            console.error("Critical UI elements not found");
            return;
        }

        // --- 4. 一時保存用変数 & 初期値の読み込み ---
        let pendingBgPath = await store.get<string>('userBackgroundImagePath') || null;
        let pendingBgmPath = await store.get<string>('userBgmPath') || null;

        const initWidth = await store.get<string>('editorMaxWidth');
        if (widthInput) widthInput.value = parseInt(initWidth ?? '80', 10).toString();

        const initHeight = await store.get<number>('editorLineHeight');
        if (heightInput) heightInput.value = (initHeight ?? 1.6).toString();

        const initLineBreak = await store.get<string>('editorLineBreak');
        if (lineBreakSelect) lineBreakSelect.value = initLineBreak ?? 'strict';

        const initWordBreak = await store.get<string>('editorWordBreak');
        if (wordBreakSelect) wordBreakSelect.value = initWordBreak ?? 'break-all';

        const initFontFamily = await store.get<string>('userFontFamily');
        if (fontSelect) fontSelect.value = initFontFamily ?? 'default';

        const align = await store.get<string>('editorAlign') ?? 'center';
        alignSelect.value = align;

        const isBgDark = await store.get<boolean>('editorIsBgDark') ?? false;
        editorBgDark.checked = isBgDark;

        const bgOpacity = await store.get<number>('editorBgOpacity') ?? 0;
        bgOpacityRange.value = bgOpacity.toString();
        if (bgOpacityVal) bgOpacityVal.textContent = `${bgOpacity}%`;

        const blur = await store.get<number>('editorBlur') ?? 0;
        blurRange.value = blur.toString();
        if (blurVal) blurVal.textContent = `${blur}`;

        // ★ UI文字色
        const isUiWhite = await store.get<boolean>('uiTextIsWhite') ?? false;
        uiTextWhite.checked = isUiWhite;

        const isUiShadow = await store.get<boolean>('useUiTextShadow') ?? false;
        useUiTextShadow.checked = isUiShadow;

        if (pendingBgPath) bgPathDisplay.textContent = pendingBgPath.split(/[/\\]/).pop() || '';
        if (pendingBgmPath) bgmPathDisplay.textContent = pendingBgmPath.split(/[/\\]/).pop() || '';


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

        bgOpacityRange.addEventListener('input', () => { if (bgOpacityVal) bgOpacityVal.textContent = `${bgOpacityRange.value}%`; });
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
                const numValue = parseInt(widthInput.value, 10);
                const newHeight = parseFloat(heightInput.value);
                const newLineBreak = lineBreakSelect.value;
                const newWordBreak = wordBreakSelect.value;
                const newUserFont = fontSelect.value;

                const newAlign = alignSelect.value;

                const newIsBgDark = editorBgDark.checked;
                const newBgOpacity = parseInt(bgOpacityRange.value, 10);
                const newBlur = parseInt(blurRange.value, 10);
                const newIsUiWhite = uiTextWhite.checked;
                const newUseUiShadow = useUiTextShadow.checked;

                // 色の計算ロジック 
                // 背景色: 黒(0,0,0) か 白(255,255,255)
                const rgb = newIsBgDark ? '0, 0, 0' : '255, 255, 255';
                const rgbaString = `rgba(${rgb}, ${newBgOpacity / 100})`;

                // エディタ文字色: 背景が黒なら白(#dddddd)、白なら黒(#333333)
                // 自動決定するので保存・通知するのは「色コード」でOK
                const newEditorTextColor = newIsBgDark ? '#DDDDDD' : '#333333';

                // UI文字色: 指定に従う
                const newUiTextColor = newIsUiWhite ? '#DDDDDD' : '#333333';

                // Storeに保存
                await store.set('editorMaxWidth', numValue);
                await store.set('editorLineHeight', newHeight);
                await store.set('editorLineBreak', newLineBreak);
                await store.set('editorWordBreak', newWordBreak);
                await store.set('userFontFamily', newUserFont);
                await store.set('editorAlign', newAlign);
                await store.set('editorIsBgDark', newIsBgDark);
                await store.set('editorBgOpacity', newBgOpacity);
                await store.set('editorBlur', newBlur);

                // 自動決定した文字色は保存しなくても計算できるが、main.tsに渡すために保存しても良い
                // ここではフラグだけ保存

                await store.set('uiTextIsWhite', newIsUiWhite);
                await store.set('useUiTextShadow', newUseUiShadow);

                if (pendingBgPath) await store.set('userBackgroundImagePath', pendingBgPath);
                else await store.delete('userBackgroundImagePath');

                if (pendingBgmPath) await store.set('userBgmPath', pendingBgmPath);
                else await store.delete('userBgmPath');

                await store.save();

                // メインウィンドウに通知
                await emit('settings-changed', {
                    editorMaxWidth: numValue,
                    editorLineHeight: newHeight,
                    editorLineBreak: newLineBreak,
                    userBackgroundImagePath: pendingBgPath,
                    userBgmPath: pendingBgmPath,
                    editorWordBreak: newWordBreak,
                    userFontFamily: newUserFont,
                    editorAlign: newAlign,
                    editorBgColorRGBA: rgbaString, // 計算済みRGBA
                    editorBlur: `${newBlur}px`,
                    editorTextColor: newEditorTextColor, // 自動決定した文字色
                    uiTextColor: newUiTextColor,
                    useUiTextShadow: newUseUiShadow,
                    editorIsBgDark: newIsBgDark,
                    editorBgOpacity: newBgOpacity,
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

    } catch (error) {
        // スクリプト全体のエラーをキャッチ
        alert(`設定画面のエラー: ${error}`);
        console.error(error);
    }
}

window.addEventListener('DOMContentLoaded', setupSettings);
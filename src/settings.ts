// src/settings.ts
import { Store } from '@tauri-apps/plugin-store';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { type } from '@tauri-apps/plugin-os';
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


        // --- 6. 適用ボタン (保存・通知・閉じる) ---
        applyBtn.addEventListener('click', async () => {
            try {
                const numValue = parseInt(widthInput.value, 10);
                const newWidth = numValue === 0 ? '100%' : `${numValue}ch`;
                const newHeight = parseFloat(heightInput.value);
                const newLineBreak = lineBreakSelect.value;
                const newWordBreak = wordBreakSelect.value;

                // Storeに保存
                await store.set('editorMaxWidth', newWidth);
                await store.set('editorLineHeight', newHeight);
                await store.set('editorLineBreak', newLineBreak);
                await store.set('editorWordBreak', newWordBreak);

                if (pendingBgPath) await store.set('userBackgroundImagePath', pendingBgPath);
                else await store.delete('userBackgroundImagePath');

                if (pendingBgmPath) await store.set('userBgmPath', pendingBgmPath);
                else await store.delete('userBgmPath');

                await store.save();

                // メインウィンドウに通知
                await emit('settings-changed', {
                    editorMaxWidth: newWidth,
                    editorLineHeight: newHeight,
                    editorLineBreak: newLineBreak,
                    userBackgroundImagePath: pendingBgPath,
                    userBgmPath: pendingBgmPath,
                    editorWordBreak: newWordBreak
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
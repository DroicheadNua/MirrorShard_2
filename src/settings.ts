import './settings.css';
import { Store } from '@tauri-apps/plugin-store';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function setupSettings() {
    // --- UI要素の取得 ---
    const widthInput = document.querySelector<HTMLInputElement>('#editor-width-input');
    const heightInput = document.querySelector<HTMLInputElement>('#line-height-input');
    const lineBreakSelect = document.querySelector<HTMLSelectElement>('#line-break-select');
    const saveBtn = document.querySelector<HTMLButtonElement>('#save-settings-btn');
    const closeBtn = document.querySelector<HTMLButtonElement>('#settings-btn-close');

    if (!widthInput || !heightInput || !lineBreakSelect || !saveBtn || !closeBtn) {
        console.error("A required UI element in settings.html was not found.");
        return;
    }

    // --- Storeのロード ---
    const store = await Store.load('.settings.dat');

    // --- 初期値の読み込みとUIへの反映 ---
    const initialWidth = await store.get<string>('editorMaxWidth');
    widthInput.value = parseInt(initialWidth ?? '80', 10).toString();

    const initialHeight = await store.get<number>('editorLineHeight');
    heightInput.value = (initialHeight ?? 1.6).toString();

    const initialLineBreak = await store.get<string>('editorLineBreak');
    lineBreakSelect.value = initialLineBreak ?? 'strict';

    // --- イベントリスナー ---

    // 「適用」ボタンが押されたら、すべての設定を保存し、メインウィンドウに通知
    saveBtn.addEventListener('click', async () => {
        // 1. UIから値を取得
        const numValue = parseInt(widthInput.value, 10);
        const newWidth = numValue === 0 ? '100%' : `${numValue}ch`;
        const newHeight = parseFloat(heightInput.value);
        const newLineBreak = lineBreakSelect.value;

        // 2. Storeに保存
        await store.set('editorMaxWidth', newWidth);
        await store.set('editorLineHeight', newHeight);
        await store.set('editorLineBreak', newLineBreak);
        await store.save();

        // 3. メインウィンドウに、変更された設定を一括で通知
        await emit('settings-changed', {
            editorMaxWidth: newWidth,
            editorLineHeight: newHeight,
            editorLineBreak: newLineBreak,
        });
    });

    // 閉じるボタンの処理
    closeBtn.addEventListener('click', () => {
        getCurrentWindow().close();
    });

    // F2キーでのトグル
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F2') {
            e.preventDefault();
            e.stopPropagation();
            getCurrentWindow().close();
        }
    });
}

// ページが読み込まれたらセットアップを実行
window.addEventListener('DOMContentLoaded', setupSettings);
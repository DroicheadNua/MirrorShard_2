import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import updateArticle from './scripts/ruby';
import { backgroundImage } from './assets/images.ts';
import { type } from '@tauri-apps/plugin-os';

interface PreviewPayload {
    text: string;
    isDarkMode: boolean;
    cursorLine: number;
    fontFamily: string;
    fontSize: string;
    lineHeight: number;
}

async function initPreview() {
    const contentDiv = document.getElementById('content');
    const refreshBtn = document.getElementById('btn-refresh');
    const fullscreenBtn = document.getElementById('btn-fullscreen');
    const closeBtn = document.getElementById('btn-close');
    const paperArea = document.getElementById('paper-area');
    const wrapper = document.getElementById('preview-wrapper');

    // --- メインからのデータ受信 ---
    await listen<PreviewPayload>('preview-update-data', async (event) => {
        const { text, isDarkMode, cursorLine, fontFamily, fontSize, lineHeight } = event.payload;

        // 1. ダークモード反映
        if (isDarkMode !== undefined) {
            document.body.classList.toggle('dark-mode', isDarkMode);

            // 2. 背景画像設定
            if (wrapper) {
                if (isDarkMode) {
                    wrapper.style.backgroundImage = 'none';
                } else {
                    wrapper.style.backgroundImage = `url(${backgroundImage})`;
                }
            }
        }


        if (text !== undefined && contentDiv && paperArea) {
            // 2. ★★★ コンテンツの生成（Electron版ロジック移植） ★★★
            // 行ごとに分割し、ID付きのspanで囲む
            const lines = text.split('\n');
            const htmlWithLineNumbers = lines.map((line: string, index: number) => {
                // 空行でも高さを持たせるためにスペースを入れる等の処理
                const content = line || ' ';
                // IDは line-1, line-2... となる
                return `<span id="line-${index + 1}" class="preview-line">${content}</span>`;
            }).join('<br>');

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
                        behavior: 'auto',
                        block: 'center',
                        inline: 'center'
                    });
                } else {
                    // ターゲットが見つからない場合（巨大ファイル制限など）、先頭へ
                    // paper-areaのスクロール方向(RTL)に合わせて0または右端へ
                    paperArea.scrollTo({ left: 0, behavior: 'auto' });
                }
            }, 200);
            // 5. 描画完了後にウィンドウを表示
            setTimeout(async () => {
                await getCurrentWindow().show();
                await getCurrentWindow().setFocus();
            }, 100);
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
    await listen('settings-changed', () => {
        // 引数は使わず、単にリクエストを飛ばすだけ
        emit('preview-request-update');
    });

    const osType = await type();
    if (osType === 'macos') {
        document.body.classList.add('is-mac');
    }

    // --- 更新ボタン ---
    refreshBtn?.addEventListener('click', async () => {
        await emit('preview-request-update');
    });

    // --- フルスクリーンボタン ---
    fullscreenBtn?.addEventListener('click', async () => {
        await previewToggleFullscreen();
    });

    // --- 閉じる ---
    closeBtn?.addEventListener('click', async () => {
        previewClose()
    });

    // --- ショートカットキー ---
    document.addEventListener('keydown', (e) => {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        const key = e.key.toLowerCase();
        const isMac = osType === 'macos';
        const isCtrl = e.ctrlKey;
        const isCmd = e.metaKey;

        if (isCtrlOrCmd && key === 'p' && !isShift) {
            e.preventDefault();
            previewClose();
        }
        if (isCtrlOrCmd && key === 't' && !isShift) {
            e.preventDefault();
            emit('subwindow-toggle-theme');
        }
        if (isMac && isCtrl && isCmd && key === 'f') {
            e.preventDefault();
            previewToggleFullscreen();
            return;
        }
        // --- Windows/Linux用フルスクリーン (F11) ---
        if (!isMac && e.key === 'F11') {
            e.preventDefault();
            previewToggleFullscreen();
            return;
        }
        if (isCtrlOrCmd && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
            e.preventDefault();
            emit('preview-font-size', 'up');
        }
        if (isCtrlOrCmd && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
            e.preventDefault();
            emit('preview-font-size', 'down');
        }
        if (isCtrlOrCmd && (e.code === 'Digit0' || e.code === 'Numpad0')) {
            e.preventDefault();
            emit('preview-font-size', 'reset');
        }
    });

    // --- マウスホイールでの横スクロール変換 ---
    if (paperArea) {
        paperArea.addEventListener('wheel', (e) => {
            // 縦スクロールの成分が横スクロールより大きい場合のみ処理（トラックパッド等の斜め移動対策）
            if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

            // 標準の縦スクロールをキャンセル
            e.preventDefault();

            // 縦スクロール量(deltaY) を 横スクロール(scrollLeft) に変換
            const scrollSpeed = 1.0;
            paperArea.scrollLeft -= e.deltaY * scrollSpeed;

        }, { passive: false }); // preventDefaultするために passive: false が必要
    }

    // --- フルスクリーン切り替え ---
    async function previewToggleFullscreen() {
        const window = getCurrentWindow();
        const isFullscreen = await window.isFullscreen();
        if (isFullscreen) {
            await window.setFullscreen(false);
            if (osType !== 'macos' && wrapper) {
                wrapper.style.borderRadius = '6px';
            }
        } else {
            await window.setFullscreen(true);
            if (osType !== 'macos' && wrapper) {
                wrapper.style.borderRadius = '0px';
            }
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
        await emit('preview-request-update');
    }, 100);
}

window.addEventListener('DOMContentLoaded', initPreview);
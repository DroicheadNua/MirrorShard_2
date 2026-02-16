import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { Store } from '@tauri-apps/plugin-store';
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

// 現在のテキストを保持する変数（印刷用）
let currentRawText = "";
let isSimpleFullscreen = false;

async function initPreview() {
    const contentDiv = document.getElementById('content');
    const exportMenuBtn = document.getElementById('btn-export-menu');
    const exportDropdown = document.getElementById('export-dropdown');
    const dropdownItems = document.querySelectorAll('.dropdown-item');
    const refreshBtn = document.getElementById('btn-refresh');
    const fullscreenBtn = document.getElementById('btn-fullscreen');
    const closeBtn = document.getElementById('btn-close');
    const paperArea = document.getElementById('paper-area');
    const wrapper = document.getElementById('preview-wrapper');
    const pinBtn = document.getElementById('btn-pin');
    let isPinned = false;
    // モーダル要素
    const epubModal = document.getElementById('epub-modal');
    const epubTitleInput = document.getElementById('epub-title') as HTMLInputElement;
    const epubAuthorInput = document.getElementById('epub-author') as HTMLInputElement;
    const epubCoverInput = document.getElementById('epub-cover-path') as HTMLInputElement;
    const btnSelectCover = document.getElementById('btn-select-cover');
    const btnClearCover = document.getElementById('btn-clear-cover');
    const btnCancelEpub = document.getElementById('btn-cancel-epub');
    const btnExecEpub = document.getElementById('btn-exec-epub');

    // --- メインからのデータ受信 ---
    await listen<PreviewPayload>('preview-update-data', async (event) => {
        const { text, isDarkMode, cursorLine, fontFamily, fontSize, lineHeight } = event.payload;

        // テキストを保持（印刷時に使う）
        if (text !== undefined) {
            currentRawText = text;
        }

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

    // --- 最前面固定切り替え ---
    pinBtn?.addEventListener('click', async () => {
        isPinned = !isPinned;

        // Window APIを使って最前面設定を変更
        await getCurrentWindow().setAlwaysOnTop(isPinned);

        // ボタンの見た目を切り替え
        if (isPinned) {
            pinBtn.classList.add('active');
            pinBtn.title = "固定を解除";
        } else {
            pinBtn.classList.remove('active');
            pinBtn.title = "最前面に固定";
        }
    });

    // --- ドロップダウンの開閉 ---
    exportMenuBtn?.addEventListener('click', (e) => {
        e.stopPropagation(); // 親への伝播を止める
        exportDropdown?.classList.toggle('show');
    });

    // 画面のどこかをクリックしたら閉じる
    document.addEventListener('click', () => {
        exportDropdown?.classList.remove('show');
    });

    // --- 各項目のクリック処理 ---
    dropdownItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            const action = (e.target as HTMLElement).getAttribute('data-action');
            if (!action) return;

            // ドロップダウンを閉じる
            exportDropdown?.classList.remove('show');

            if (action === 'html') {
                // HTMLは即座に保存ダイアログへ
                await handlePandocExport('html');
            } else if (action === 'epub') {
                // EPUBはモーダルを開く
                openEpubModal();
            }
        });
    });

    // --- EPUB モーダル制御 ---
    function openEpubModal() {
        if (!epubModal) return;
        epubModal.style.display = 'flex';
    }

    btnCancelEpub?.addEventListener('click', () => {
        if (epubModal) epubModal.style.display = 'none';
    });

    // 表紙選択
    btnSelectCover?.addEventListener('click', async () => {
        const path = await open({
            title: 'Select Cover Image',
            filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
        });
        if (path && typeof path === 'string') {
            epubCoverInput.value = path;
        }
    });

    // 表紙クリア
    btnClearCover?.addEventListener('click', () => {
        epubCoverInput.value = "";
    });

    // EPUB実行
    btnExecEpub?.addEventListener('click', async () => {
        if (epubModal) epubModal.style.display = 'none';

        const metadata = {
            title: epubTitleInput.value || "Untitled",
            author: epubAuthorInput.value || "Unknown",
            cover: epubCoverInput.value || "" // Rust側で受け取るキー
        };

        await handlePandocExport('epub', metadata);
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
                defaultPath: `output.${ext}`
            });
            if (!path) return;

            const store = await Store.load('.settings.dat');
            const pandocPath = await store.get<string>('pandocPath');

            // テキスト整形 (既存ロジック)
            let processedText = currentRawText.replace(/(?<!\n)\n(?!\n)/g, '  \n');
            processedText = processedText.replace(/｜([^《]+)《([^》]+)》/g, '<ruby>$1<rt>$2</rt></ruby>');
            const kanjiRange = '\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3400-\\u4DBF';
            const kanjiRubyRegex = new RegExp(`([^｜|])([${kanjiRange}]+)《([^》\\n]+?)》`, 'gu');
            processedText = processedText.replace(kanjiRubyRegex, '$1<ruby>$2<rt>$3</rt></ruby>');

            // メタデータの決定
            // HTMLの場合はファイル名をタイトルにする等の簡易処理
            const filename = path.split(/[/\\]/).pop() || "Untitled";
            const fileTitle = filename.replace(/\.[^/.]+$/, "");

            // EPUBからの指定があればそれを使う、なければデフォルト
            const finalMetadata = customMetadata || {
                title: fileTitle,
                author: ""
            };

            await invoke('export_with_pandoc', {
                sourceContent: processedText,
                outputPath: path,
                format: format,
                isVertical: true,
                pandocPathSetting: pandocPath,
                metadata: finalMetadata
            });

            alert(`${format.toUpperCase()} エクスポートが完了しました`);

        } catch (e) {
            console.error(e);
            alert(`エクスポートに失敗しました: ${e}`);
        }
    }

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

    // --- 右クリックメニューの無効化 ---
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
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

    async function previewToggleFullscreen() {
        // 反転
        isSimpleFullscreen = !isSimpleFullscreen;

        // Rustコマンドを呼び出し
        await invoke('set_simple_fullscreen', { enable: isSimpleFullscreen });

        // 必要ならCSS調整 (角丸など)
        if (osType !== 'macos' && wrapper) {
            wrapper.style.borderRadius = isSimpleFullscreen ? '0px' : '6px';
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
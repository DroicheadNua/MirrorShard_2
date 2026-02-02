import { listen, emit } from '@tauri-apps/api/event';
import { marked } from 'marked';
import { type } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import updateArticle from './scripts/ruby';

// GFMと改行の有効化
marked.use({
    gfm: true,
    breaks: true // 改行を<br>にする
});

interface MarkdownPayload {
    text: string;
    isDarkMode: boolean;
    filePath: string;
}

const contentDiv = document.getElementById('markdown-content');
const wrapper = document.getElementById('md-wrapper');
// スクロール位置保存用マップ (パス -> scrollTop)
const scrollHistory = new Map<string, number>();
// 直前に表示していたファイルパス
let currentFilePath = "";

async function init() {
    const refreshBtn = document.getElementById('btn-refresh');
    const closeBtn = document.getElementById('btn-close');
    const copyHtmlBtn = document.getElementById('btn-copy-html');
    const pinBtn = document.getElementById('btn-pin');
    let isPinned = false;

    const osType = await type();
    if (osType === 'macos') document.body.classList.add('is-mac');

    // データ受信リスナー
    await listen<MarkdownPayload>('markdown-update', async (event) => {
        const { text, isDarkMode, filePath } = event.payload;
        if (!contentDiv || !wrapper) return;

        // 1. 直前のファイルのスクロール位置を保存
        // (初回起動時など currentFilePath が空の場合はスキップ)
        if (currentFilePath) {
            scrollHistory.set(currentFilePath, contentDiv.scrollTop);
        }

        // 2. 現在のファイルパスを更新
        currentFilePath = filePath;

        // 3. ダークモード適用
        if (isDarkMode) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        // 4. HTML生成
        // 先にMarkdownをパースする
        const rawHtml = await marked.parse(text);
        contentDiv.innerHTML = rawHtml;

        // 5. ルビ変換 (生成されたDOMに対して適用)
        updateArticle(contentDiv);

        // 6. 表示処理 & スクロール復元
        setTimeout(async () => {
            // スクロール位置の復元
            // マップにあればその位置、なければ(新規/別タブ) 0 (文頭)
            const savedScroll = scrollHistory.get(filePath) || 0;
            contentDiv.scrollTop = savedScroll;

            // 表示
            wrapper.classList.add('loaded');
            const win = getCurrentWindow();
            if (!(await win.isVisible())) {
                await win.show();
            }
        }, 50);
    });

    // ダークモード同期
    await listen('app:theme-changed', () => {
        document.body.classList.toggle('dark-mode');
    });

    await listen('settings-changed', () => {
        emit('markdown-request-update');
    });

    // ジャンプ命令の受信
    await listen<string>('markdown-jump', (event) => {
        const targetText = event.payload;
        if (!contentDiv) return;

        // Markdown内の見出しタグ (h1 ～ h6) をすべて取得
        const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');

        // テキストが一致するものを探す
        for (const h of headings) {
            // 完全一致、あるいは "含む" で判定
            // (Markdownの記法によっては前後に空白が入ったりするので trim 推奨)
            if (h.textContent?.trim() === targetText.trim()) {
                h.scrollIntoView({ behavior: 'smooth', block: 'start' });
                break; // 最初に見つかったもので終了
            }
        }
    });

    // --- 更新ボタン ---
    refreshBtn?.addEventListener('click', async () => {
        await emit('markdown-request-update');
    });

    // --- 閉じる ---
    closeBtn?.addEventListener('click', async () => {
        invoke('open_markdown_preview');
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

    // --- HTMLコピー機能 ---
    copyHtmlBtn?.addEventListener('click', async () => {
        if (contentDiv) {
            const html = contentDiv.innerHTML;
            await writeText(html);
            alert("HTML Source Copied!");
        }
    });

    // --- ショートカットキー ---
    document.addEventListener('keydown', (e) => {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        const key = e.key.toLowerCase();

        if (isCtrlOrCmd && key === 'm' && !isShift) {
            e.preventDefault();
            invoke('open_markdown_preview');
        }
        if (isCtrlOrCmd && key === 't' && !isShift) {
            e.preventDefault();
            emit('subwindow-toggle-theme');
        }
    });

    // 起動時にメインウィンドウへデータを要求
    // 少し待ってから送る
    setTimeout(async () => {
        await emit('markdown-request-update');
    }, 100);
}

// DomContentLoadedを待つ
window.addEventListener('DOMContentLoaded', init);
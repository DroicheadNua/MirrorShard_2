import { listen, emit } from '@tauri-apps/api/event';
import { marked } from 'marked';
import { type } from '@tauri-apps/plugin-os';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { initI18n, applyTranslationsToDOM, t, translateRustError } from './i18n';

interface MarkdownPayload {
    text: string;
    isDarkMode: boolean;
    filePath: string;
    mdHardBreaks: boolean;
}

const refreshBtn = document.getElementById('btn-refresh');
const closeBtn = document.getElementById('btn-close');
const copyHtmlBtn = document.getElementById('btn-copy-html');
const saveHtmlBtn = document.getElementById('btn-save-html');
const openBrowserBtn = document.getElementById('btn-open-browser');
const pinBtn = document.getElementById('btn-pin');
const devToolsBtn = document.getElementById('btn-devtools');
const modeSelect = document.getElementById('preview-mode-select') as HTMLSelectElement;
const osType = await type();
if (osType === 'macos') document.body.classList.add('is-mac');
const contentDiv = document.getElementById('markdown-content');
const wrapper = document.getElementById('md-wrapper');
// スクロール位置保存用マップ (パス -> scrollTop)
const scrollHistory = new Map<string, number>();
// 直前に表示していたファイルパス
let currentFilePath = "";
let currentText = "";
let currentMode = "markdown"; // 'markdown' | 'html'
let useHardBreaks = false;
let isPinned = false;
let zoomLevel = 100;

async function renderContent() {
    if (!contentDiv) return;
    let rawHtml = "";

    // 1. モードごとの前処理
    if (currentMode === 'markdown') {
        // --- Markdownモード ---
        // クラス付与（スタイル適用）
        contentDiv.classList.add('markdown-body');
        let processedText = currentText;

        // 文字列の先頭が --- で始まり、次の --- で終わるブロックを削除
        if (processedText.startsWith('---\n')) {
            processedText = processedText.replace(/^---\n[\s\S]*?\n---\n/, '');
        }

        rawHtml = await marked.parse(processedText, {
            gfm: true,
            breaks: useHardBreaks
        });

        // ※Markdownのルビ変換は行わない
    } else {
        // --- HTML/Astroモード ---
        // クラス除去（スタイル干渉回避）
        contentDiv.classList.remove('markdown-body');

        rawHtml = currentText;

        // Astro Frontmatter削除
        if (rawHtml.startsWith('---')) {
            const endMatch = rawHtml.indexOf('---', 3);
            if (endMatch !== -1) {
                rawHtml = rawHtml.substring(endMatch + 3).trim();
            }
        }
    }

    // Astro構文の置換
    if (rawHtml.includes('import.meta.env.BASE_URL')) {
        rawHtml = rawHtml.replace(/src=\{`?\$\{import\.meta\.env\.BASE_URL\}(.*?)`?\}/g, 'src="$1"');
    }

    // DOMパースを行う条件を拡張
    // 「画像処理が必要」 または 「HTMLモード（スタイル救出が必要）」 の場合
    const needsDomParsing = (currentFilePath && currentFilePath !== "Untitled" && rawHtml.includes('<img')) || currentMode !== 'markdown';

    if (needsDomParsing) {
        // A. 文字列をDOMオブジェクトにパース
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');

        // B. 画像パスの解決 (ファイルパスがあり、かつ画像がある場合のみ)
        if (currentFilePath && currentFilePath !== "Untitled") {
            const separator = currentFilePath.includes('\\') ? '\\' : '/';
            const baseDir = currentFilePath.substring(0, currentFilePath.lastIndexOf(separator));

            const images = doc.querySelectorAll('img');
            images.forEach(img => {
                let src = img.getAttribute('src');
                if (!src) return;
                if (src.startsWith('http') || src.startsWith('data:')) return;

                try {
                    // パス解決ロジック
                    let absolutePath = src;
                    const separator = currentFilePath.includes('\\') ? '\\' : '/';

                    // パターンA: スラッシュで始まるパス ( /img/hero.jpg )
                    // フレームワークの「public」フォルダ運用と推測する
                    if (src.startsWith('/')) {
                        // パスの中に /src/ (または \src\) があるか探す
                        const srcMatch = currentFilePath.lastIndexOf(`${separator}src${separator}`);

                        if (srcMatch !== -1) {
                            // .../Project/src/pages/index.astro -> .../Project
                            const projectRoot = currentFilePath.substring(0, srcMatch);
                            // -> .../Project/public/img/hero.jpg
                            // (注: Windowsの場合 src内の / を \ に直す必要がある)
                            const normalizedSrc = src.replace(/\//g, separator);
                            absolutePath = `${projectRoot}${separator}public${normalizedSrc}`;
                        } else {
                            // srcフォルダ外ならドライブ直下とみなす（既存挙動）
                            absolutePath = src;
                        }
                    }
                    // パターンB: 相対パス ( ./img/hero.jpg )
                    else {
                        const cleanSrc = src.replace(/^\.?\//, '');
                        absolutePath = `${baseDir}${separator}${cleanSrc}`;
                    }
                    img.src = convertFileSrc(absolutePath);
                } catch (e) {
                    console.error("Image path conversion failed:", e);
                }
            });
        }

        // C. スタイルの救出とHTML生成
        if (currentMode !== 'markdown') {
            // HTMLモード: <head>内の<style>を救出してbodyと結合
            const styles = doc.querySelectorAll('head style');
            let styleString = "";
            styles.forEach(s => styleString += s.outerHTML);

            // スタイル + ボディの中身 を表示
            contentDiv.innerHTML = styleString + doc.body.innerHTML;
        } else {
            // Markdownモード: ボディの中身だけ（スタイルタグは通常含まれないため）
            contentDiv.innerHTML = doc.body.innerHTML;
        }

    } else {
        // パース不要（画像なしのMarkdownなど）ならそのまま表示
        contentDiv.innerHTML = rawHtml;
    }
}

async function init() {
    const store = await Store.load('.settings.dat');

    const appLang = (await store.get('appLanguage')) ?? 'ja';
    await initI18n(appLang === 'en' ? 'en' : 'ja');
    applyTranslationsToDOM();
    const title: string = await invoke<string>('get_window_title', { windowKey: 'markdown' }).catch((): string => '');
    if (title) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setTitle(title); }

    useHardBreaks = await store.get<boolean>('mdHardBreaks') ?? false;

    // モードの復元
    const savedMode = await store.get<string>('lastPreviewMode') || 'markdown';
    currentMode = savedMode; // 変数に反映
    if (modeSelect) modeSelect.value = savedMode;

    // モード切替イベント
    modeSelect?.addEventListener('change', async () => {
        currentMode = modeSelect.value;
        await store.set('lastPreviewMode', currentMode);
        await store.save();
        await renderContent();
    });

    // データ受信リスナー
    await listen<MarkdownPayload>('markdown-update', async (event) => {
        const { text, isDarkMode, filePath, mdHardBreaks } = event.payload;
        if (!contentDiv || !wrapper) return;
        currentText = text;

        // Hard Breaks 設定の更新
        if (mdHardBreaks !== undefined) {
            useHardBreaks = mdHardBreaks;
            // 設定が変わったら即座に再描画
            await renderContent();
        }

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
        // 4. 描画実行
        await renderContent();

        // 5. スクロール復元 (少し待つ)
        setTimeout(() => {
            const savedScroll = scrollHistory.get(filePath) || 0;
            contentDiv.scrollTop = savedScroll;
        }, 200);

        // 6. ウィンドウ表示 (描画完了を見越して待つ)
        setTimeout(async () => {
            const win = getCurrentWindow();
            if (!(await win.isVisible())) {
                await win.show();
                await win.setFocus();
            }
        }, 100);
    });

    // ダークモード同期
    await listen('app:theme-changed', () => {
        document.body.classList.toggle('dark-mode');
    });

    // 言語変更同期
    await listen<string>('app:language-changed', async (event) => {
        await initI18n(event.payload === 'en' ? 'en' : 'ja');
        applyTranslationsToDOM();
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

    // --- ズーム制御関数 ---
    const updateZoom = (delta: number | 'reset') => {
        if (delta === 'reset') zoomLevel = 100;
        else zoomLevel = Math.min(Math.max(zoomLevel + delta, 50), 300); // 50%～300%

        if (contentDiv) {
            contentDiv.style.zoom = `${zoomLevel}%`; // Chromium系のみ有効な簡易ズーム
            // または transform: scale() 
        }
    };

    // --- 更新ボタン ---
    refreshBtn?.addEventListener('click', async () => {
        await emit('markdown-request-update');
    });

    // --- 閉じる ---
    closeBtn?.addEventListener('click', async () => {
        try {
            await invoke('open_markdown_preview');
        } catch (e) {
            console.error(e);
            alert(translateRustError(e));
        }
    });

    // --- 最前面固定切り替え ---
    pinBtn?.addEventListener('click', async () => {
        isPinned = !isPinned;

        // Window APIを使って最前面設定を変更
        await getCurrentWindow().setAlwaysOnTop(isPinned);

        // ボタンの見た目を切り替え
        if (isPinned) {
            pinBtn.classList.add('active');
            pinBtn.title = t('markdown.pinRelease');
        } else {
            pinBtn.classList.remove('active');
            pinBtn.title = t('markdown.pin');
        }
    });

    // --- HTMLコピー機能 ---
    copyHtmlBtn?.addEventListener('click', async () => {
        if (contentDiv) {
            const html = contentDiv.innerHTML;
            await writeText(html);
            alert(t('markdown.copySuccess'));
        }
    });

    // --- HTML保存機能 (追加) ---
    saveHtmlBtn?.addEventListener('click', async () => {
        if (!contentDiv) return;

        try {
            // 保存ダイアログ
            const path = await save({
                title: 'Save as HTML',
                filters: [{ name: 'HTML', extensions: ['html'] }],
                defaultPath: 'export.html'
            });

            if (!path) return;

            // プレビュー内容をそのまま保存
            const htmlContent = contentDiv.innerHTML;

            await writeTextFile(path, htmlContent);
            alert(t('markdown.saveSuccess'));

        } catch (e) {
            console.error(e);
            alert(`${t('markdown.saveFailed')}: ${e}`);
        }
    });

    // ブラウザで開くボタン
    openBrowserBtn?.addEventListener('click', async () => {
        if (currentFilePath && currentFilePath !== "Untitled") {
            // Tauriプラグインではなく、自作のRustコマンドを叩く
            await invoke('open_in_browser', { path: currentFilePath });
        } else {
            alert(t('markdown.noFile'));
        }
    });

    // DevToolsを開くボタン
    devToolsBtn?.addEventListener('click', async () => {
        await invoke('toggle_devtools');
    });

    // --- 右クリックメニューの無効化 ---
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // リンククリックのハンドリング
    document.addEventListener('click', async (e) => {
        const target = (e.target as HTMLElement).closest('a');
        if (target && target.getAttribute('href')) {
            e.preventDefault(); // WebView内での遷移を阻止

            const href = target.getAttribute('href')!;

            // A. 外部リンク (http/https) -> ブラウザで開く
            if (href.startsWith('http://') || href.startsWith('https://')) {
                await invoke('open_in_browser', { path: href });
                return;
            }

            // B. ページ内リンク (#) -> 無視またはスクロール
            if (href.startsWith('#')) return;

            // C. ローカルファイルへのリンク (相対パス)
            // 現在開いているファイルのパスを基準に解決する
            // ※ currentFilePath (現在表示中のファイルの絶対パス) がある前提
            if (currentFilePath && currentFilePath !== "Untitled") {
                // 簡易的なパス結合 (OSのセパレータを考慮)
                const separator = currentFilePath.includes('\\') ? '\\' : '/';
                const parentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf(separator));

                // リンク先の絶対パスを作成 (簡易実装: ../ などの解決は省略し、単純結合)
                // ※本来はRust側で正規化したほうが安全だが、同階層ならこれで動く
                let targetPath = `${parentDir}${separator}${href}`;

                // メインプロセスへ「このファイルを開いて」と依頼
                await emit('request-open-file', targetPath);
            }
        }
    });

    // --- ショートカットキー ---
    document.addEventListener('keydown', async (e) => {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        const key = e.key.toLowerCase();

        if (isCtrlOrCmd && key === 'm' && !isShift) {
            e.preventDefault();
            try {
                await invoke('open_markdown_preview');
            } catch (err) {
                console.error(err);
                alert(translateRustError(err));
            }
        }
        if (isCtrlOrCmd && key === 't' && !isShift) {
            e.preventDefault();
            emit('subwindow-toggle-theme');
        }
        if (isCtrlOrCmd && key === 'r' && !isShift) {
            e.preventDefault();
            emit('markdown-request-update');
        }
        if (isCtrlOrCmd && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
            e.preventDefault(); updateZoom(10);
        } else if (isCtrlOrCmd && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
            e.preventDefault(); updateZoom(-10);
        } else if (isCtrlOrCmd && (e.code === 'Digit0' || e.code === 'Numpad0')) {
            e.preventDefault(); updateZoom('reset');
        }
        if (isCtrlOrCmd && key === 'p' && !isShift) { e.preventDefault(); }
        if (isCtrlOrCmd && key === 'r' && isShift) { e.preventDefault(); }
    });

    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            updateZoom(e.deltaY > 0 ? -5 : 5);
        }
    }, { passive: false });

    // 起動時にメインウィンドウへデータを要求
    // 少し待ってから送る
    setTimeout(async () => {
        await emit('markdown-request-update');
    }, 100);
}

// DomContentLoadedを待つ
window.addEventListener('DOMContentLoaded', init);
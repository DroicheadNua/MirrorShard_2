import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Store } from '@tauri-apps/plugin-store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import '@xterm/xterm/css/xterm.css';

async function init() {
    const title: string = await invoke<string>('get_window_title', { windowKey: 'terminal' }).catch((): string => '');
    if (title) { await getCurrentWindow().setTitle(title); }

    const store = await Store.load('.settings.dat');
    const shellPath = await store.get<string>('shellPath');
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('id') || 'main';

    // ★ CWDの決定ロジック
    let cwd: string | null = null;
    if (sessionId === 'terminal_sd') {
        // main.ts が保存した「SDスクリプトの親フォルダ」を取得
        cwd = await store.get<string>('terminalTempCwd_sd') || null;
    } else {
        cwd = (await store.get<string>('terminalTempCwd')) || (await store.get<string>('terminalDefaultCwd')) || null;
    }

    console.log(`[${sessionId}] Terminal CWD:`, cwd);

    // 一時パスの掃除
    if (await store.get('terminalTempCwd')) {
        await store.set('terminalTempCwd', null);
        await store.save();
    }

    // --- フォント設定の読み込み ---
    // コードエディタモードの設定を流用
    const savedCodeFont = await store.get<string>('codeFontFamily') || 'default';
    const savedCodeSize = await store.get<number>('codeFontSize') || 10;
    // pt を px に変換して近似させる (1.35倍程度)
    const fontSizePx = Math.round(savedCodeSize * 1.35);
    // フォントファミリー文字列の生成
    const fontFamily = savedCodeFont === 'default'
        ? '"PlemolJP", "Consolas", monospace' // デフォルト
        : `"${savedCodeFont}", "PlemolJP", "Consolas", monospace`; // 指定フォント優先

    // --- 1. xterm初期化 ---
    const term = new Terminal({
        fontFamily: fontFamily,
        fontSize: fontSizePx,
        allowTransparency: true,
        cursorBlink: true,
        cursorStyle: 'block',

        // 配色設定
        theme: {
            background: 'transparent',
            foreground: '#e0e0e0', // 標準文字色 (白に近いグレー)
            cursor: '#00FF41',     // カーソル (ネオングリーン)
            selectionBackground: 'rgba(0, 255, 65, 0.3)', // 選択範囲

            // ANSIカラー (ここを明るい色にする)
            black: '#000000',
            red: '#ff5555', // エラーなど
            green: '#50fa7b', // 成功、ユーザー名など
            yellow: '#f1fa8c', // 警告、パスなど
            blue: '#bd93f9', // ディレクトリなど
            magenta: '#ff79c6', // Xfceっぽいピンク
            cyan: '#8be9fd',
            white: '#bfbfbf',

            // Bright (高輝度) 版
            brightBlack: '#4d4d4d',
            brightRed: '#ff6e67',
            brightGreen: '#5af78e',
            brightYellow: '#f4f99d',
            brightBlue: '#caa9fa',
            brightMagenta: '#ff92d0', // 明るいピンク
            brightCyan: '#9aedfe',
            brightWhite: '#e6e6e6',
        }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const container = document.getElementById('terminal-host');
    if (container) term.open(container);

    const fitAndResize = () => {
        try {
            fitAddon.fit();
            // xtermが計算した行・列をPTYに同期させる
            // これをしないと、xtermは狭くてもPTYが広いと思って文字を送り続け、表示が崩れます
            if (term.cols > 0 && term.rows > 0) {
                invoke('resize_pty', { id: sessionId, rows: term.rows, cols: term.cols });
            }
        } catch (e) {
            console.error("Fit error:", e);
        }
    };

    // fitAddon.fit();

    // 2. PTY初期化 (Rustへ)
    try {
        await invoke('init_pty', {
            id: sessionId,
            rows: term.rows,
            cols: term.cols,
            shellPath: shellPath || "",
            cwd: cwd
        });
    } catch (e) {
        term.write('\r\n\x1b[31mFailed to initialize PTY: ' + e + '\x1b[0m\r\n');
    }

    // 3. データ受信 (Rust -> xterm)
    await listen<{ id: string, data: string }>('terminal-data', (event) => {
        if (event.payload.id === sessionId) {
            term.write(event.payload.data);
        }
    });

    await listen('settings-changed', (event: any) => {
        const s = event.payload;
        if (s.codeFontSize) {
            setTimeout(() => {
                term.options.fontSize = Math.round(s.codeFontSize * 1.35);
                fitAndResize();// サイズが変わるので再計算
            }, 50);
        }
        if (s.codeFontFamily) {
            setTimeout(() => {
                term.options.fontFamily = s.codeFontFamily === 'default'
                    ? '"PlemolJP", "Consolas", monospace'
                    : `"${s.codeFontFamily}", "PlemolJP", "Consolas", monospace`;
                fitAndResize();
            }, 50);
        }
    });

    // シェル終了通知を受け取る
    await listen<string>('terminal-exit', (event) => {
        const exitedId = event.payload;
        console.log(`terminal-exit received for: ${exitedId}`);

        // 届いたIDが自分の sessionId と一致する場合のみ、自分を閉じる
        if (exitedId === sessionId) {
            console.log("This is my session. Closing window...");
            getCurrentWindow().close();
        }
    });

    // 4. データ送信 (xterm -> Rust)
    term.onData((data) => {
        invoke('write_pty', { id: sessionId, data });
    });

    // 5. リサイズ同期
    window.addEventListener('resize', () => {
        setTimeout(() => {
            fitAndResize();
        }, 50);
    });

    // 予約コマンドがあれば実行
    const storeKey = `terminalAutoRunCommand_${sessionId}`;
    const autoRunCmd = await store.get<string>(storeKey);

    if (autoRunCmd) {
        console.log(`Auto-running command for ${sessionId}: ${autoRunCmd}`);

        // 使い終わった予約を消去
        await store.set(storeKey, null);
        await store.save();

        // PTYの初期化が完全に完了してから文字を送る
        setTimeout(() => {
            invoke('write_pty', { id: sessionId, data: `${autoRunCmd}\r\n` });
        }, 2000); // 2秒待機（確実性を高める）
    }

    document.getElementById('btn-minimize')?.addEventListener('click', () => {
        getCurrentWindow().minimize();
    });

    document.getElementById('btn-maximize')?.addEventListener('click', () => {
        getCurrentWindow().toggleMaximize(); // 最大化/元に戻すをトグル
    });

    document.getElementById('btn-close')?.addEventListener('click', () => {
        getCurrentWindow().close();
    });

    window.addEventListener('contextmenu', async (e) => {
        e.preventDefault();

        // 選択範囲があるか確認
        const selection = term.getSelection();

        const menu = await Menu.new({
            items: [
                await MenuItem.new({
                    text: 'コピー',
                    enabled: !!selection,
                    action: async () => {
                        if (selection) {
                            await writeText(selection);
                        }
                    }
                }),
                await MenuItem.new({
                    text: '貼り付け',
                    action: async () => {
                        const text = await readText();
                        if (text) invoke('write_pty', { id: sessionId, data: text });
                    }
                }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await MenuItem.new({
                    text: 'ウィンドウを閉じる',
                    action: () => getCurrentWindow().close()
                }),
            ],
        });

        await menu.popup();
    });

    // 表示
    const win = getCurrentWindow();
    await win.show();
    term.focus();
    // フォントのロードを待ち、その後に fit を実行する
    // (これをしないと、文字幅の計算がズレてレイアウトが崩れる)
    await document.fonts.ready;

    // 少し待ってからフィットさせる (レンダリングの完了待ち)
    setTimeout(() => {
        fitAndResize();
    }, 100);
}

init();
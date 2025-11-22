import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, ViewUpdate, scrollPastEnd } from '@codemirror/view';
import { history, historyKeymap, undo, redo, insertTab, cursorDocEnd, cursorDocStart } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';
import type { SelectionRange, StateEffect } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, ask, message } from '@tauri-apps/plugin-dialog';
import { backgroundMusic } from './assets/audio';
import { backgroundImage } from './assets/images';
import { listen } from '@tauri-apps/api/event';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

// --- 型定義 ---
interface Heading { level: number; text: string; pos: number; isCollapsed: boolean; }
interface OpenTab {
  path: string;
  state: EditorState;
  isDirty: boolean;
  encoding: string;
  lineEnding: 'LF' | 'CRLF' | '';
  headings: Heading[];
}
interface AppSettings {
  isDarkMode: boolean;
  currentFontIndex: number;
  currentFontSize: number;
  sessionFilePaths?: string[];
}

/**
 * MirrorShardアプリケーションのすべてを管理するクラス
 */
class App {
  // --- プロパティ ---
  private store!: Store;
  private editorView!: EditorView;
  private editorExtensions!: any[];
  private activeFileHeadings: Heading[] = [];
  private openTabs: OpenTab[] = [];
  private activeTabPath: string | null = null;
  private isDarkMode = false;
  private currentFontIndex = 1;
  private currentFontSize = 15;
  private themeCompartment = new Compartment();
  private fontFamilyCompartment = new Compartment();
  private fontSizeCompartment = new Compartment();
  private highlightingCompartment = new Compartment();
  private lightTheme!: any;
  private darkTheme!: any;
  private fontThemes: any[] = []; // ★初期化子を追加
  private fontClassNames = ['font-serif', 'font-sans-serif', 'font-monospace'];
  private bgm: HTMLAudioElement | null = null;
  private skipSessionRestore = false;
  private fileListContainer = document.querySelector<HTMLElement>('#file-list-container');
  private outlineControls = document.querySelector<HTMLElement>('.outline-controls');
  private outlineContainer = document.querySelector<HTMLElement>('#outline-container');
  private editorContainer = document.querySelector<HTMLElement>('#editor-container');
  private statusBar = document.querySelector<HTMLElement>('#status-bar');

  // --- 静的ファクトリメソッド ---
  public static async create() {
    const app = new App();
    // ★ initializeを直接awaitで呼び出す
    await app.initialize();
    return app;
  }


  private createEditorExtensions(): any[] {

    const typeWriterTheme = EditorView.theme({
      '.cm-scroller': { paddingBottom: '50vh' },
    });

    // カーソル位置を補正するフィルタ 
    const preventCursorBeyondDocEndFilter = EditorState.transactionFilter.of(tr => {
      if (!tr.selection) return tr;
      const docEnd = tr.newDoc.length;
      const newPos = tr.selection.main.head;
      if (newPos > docEnd) {
        // カーソルが末尾を越えていたら、末尾に強制的に戻す
        return { ...tr, selection: { anchor: docEnd } };
      }
      return tr;
    });

    // --- 拡張機能の配列を定義 ---
    return [
      history(),
      keymap.of([
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: insertTab },
        { key: 'Mod-ArrowUp', run: (v) => { cursorDocStart(v); v.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) }); return true; } },
        { key: 'Mod-ArrowDown', run: (v) => { cursorDocEnd(v); v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: "center" }) }); return true; } },
      ]),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      search({
        top: true, // 検索パネルを上部に

        // ★ 公式ドキュメントにある、スクロール挙動をカスタマイズするオプション
        scrollToMatch: (range: SelectionRange, _view: EditorView): StateEffect<unknown> => {
          // EditorView.scrollIntoViewを使って、中央揃えのスクロールエフェクトを生成して返す
          return EditorView.scrollIntoView(range.from, { y: 'center' });
        }
      }),
      this.themeCompartment.of(this.isDarkMode ? this.darkTheme : this.lightTheme),
      this.fontFamilyCompartment.of(this.fontThemes[this.currentFontIndex]),
      this.fontSizeCompartment.of(this.createFontSizeTheme(this.currentFontSize)),
      EditorView.updateListener.of((update: ViewUpdate) => this.onEditorUpdate(update)),
      scrollPastEnd(),
      typeWriterTheme,
      preventCursorBeyondDocEndFilter,
      this.highlightingCompartment.of(syntaxHighlighting(this.isDarkMode ? this.darkHighlightStyle : this.lightHighlightStyle)),
    ];
  }
  // --- 初期化 ---

  // in App class

  private async initialize() {
    // 1. UI要素のチェック
    if (!this.editorContainer || !this.fileListContainer || !this.outlineControls || !this.outlineContainer) {
      console.error("Fatal Error: A required UI container was not found."); return;
    }

    // 2. イベントリスナーを先に設定 (終了時チェックなど)
    this.setupEventListeners();

    // 3. 同期的なセットアップ（テーマ定義など）
    this.defineThemesAndFonts();
    this.createEditorExtensions();

    // 4. CodeMirrorインスタンスを「空のデフォルト状態」で即座に生成
    this.editorView = new EditorView({
      state: EditorState.create({ extensions: this.editorExtensions }),
      parent: this.editorContainer,
    });

    // --- ★★★ ここからが新しい非同期初期化フロー ★★★ ---

    // 5. Storeのロード
    this.store = await Store.load('.settings.dat');

    await getCurrentWindow().onFocusChanged(async ({ payload: isFocused }) => {
      if (isFocused) {
        // フォーカスが戻ってきたら、バックエンドに問い合わせる
        const filePath = await invoke<string | null>('get_second_instance_file');
        if (filePath) {
          // 新しいファイルパスがあれば、タブを開く
          await this.openOrSwitchTab(filePath);
        }
      }
    });

    // 6. バックエンドに、起動時にファイルが指定されたか問い合わせる
    const initialFile = await invoke<string | null>('get_initial_file');

    if (initialFile) {
      // 6A. ファイル指定で起動した場合
      this.skipSessionRestore = true;

      // UI設定だけは読み込む
      await this.loadSettings();

      // 指定されたファイルを最初のタブとして開く
      await this.openOrSwitchTab(initialFile);

    } else {
      // 6B. 通常起動した場合 (ファイル指定なし)
      this.skipSessionRestore = false;

      // UI設定と、前回のセッションファイルの両方を読み込む
      await this.loadSettings();
    }

    // 7. 読み込んだ設定をUIに反映
    //    (loadSettingsで状態変数が更新された後、UIに適用する)
    this.editorView.dispatch({
      effects: [
        this.themeCompartment.reconfigure(this.isDarkMode ? this.darkTheme : this.lightTheme),
        this.fontFamilyCompartment.reconfigure(this.fontThemes[this.currentFontIndex]),
        this.fontSizeCompartment.reconfigure(this.createFontSizeTheme(this.currentFontSize)),
        this.highlightingCompartment.reconfigure(syntaxHighlighting(this.isDarkMode ? this.darkHighlightStyle : this.lightHighlightStyle)),
      ]
    });
    document.body.classList.toggle('dark-mode', this.isDarkMode);
    document.body.classList.remove(...this.fontClassNames);
    document.body.classList.add(this.fontClassNames[this.currentFontIndex]);
    await this.updateBackground();

    // 8. BGMの初期化
    await this.initializeBGM();

    // 9. ステータスバーと時計の初期化
    this.updateStatusBar(this.editorView);
    setInterval(() => {
      this.updateStatusBarTimeOnly();
    }, 1000);

    // 10. 最後にウィンドウを表示
    await getCurrentWindow().show();
  }

  private async loadSettings() {
    const settings = await this.store.get<AppSettings>('settings');
    if (settings) {
      this.isDarkMode = settings.isDarkMode ?? this.isDarkMode;
      this.currentFontIndex = settings.currentFontIndex ?? this.currentFontIndex;
      this.currentFontSize = settings.currentFontSize ?? this.currentFontSize;

      // ★ skipSessionRestoreがfalseの場合のみ、セッションを復元する
      if (!this.skipSessionRestore && settings.sessionFilePaths) {
        const sessionFilePaths = settings.sessionFilePaths;
        for (const filePath of sessionFilePaths) {
          await this.openOrSwitchTab(filePath);
        }
        if (sessionFilePaths.length > 0) {
          await this.openOrSwitchTab(sessionFilePaths[sessionFilePaths.length - 1]);
        }
      }
    }
  }


  private defineThemesAndFonts() {
    const ivory = 'transparent', dark = '#333333', stone = '#555555', lightText = '#DDDDDD', darkText = '#1e1e1e';
    this.lightTheme = EditorView.theme({
      '&': {
        color: darkText,
        backgroundColor: ivory
      },
      '.cm-content': {
        caretColor: darkText
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: darkText
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: '#d4d4d4',
      },
      '&.cm-focused .cm-activeLine': {
        backgroundColor: 'transparent'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent'
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(0, 0, 0, 0.1) !important',
      },
      '& ::-webkit-scrollbar': {
        width: '18px',
      },
      '& ::-webkit-scrollbar-track': {
        backgroundColor: 'transparent',
      },
      '& ::-webkit-scrollbar-thumb': {
        backgroundColor: 'rgba(0, 0, 0, 0.15)',
        borderRadius: '9px',
        border: '3px solid transparent',
        backgroundClip: 'content-box',
        minHeight: '40px'
      },
      '& ::-webkit-scrollbar-thumb:hover': {
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
      },
    }, { dark: false });
    this.darkTheme = EditorView.theme({
      '&': {
        color: lightText,
        backgroundColor: dark
      },
      '.cm-content': {
        caretColor: lightText
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: lightText
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: stone
      },
      '&.cm-focused .cm-activeLine': {
        backgroundColor: 'transparent'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent'
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '& ::-webkit-scrollbar': {
        width: '18px',
      },
      '& ::-webkit-scrollbar-track': {
        backgroundColor: 'transparent',
      },
      '& ::-webkit-scrollbar-thumb': {
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        borderRadius: '9px',
        border: '3px solid transparent',
        backgroundClip: 'content-box',
        minHeight: '40px'
      },
      '& ::-webkit-scrollbar-thumb:hover': {
        backgroundColor: 'rgba(255, 255, 255, 0.4)',
      },
    }, { dark: true });
    const createFontTheme = (fontFamilyValue: string) => EditorView.theme({ '&': { fontFamily: fontFamilyValue }, '.cm-content': { fontFamily: `${fontFamilyValue} !important` } });
    const serif = "'Yu Mincho', 'Hiragino Mincho ProN', serif", sansSerif = "'Tsukushi A Round Gothic','Hiragino Sans','Meiryo','Yu Gothic',sans-serif", monospace = "'BIZ UDゴシック', 'Osaka-Mono', monospace";
    this.fontThemes = [createFontTheme(serif), createFontTheme(sansSerif), createFontTheme(monospace)];
  }

  private lightHighlightStyle = HighlightStyle.define([
    { tag: tags.heading, color: '#0550AE', fontWeight: 'bold' } //  GitHubの青
  ]);
  private darkHighlightStyle = HighlightStyle.define([
    { tag: tags.heading, color: '#82AAFF', fontWeight: 'bold' } //  明るい青
  ]);

  private createFontSizeTheme = (size: number) => EditorView.theme({ '&': { fontSize: `${size}pt` }, '.cm-gutters': { fontSize: `${size}pt` } });

  private async initializeBGM() {
    try {
      this.bgm = new Audio(backgroundMusic);
      this.bgm.loop = true;
    } catch (e) { console.error("Failed to initialize BGM", e); }
  }

  // --- イベントリスナー ---
  private setupEventListeners() {
    this.fileListContainer?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // 閉じるボタンがクリックされた場合
      const pathToClose = target.dataset.pathToClose;
      if (target.classList.contains('close-tab-btn') && pathToClose) {
        e.stopPropagation(); // 親のfile-entryのクリックイベントを発火させない
        this.closeTab(pathToClose);
        return;
      }
      this.handleSidebarClick(e)
    });
    this.outlineControls?.addEventListener('click', (e) => this.handleSidebarClick(e));
    this.outlineContainer?.addEventListener('click', (e) => this.handleSidebarClick(e));
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    // ボタンのイベントリスナー
    document.querySelector('#btn-save')?.addEventListener('click', () => this.saveActiveFile());
    document.querySelector('#btn-save-as')?.addEventListener('click', () => this.saveActiveFileAs());
    document.querySelector('#btn-open')?.addEventListener('click', () => this.openNewFile());
    document.querySelector('#btn-new')?.addEventListener('click', () => this.createNewTab());
    document.querySelector('#btn-undo')?.addEventListener('click', () => undo(this.editorView));
    document.querySelector('#btn-redo')?.addEventListener('click', () => redo(this.editorView));
    document.querySelector('#btn-toggle-theme')?.addEventListener('click', () => this.toggleDarkMode());
    document.querySelector('#btn-fullscreen')?.addEventListener('click', async () => {
      this.toggleFullscreen();
    });
    document.querySelector('#btn-minimize')?.addEventListener('click', async () => {
      this.setMinimize();
    });
    document.querySelector('#btn-close')?.addEventListener('click', () => {
      this.handleCloseRequest();
    });
    listen('tauri://on-close-requested', () => {
      this.handleCloseRequest();
    });
    document.querySelector('#btn-bgm-toggle')?.addEventListener('click', () => this.toggleBGM());
    document.querySelector('#btn-font-dec')?.addEventListener('click', () => this.changeFontSize(this.currentFontSize - 1));
    document.querySelector('#btn-font-reset')?.addEventListener('click', () => this.changeFontSize(15));
    document.querySelector('#btn-font-inc')?.addEventListener('click', () => this.changeFontSize(this.currentFontSize + 1));

    this.editorContainer?.addEventListener('contextmenu', async (e) => {
      e.preventDefault();

      const menu = await Menu.new({
        items: [
          // --- アプリケーション固有のコマンド ---
          await MenuItem.new({ text: '開く...', action: () => this.openNewFile() }),
          await MenuItem.new({ text: '保存', action: () => this.saveActiveFile() }),
          await MenuItem.new({ text: '名前を付けて保存...', action: () => this.saveActiveFileAs() }),
          await PredefinedMenuItem.new({ item: 'Separator' }),

          // --- CodeMirrorのコマンドを呼び出す ---
          // ★ enabled は使わず、常に有効にしておく (CodeMirrorが内部で判断する)
          await MenuItem.new({ text: '元に戻す', action: () => undo(this.editorView) }),
          await MenuItem.new({ text: 'やり直す', action: () => redo(this.editorView) }),
          await PredefinedMenuItem.new({ item: 'Separator' }),

          // ★★★ PredefinedMenuItem を使う ★★★
          await PredefinedMenuItem.new({ item: 'Cut' }),
          await PredefinedMenuItem.new({ item: 'Copy' }),
          await PredefinedMenuItem.new({ item: 'Paste' }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ]
      });

      await menu.popup();
    });

  }

  // --- イベントハンドラ ---
  // in App class

  private handleSidebarClick(e: MouseEvent) {
    const target = e.target as HTMLElement;

    // --- 1. ファイル名 (file-entry) がクリックされたか ---
    const fileEntryTarget = target.closest('.file-entry');
    if (fileEntryTarget) {
      // .file-entry要素からdata-pathを取得
      const path = (fileEntryTarget as HTMLElement).dataset.path;
      if (path) {
        this.openOrSwitchTab(path);
        // ファイル名をクリックした場合は、他の処理は不要なのでここで終了
        return;
      }
    }

    // --- 2. アウトラインのテキスト (outline-text) がクリックされたか ---
    const outlineTextTarget = target.closest('.outline-text');
    if (outlineTextTarget) {
      const posStr = (outlineTextTarget as HTMLElement).dataset.pos;
      if (posStr) {
        const pos = parseInt(posStr, 10);
        this.editorView.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' })
        });
        this.editorView.focus();
        return;
      }
    }

    // --- 3. アウトラインの開閉ボタン (toggle-collapse) がクリックされたか ---
    const toggleCollapseTarget = target.closest('.toggle-collapse');
    if (toggleCollapseTarget) {
      const posStr = (toggleCollapseTarget as HTMLElement).dataset.pos;
      if (posStr) {
        const heading = this.activeFileHeadings.find(h => h.pos === parseInt(posStr, 10));
        if (heading) {
          heading.isCollapsed = !heading.isCollapsed;
          this.renderSidebar();
        }
        return;
      }
    }

    // --- 4. 全開/全閉ボタン (IDで判断) ---
    if (target.id === 'collapse-all-btn') {
      this.activeFileHeadings.forEach(h => h.isCollapsed = true);
      this.renderSidebar();
      return;
    }

    if (target.id === 'expand-all-btn') {
      this.activeFileHeadings.forEach(h => h.isCollapsed = false);
      this.renderSidebar();
      return;
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    const isMac = navigator.userAgent.includes('Mac');
    const isCtrl = e.ctrlKey;
    const isCmd = e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    if (isCtrlOrCmd && key === 's') { e.preventDefault(); this.saveActiveFile(); }
    if (isCtrlOrCmd && key === 't') { e.preventDefault(); this.toggleDarkMode(); }
    if (isCtrlOrCmd && isShift && key === 'f') {
      e.preventDefault();
      this.cycleEditorFont();
      return; // ★処理が重複しないように、ここで関数を抜ける
    }
    if (isCtrlOrCmd && (e.code === 'Equal' || e.code === 'NumpadAdd')) { e.preventDefault(); this.changeFontSize(this.currentFontSize + 1); }
    if (isCtrlOrCmd && (e.code === 'Minus' || e.code === 'NumpadSubtract')) { e.preventDefault(); this.changeFontSize(this.currentFontSize - 1); }
    if (isCtrlOrCmd && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); this.changeFontSize(15); }
    if (isCtrlOrCmd && key === 'q') {
      e.preventDefault();
      this.handleCloseRequest();
    }
    if (isCtrlOrCmd && key === 'o') { e.preventDefault(); this.openNewFile(); }
    if (isCtrlOrCmd && key === 'n') { e.preventDefault(); this.createNewTab(); }

    // --- Mac専用フルスクリーン (Ctrl + Cmd + F) ---
    if (isMac && isCtrl && isCmd && key === 'f') {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    // --- Windows/Linux用フルスクリーン (F11) ---
    if (!isMac && e.key === 'F11') {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (isCtrlOrCmd && key === 'h') {
      e.preventDefault();
      this.setMinimize();
      return;
    }
    if (isCtrlOrCmd && key === 'p' && isShift) { e.preventDefault(); this.toggleBGM(); }
    if (isCtrlOrCmd && key === 'r') { e.preventDefault(); } // リロードを無効化
    if (isCtrlOrCmd && key === 'r' && isShift) { e.preventDefault(); }
  }

  private onEditorUpdate(update: ViewUpdate) {
    if (update.docChanged) {
      const activeTab = this.openTabs.find(t => t.path === this.activeTabPath);
      if (activeTab && !activeTab.isDirty) {
        activeTab.isDirty = true;
        this.renderSidebar(); // isDirty表示の更新のためだけ
      }
    }
    if (update.docChanged || update.selectionSet) {
      this.updateStatusBar(update.view);
    }
  }

  /**
   * サイドバー全体（開いているファイル一覧 ＋ アクティブなファイルのアウトライン）を再描画する
   * この関数が、サイドバーの見た目に関する唯一の真実となる
   */
  private renderSidebar() {
    if (!this.fileListContainer || !this.outlineContainer || !this.outlineControls) return;

    // --- 1. ファイル一覧部分のHTMLを生成 ---
    let fileListHtml = '<ul>';
    for (const tab of this.openTabs) {
      const isActive = tab.path === this.activeTabPath;
      const isDirty = tab.isDirty;
      const fileName = tab.path.split(/[/\\]/).pop();
      fileListHtml += `
      <li>
        <div class="file-entry ${isActive ? 'active' : ''}" data-path="${tab.path}">
          <span class="file-entry-title">${fileName} ${isDirty ? '*' : ''}</span>
          <button class="close-tab-btn" data-path-to-close="${tab.path}"></button>
        </div>
      </li>`;
    }
    fileListHtml += '</ul>';
    this.fileListContainer.innerHTML = fileListHtml;

    this.outlineControls.style.display = 'flex';

    // --- 2. アウトライン部分のHTMLを生成 ---
    if (this.activeTabPath && this.activeFileHeadings.length > 0) {

      let outlineHtml = '<ul>';
      let hiddenLevels: number[] = [];
      for (let i = 0; i < this.activeFileHeadings.length; i++) {
        const h = this.activeFileHeadings[i];
        while (hiddenLevels.length > 0 && h.level <= hiddenLevels[hiddenLevels.length - 1]) hiddenLevels.pop();
        if (hiddenLevels.length > 0) continue;
        if (h.isCollapsed) hiddenLevels.push(h.level);
        const hasChildren = (i + 1 < this.activeFileHeadings.length) && (this.activeFileHeadings[i + 1].level > h.level);
        const toggleIcon = h.isCollapsed ? '▶' : '▼';
        outlineHtml += `<li class="outline-item outline-level-${h.level}">${hasChildren ? `<button class="toggle-collapse" data-pos="${h.pos}">${toggleIcon}</button>` : `<span class="toggle-collapse"></span>`}<span class="outline-text" data-pos="${h.pos}">${h.text}</span></li>`;
      }
      outlineHtml += '</ul>';
      this.outlineContainer.innerHTML = outlineHtml;
    } else {
      this.outlineContainer.innerHTML = '<ul></ul>';
    }
  }

  private async updateBackground() {
    const rootStyle = document.documentElement.style;
    if (this.isDarkMode) {
      rootStyle.setProperty('--app-bg-image', 'none');
    } else {
      rootStyle.setProperty('--app-bg-image', `url('${backgroundImage}')`);
    }
  }

  /**
   * ステータスバー全体を更新する
   */
  private updateStatusBar(view: EditorView) {
    // ★ this.statusBarのnullチェックは関数の冒頭で行う
    if (!this.statusBar) return;
    const viewToUpdate = view || this.editorView;
    if (!viewToUpdate) return;
    const tab = this.openTabs.find(t => t.path === this.activeTabPath);

    // デフォルト値を設定
    let lineEnding = '';
    let encoding = '';
    let lineColText = '';
    let charCountText = '';

    if (tab) {
      lineEnding = tab.lineEnding;
      encoding = tab.encoding;

      const state = view.state;
      const cursor = state.selection.main.head;
      const line = state.doc.lineAt(cursor);

      lineColText = `${line.number}/${state.doc.lines}L`;
      charCountText = `${state.doc.length}C`;
    }

    // ★ nullチェックをしながら個別にtextContentを更新
    const lineColEl = document.querySelector<HTMLElement>('#status-line-col');
    if (lineColEl) lineColEl.textContent = lineColText;

    const charCountEl = document.querySelector<HTMLElement>('#status-char-count');
    if (charCountEl) charCountEl.textContent = charCountText;

    const encodingEl = document.querySelector<HTMLElement>('#status-encoding');
    if (encodingEl) encodingEl.textContent = encoding;

    const lineEndingEl = document.querySelector<HTMLElement>('#status-line-ending');
    if (lineEndingEl) lineEndingEl.textContent = lineEnding;
  }

  /**
   * ステータスバーの時刻だけを更新する
   */
  private updateStatusBarTimeOnly() {
    const timeEl = document.querySelector<HTMLElement>('#status-time');
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    }
  }

  // --- 機能メソッド ---
  private async saveSettings() {
    await this.store.set('settings', {
      isDarkMode: this.isDarkMode,
      currentFontIndex: this.currentFontIndex,
      currentFontSize: this.currentFontSize,
      sessionFilePaths: this.openTabs.map(t => t.path),
    });
    await this.store.save();
    console.log('Settings saved!'); // デバッグ用ログ
  }

  private toggleDarkMode() {
    this.isDarkMode = !this.isDarkMode;
    this.editorView.dispatch(
      {
        effects:
          this.themeCompartment.reconfigure(this.isDarkMode ? this.darkTheme : this.lightTheme)
      },
      {
        effects:
          this.highlightingCompartment.reconfigure(syntaxHighlighting(this.isDarkMode ? this.darkHighlightStyle : this.lightHighlightStyle))
      }
    );
    document.body.classList.toggle('dark-mode', this.isDarkMode);
    this.updateBackground();
    this.saveSettings();
  }

  private cycleEditorFont() {
    document.body.classList.remove(this.fontClassNames[this.currentFontIndex]);
    this.currentFontIndex = (this.currentFontIndex + 1) % this.fontThemes.length;
    this.editorView.dispatch({ effects: this.fontFamilyCompartment.reconfigure(this.fontThemes[this.currentFontIndex]) });
    document.body.classList.add(this.fontClassNames[this.currentFontIndex]);
    this.saveSettings();
  }

  private changeFontSize(newSize: number) {
    if (newSize < 8 || newSize > 72) return;
    this.currentFontSize = newSize;
    this.editorView.dispatch({ effects: this.fontSizeCompartment.reconfigure(this.createFontSizeTheme(this.currentFontSize)) });
    this.saveSettings();
  }

  private toggleBGM() {
    if (!this.bgm) return;
    if (this.bgm.paused) this.bgm.play().catch(e => console.error("BGM play failed:", e));
    else this.bgm.pause();
    document.querySelector('#btn-bgm-toggle')?.classList.toggle('playing', !this.bgm.paused);
  }

  private async toggleFullscreen() {
    const window = getCurrentWindow();
    const isFullscreen = await window.isFullscreen();
    window.setFullscreen(!isFullscreen);
  }
  private async setMinimize() {
    const window = getCurrentWindow();
    window.minimize();
  }

  private async handleCloseRequest() {
    const dirtyTabs = this.openTabs.filter(tab => tab.isDirty);
    let shouldClose = true;

    if (dirtyTabs.length > 0) {
      shouldClose = await ask(
        `未保存のファイルが ${dirtyTabs.length} 件あります。本当に終了しますか？`,
        { title: 'アプリケーションを終了', kind: 'warning' }
      );
    }

    if (shouldClose) {
      await this.saveSettings();
      // ★ Rustに「強制終了して」と命令する
      await invoke('force_close_app');
    }
  }

  private async saveActiveFile() {
    if (!this.activeTabPath) return;
    const activeTab = this.openTabs.find(t => t.path === this.activeTabPath);
    if (!activeTab) return;

    try {
      const content = this.editorView.state.doc.toString();
      await invoke('write_file', {
        path: activeTab.path,
        content,
        encoding: activeTab.encoding
      });
      await this.parseHeadingsFromEditor(this.editorView);
      activeTab.isDirty = false;
      this.renderSidebar(); // isDirty表示(*)を消すために再描画
      console.log(`File saved: ${activeTab.path}`);
    } catch (error) {
      console.error(`Failed to save file: ${activeTab.path}`, error);
    }
  }
  private async saveActiveFileAs() {
    if (!this.activeTabPath) return;
    const content = this.editorView.state.doc.toString();
    await invoke('save_file_as', { content });
    // TODO: 保存後、ファイル一覧をリロードし、新しいタブとして開く
  }
  private async openNewFile() {
    const filePath = await open({
      multiple: false,
      filters: [{
        name: 'Text Files',
        extensions: ['md', 'txt']
      }]
    });
    if (typeof filePath === 'string') {
      await this.openOrSwitchTab(filePath);
    }
  }
  private createNewTab() {
    const newFilePath = `Untitled-${Date.now()}.md`;
    const state = EditorState.create({ extensions: this.createEditorExtensions() });

    // ★ encodingとlineEndingのデフォルト値を追加
    const tab: OpenTab = {
      path: newFilePath,
      state,
      isDirty: true,
      encoding: 'UTF-8',      // 新規ファイルはUTF-8
      lineEnding: 'LF',       // デフォルトはLF (環境に応じて変えても良い)
      headings: [],
    };

    this.openTabs.push(tab);
    this.openOrSwitchTab(newFilePath);
  }

  private async closeTab(filePathToClose: string) {
    const tabToClose = this.openTabs.find(t => t.path === filePathToClose);
    if (!tabToClose) return;

    // もしファイルが未保存なら、確認ダイアログを出す
    if (tabToClose.isDirty) {
      const confirmed = await ask(`'${tabToClose.path.split(/[/\\]/).pop()}' は保存されていません。変更を破棄しますか？`, {
        title: 'タブを閉じる',
        kind: 'warning'
      });
      if (!confirmed) {
        return; // "いいえ"が押されたら何もしない
      }
    }

    const index = this.openTabs.findIndex(t => t.path === filePathToClose);
    if (index > -1) {
      this.openTabs.splice(index, 1);

      // もし閉じたのがアクティブなタブだった場合
      if (this.activeTabPath === filePathToClose) {
        if (this.openTabs.length === 0) {
          // すべてのタブが閉じられた場合
          this.activeTabPath = null;
          this.editorView.setState(EditorState.create({ extensions: this.editorExtensions }));
        } else {
          // 隣のタブ (左隣を優先) をアクティブにする
          const nextIndex = Math.max(0, index - 1);
          await this.openOrSwitchTab(this.openTabs[nextIndex].path);
        }
      }

      // UIを更新して設定を保存
      this.renderSidebar();
      await this.saveSettings();
    }
  }

  /**
   * エディタから見出しを解析する 
   */
  private parseHeadingsFromEditor(view: EditorView): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.time('Outline Parsing (Line by Line)');
        const newHeadings: Heading[] = [];
        const doc = view.state.doc;

        // ★ doc.linesを使って、ドキュメントの全行をループ処理
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          // ★ オリジナルと同じ正規表現
          const match = line.text.match(/^(#+)\s(.*)/);

          if (match) {
            const level = match[1].length;
            const text = match[2].trim();

            if (text) {
              newHeadings.push({
                level,
                text,
                pos: line.from, // 行の開始位置
                isCollapsed: false, // とりあえずデフォルトはfalse
              });
            }
          }
        }

        // 既存の折りたたみ状態を引き継ぐ (パフォーマンスのため)
        this.activeFileHeadings.forEach(oldHeading => {
          if (oldHeading.isCollapsed) {
            const newHeading = newHeadings.find(h => h.pos === oldHeading.pos && h.text === oldHeading.text);
            if (newHeading) {
              newHeading.isCollapsed = true;
            }
          }
        });

        this.activeFileHeadings = newHeadings;
        console.timeEnd('Outline Parsing (Line by Line)');
        resolve();
      }, 50);
    });
  }

  private async openOrSwitchTab(filePath: string) {
    // すでにアクティブなら何もしない
    if (this.activeTabPath === filePath) {
      this.editorView.focus();
      return;
    }
    // 切り替える「前」に、現在のアウトラインの状態を保存
    const previousTab = this.openTabs.find(t => t.path === this.activeTabPath);
    if (previousTab) {
      previousTab.state = this.editorView.state;
      previousTab.headings = this.activeFileHeadings;
    }

    // 1. 既存のタブを探す
    let tab = this.openTabs.find(t => t.path === filePath);

    if (!tab) {
      try {
        // ★ 新しいread_fileを呼び出し、返り値の型が変わる
        const fileData = await invoke('read_file', { path: filePath }) as {
          content: string;
          encoding: string;
          lineEnding: 'LF' | 'CRLF';
        };

        const state = EditorState.create({
          doc: fileData.content,
          extensions: this.createEditorExtensions()
        });

        tab = {
          path: filePath,
          state,
          isDirty: false,
          encoding: fileData.encoding, // ★エンコーディングを保存
          lineEnding: fileData.lineEnding, // ★改行コードを保存
          headings: [],
        };
        this.openTabs.push(tab);
      } catch (error) {
        console.error(`[openOrSwitchTab] Failed to open file: ${filePath}`, error);
        await message(
          `ファイルを読み込めませんでした。\n対応していないエンコード（UTF-8, Shift-JIS以外）の可能性があります。\n\n詳細: ${error}`,
          { title: '読み込みエラー', kind: 'error' }
        );
        return;
      }
    }

    // 3. 状態を更新
    this.activeTabPath = filePath;

    // 4. 見つけた、あるいは新しく作った`tab`の`state`を、エディタに確実にセットする
    this.editorView.setState(tab.state);

    const view = this.editorView;

    // 描画更新を待ってからスクロールを実行
    requestAnimationFrame(() => {
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" })
      });
      view.focus();
    });
    // 新しくアクティブになったタブのheadingsを復元
    this.activeFileHeadings = tab.headings;
    this.renderSidebar(); // 先にファイル名だけ表示

    // 6. アウトラインの解析とUIの更新
    await this.parseHeadingsFromEditor(this.editorView);
    this.renderSidebar();

    // 7. 設定を保存し、フォーカスを当てる
    await this.saveSettings();
    this.updateStatusBar(this.editorView);
    this.editorView.focus();
  }
}

// --- アプリケーションのエントリーポイント ---
window.addEventListener('DOMContentLoaded', () => {
  App.create();
});
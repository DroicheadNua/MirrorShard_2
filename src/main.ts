import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, ViewUpdate } from '@codemirror/view';
import { history, historyKeymap, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { TreeCursor } from '@lezer/common';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, ask } from '@tauri-apps/plugin-dialog';
import { backgroundMusic } from './assets/audio'; 
import { backgroundImage } from './assets/images';

// --- 型定義 ---
interface Heading { level: number; text: string; pos: number; isCollapsed: boolean; }
interface OpenTab { path: string; state: EditorState; isDirty: boolean; }
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
  private lightTheme!: any;
  private darkTheme!: any;
  private fontThemes: any[] = []; // ★初期化子を追加
  private fontClassNames = ['font-serif', 'font-sans-serif', 'font-monospace'];
  private bgm: HTMLAudioElement | null = null;
  
  private fileListContainer = document.querySelector<HTMLElement>('#file-list-container');
  private outlineControls = document.querySelector<HTMLElement>('.outline-controls');
  private outlineContainer = document.querySelector<HTMLElement>('#outline-container');
  private editorContainer = document.querySelector<HTMLElement>('#editor-container');

  // --- 静的ファクトリメソッド ---
  public static create() {
    const app = new App();
    app.initialize();
    return app;
  }

  // --- 初期化 ---
  private initialize() {
    if (!this.editorContainer || !this.fileListContainer || !this.outlineControls || !this.outlineContainer) {
      console.error("Fatal Error: A required UI container was not found."); return;
    }
    this.defineThemesAndFonts();

    this.editorExtensions = [
      history(), 
      keymap.of(historyKeymap), 
      markdown({ base: markdownLanguage }), 
      EditorView.lineWrapping,
      this.themeCompartment.of(this.lightTheme),
      this.fontFamilyCompartment.of(this.fontThemes[this.currentFontIndex]),
      this.fontSizeCompartment.of(this.createFontSizeTheme(this.currentFontSize)),
      EditorView.updateListener.of((update: ViewUpdate) => this.onEditorUpdate(update)),
    ];

    this.editorView = new EditorView({
      state: EditorState.create({ extensions: this.editorExtensions }),
      parent: this.editorContainer,
    });

    this.setupEventListeners();

    // ★★★ 非同期処理を、setTimeoutでメインスレッドから切り離す ★★★
    setTimeout(() => this.asyncPostInitialize(), 0);    
  }

  /**
   * すべての非同期初期化をここで行う
   */
  private async asyncPostInitialize() {
    // 1. Storeをロード
    this.store = await Store.load('.settings.dat');

    // 2. 設定を読み込み、状態変数を更新
    const settings = await this.store.get<AppSettings>('settings');
    if (settings) {
      this.isDarkMode = settings.isDarkMode ?? this.isDarkMode;
      this.currentFontIndex = settings.currentFontIndex ?? this.currentFontIndex;
      this.currentFontSize = settings.currentFontSize ?? this.currentFontSize;
    }

    // 3. 読み込んだ設定をUIに反映 (dispatchとクラスのトグル)
    this.editorView.dispatch({
      effects: [
        this.themeCompartment.reconfigure(this.isDarkMode ? this.darkTheme : this.lightTheme),
        this.fontFamilyCompartment.reconfigure(this.fontThemes[this.currentFontIndex]),
        this.fontSizeCompartment.reconfigure(this.createFontSizeTheme(this.currentFontSize)),
      ]
    });
    document.body.classList.toggle('dark-mode', this.isDarkMode);
    document.body.classList.remove(...this.fontClassNames);
    document.body.classList.add(this.fontClassNames[this.currentFontIndex]);
    this.updateBackground();
    await this.initializeBGM();

      // 4. 最後に開いていたファイルを復元
  if (settings && settings.sessionFilePaths) {
    const sessionFilePaths = settings.sessionFilePaths;
    console.log('[asyncPostInitialize] Restoring session files:', sessionFilePaths);
    
    // 保存されていたファイルを順番に(アクティブにしながら)開いていく
    for (const filePath of sessionFilePaths) {
      await this.openOrSwitchTab(filePath);
    }
  }
    await getCurrentWindow().show();
  }


  private defineThemesAndFonts() {
    const ivory = 'transparent', dark = '#333333', stone = '#555555', lightText = '#DDDDDD', darkText = '#333333';
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
    const serif = "'Yu Mincho', 'Hiragino Mincho ProN', serif", sansSerif = "'Tsukushi A Round Gothic','Hiragino Sans', 'Yu Gothic', sans-serif", monospace = "'Meiryo',Consolas, 'Osaka-Mono', monospace";
    this.fontThemes = [createFontTheme(serif), createFontTheme(sansSerif), createFontTheme(monospace)];
  }

  private createFontSizeTheme = (size: number) => EditorView.theme({ '&': { fontSize: `${size}pt` }, '.cm-gutters': { fontSize: `${size}pt` } });

  private async initializeBGM() {
    try {
      this.bgm = new Audio(backgroundMusic);
      this.bgm.loop = true;
    } catch(e) { console.error("Failed to initialize BGM", e); }
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
    document.querySelector('#btn-close')?.addEventListener('click', () => getCurrentWindow().close());
    document.querySelector('#btn-bgm-toggle')?.addEventListener('click', () => this.toggleBGM());
  }
  
  // --- イベントハンドラ ---
  private handleSidebarClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const path = target.dataset.path;
    const posStr = target.dataset.pos;
    if (target.classList.contains('file-entry') && path) this.openOrSwitchTab(path);
    else if (target.classList.contains('outline-text') && posStr) {
      const pos = parseInt(posStr, 10);
      this.editorView.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
      this.editorView.focus();
    } else if (target.classList.contains('toggle-collapse') && posStr) {
      const heading = this.activeFileHeadings.find(h => h.pos === parseInt(posStr, 10));
      if (heading) { heading.isCollapsed = !heading.isCollapsed; this.renderSidebar(); }
    } else if (target.id === 'collapse-all-btn') {
      this.activeFileHeadings.forEach(h => h.isCollapsed = true); this.renderSidebar();
    } else if (target.id === 'expand-all-btn') {
      this.activeFileHeadings.forEach(h => h.isCollapsed = false); this.renderSidebar();
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 's') { e.preventDefault(); this.saveActiveFile(); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 't') { e.preventDefault(); this.toggleDarkMode(); }
    if (isCtrlOrCmd && isShift && e.key.toLowerCase() === 'f') { e.preventDefault(); this.cycleEditorFont(); }
    if (isCtrlOrCmd && (e.code === 'Equal' || e.code === 'NumpadAdd')) { e.preventDefault(); this.changeFontSize(this.currentFontSize + 1); }
    if (isCtrlOrCmd && (e.code === 'Minus' || e.code === 'NumpadSubtract')) { e.preventDefault(); this.changeFontSize(this.currentFontSize - 1); }
    if (isCtrlOrCmd && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); this.changeFontSize(15); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'q') { e.preventDefault(); getCurrentWindow().close(); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'o') { e.preventDefault(); this.openNewFile(); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'n') { e.preventDefault(); this.createNewTab(); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'z' && !isShift) { e.preventDefault(); undo(this.editorView); }
    if (isCtrlOrCmd && (e.key.toLocaleLowerCase() === 'y' || (isShift && e.key.toLocaleLowerCase() === 'z'))) { e.preventDefault(); redo(this.editorView); }
    if (e.key === 'F11' || (isCtrlOrCmd && e.metaKey && e.key.toLocaleLowerCase() === 'f')) { // MacのCtrl+Cmd+F
      e.preventDefault();
      this.toggleFullscreen();
    }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'p' && isShift) { e.preventDefault(); this.toggleBGM(); }
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'r') { e.preventDefault(); } // リロードを無効化
    if (isCtrlOrCmd && e.key.toLocaleLowerCase() === 'r' && isShift) { e.preventDefault(); } 
  }

  private onEditorUpdate(update: ViewUpdate) {
    if (update.docChanged) {
      const activeTab = this.openTabs.find(t => t.path === this.activeTabPath);
      if (activeTab && !activeTab.isDirty) {
        activeTab.isDirty = true;
        this.renderSidebar(); // isDirty表示の更新のためだけ
      }
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

  // --- 2. アウトライン部分のHTMLを生成 ---
  if (this.activeTabPath && this.activeFileHeadings.length > 0) {
    this.outlineControls.style.display = 'flex';
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
    this.outlineControls.style.display = 'none';
    this.outlineContainer.innerHTML = '';
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
    this.editorView.dispatch({ effects: this.themeCompartment.reconfigure(this.isDarkMode ? this.darkTheme : this.lightTheme) });
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

  private async toggleFullscreen(){
      const window = getCurrentWindow();
      const isFullscreen = await window.isFullscreen();
      window.setFullscreen(!isFullscreen);
  }

  private async saveActiveFile() {
      if (!this.activeTabPath) return;
      const activeTab = this.openTabs.find(t => t.path === this.activeTabPath);
      if (!activeTab) return;
  
      try {
        const content = this.editorView.state.doc.toString();
        await invoke('write_file', { path: activeTab.path, content });
        this.parseHeadingsFromEditor(this.editorView);
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
      const state = EditorState.create({ extensions: this.editorExtensions });
      const tab = { path: newFilePath, state, isDirty: true }; // 最初から Dirty 状態
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

  private parseHeadingsFromEditor(view: EditorView) {
      const newHeadings: Heading[] = [];
      syntaxTree(view.state).iterate({
        enter: (node: TreeCursor) => {
          if (node.name.startsWith('ATXHeading')) {
            const level = parseInt(node.name.replace('ATXHeading', ''), 10);
            const headerMark = node.node.getChild('HeaderMark');
            const text = view.state.doc.sliceString(headerMark ? headerMark.to : node.from, node.to).trim();
            if (text) {
              const existing = this.activeFileHeadings.find(h => h.pos === node.from && h.text === text);
              newHeadings.push({ level, text, pos: node.from, isCollapsed: existing ? existing.isCollapsed : false });
            }
          }
        },
      });
      this.activeFileHeadings = newHeadings;
    }

private async openOrSwitchTab(filePath: string) {
  console.log(`[openOrSwitchTab] Opening: ${filePath}`);

  // 1. 既に開いているタブを探す
  let tab = this.openTabs.find(t => t.path === filePath);

  if (!tab) {
    // 2. タブがなければ、ファイルを読み込んで新しいタブを作る
    try {
      const content = await invoke('read_file', { path: filePath }) as string;
      const state = EditorState.create({ 
        doc: content, 
        extensions: this.editorExtensions 
      });
      tab = { path: filePath, state, isDirty: false };
      this.openTabs.push(tab);
      console.log(`[openOrSwitchTab] New tab created for: ${filePath}`);
    } catch (error) {
      console.error(`[openOrSwitchTab] Failed to open file: ${filePath}`, error);
      return;
    }
  }

  // 3. 状態を更新
  this.activeTabPath = filePath;
  
  // 4. ★★★ 最も重要 ★★★
  //    見つけた、あるいは新しく作った`tab`の`state`を、エディタに確実にセットする
  this.editorView.setState(tab.state);
  
  // 5. 現在のUI設定を再適用
  this.editorView.dispatch({
    effects: [
      this.themeCompartment.reconfigure(this.isDarkMode ? this.darkTheme : this.lightTheme),
      this.fontFamilyCompartment.reconfigure(this.fontThemes[this.currentFontIndex]),
      this.fontSizeCompartment.reconfigure(this.createFontSizeTheme(this.currentFontSize)),
    ]
  });

  // 6. UIを更新
  this.parseHeadingsFromEditor(this.editorView);
  this.renderSidebar();
  await this.saveSettings();
  this.editorView.focus();
}
}

// --- アプリケーションのエントリーポイント ---
window.addEventListener('DOMContentLoaded', () => {
  App.create();
});
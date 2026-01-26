// src/ai-chat-main.ts
import { AiChat, ChatSettings } from "./ai_chat";
import { Store } from "@tauri-apps/plugin-store";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";

// --- 型定義 ---
interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// --- MirrorShard独自形式 (Pastel形式) の型定義 ---
interface PastelMessage {
    currentlySelected: number;
    versions: {
        role: string;
        type: string;
        content?: { type: string, text: string }[] | null;
        steps?: { type: string, content: { type: string, text: string }[] }[] | null;
    }[];
}

interface PastelLog {
    name: string;
    createdAt: number;
    messages: PastelMessage[];
}

// --- DOM要素 ---
const chatLog = document.getElementById('chat-log')!;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const apiSelector = document.getElementById('api-selector') as HTMLSelectElement;
const TRANSPARENT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// --- State ---
let chatHistory: ChatMessage[] = [];
let isProcessing = false;
let currentFilePath: string | null = null;
let aiSettings: ChatSettings = { apiType: 'gemini' };
let store: Store | null = null;
let userName = 'User';
let aiName = 'AI';
let userIconSrc = '';
let aiIconSrc = '';
const osType = await type();

const aiChat = new AiChat(onAiUpdate);

function onAiUpdate(text: string, isFinal: boolean) {
    const lastMsgIdx = chatHistory.length - 1;
    if (lastMsgIdx >= 0 && chatHistory[lastMsgIdx].role === 'assistant') {
        chatHistory[lastMsgIdx].content = text;
    } else {
        chatHistory.push({ role: 'assistant', content: text });
    }

    const bubble = document.querySelector(`[data-message-id='${lastMsgIdx}'] .message-bubble`);
    if (bubble) {
        bubble.innerHTML = marked.parse(text) as string;
    } else {
        addMessageToLog('assistant', text, lastMsgIdx);
    }

    autoScroll();
    if (isFinal) setUiLocked(false);
}

// --- 初期化 ---
async function init() {
    try {
        store = await Store.load('.settings.dat');

        const apiKey = await store.get<string>('geminiApiKey');
        const model = await store.get<string>('geminiModel');
        const localUrl = await store.get<string>('localLlmUrl');
        const sysPrompt = await store.get<string>('aiSystemPrompt');
        const maxTokens = await store.get<number>('aiMaxTokens') || 2000;
        const savedApiType = await store.get<string>('selectedApiType') || 'gemini';
        const isDark = await store.get<boolean>('isDarkMode');
        if (isDark) {
            document.body.classList.add('dark-mode');
        }

        aiSettings = {
            apiType: (savedApiType as 'gemini' | 'local'),
            geminiApiKey: apiKey || undefined,
            geminiModel: model || undefined,
            localUrl: localUrl || undefined,
            systemPrompt: sysPrompt || undefined,
            maxTokens: maxTokens
        };

        apiSelector.value = savedApiType;
        await aiChat.updateSettings(aiSettings);
        await loadProfileSettings();

        setupEventListeners();
        setupSettingsListener();
        setupThemeListener();

        // 前回セッションのロード（※Mac版で動作しないので一旦コメントアウト）
        // const lastSessionPath = await store.get<string>('lastAiChatSessionPath');
        // if (lastSessionPath) {
        //     console.log("Auto-loading session:", lastSessionPath);
        //     await loadLogFile(lastSessionPath);
        // }

    } catch (e) {
        console.error("Init Error:", e);
    }
}

// プロフィール読み込み関数
async function loadProfileSettings() {
    if (!store) return;
    userName = await store.get<string>('aiChatUserName') || 'User';
    aiName = await store.get<string>('aiChatAiName') || 'AI';

    const uPath = await store.get<string>('aiChatUserIconPath');
    userIconSrc = uPath ? convertFileSrc(uPath) : TRANSPARENT_ICON; // convertFileSrcでasset://URLに変換

    const aPath = await store.get<string>('aiChatAiIconPath');
    aiIconSrc = aPath ? convertFileSrc(aPath) : TRANSPARENT_ICON;
}

function setupSettingsListener() {
    listen('settings-changed', async (event: any) => {
        const p = event.payload;
        aiSettings.geminiApiKey = p.geminiApiKey ?? aiSettings.geminiApiKey;
        aiSettings.geminiModel = p.geminiModel ?? aiSettings.geminiModel;
        aiSettings.localUrl = p.localLlmUrl ?? aiSettings.localUrl;
        aiSettings.systemPrompt = p.aiSystemPrompt ?? aiSettings.systemPrompt;
        aiSettings.maxTokens = p.aiMaxTokens ?? aiSettings.maxTokens;
        await aiChat.updateSettings(aiSettings);
        // プロフィールの更新
        if (p.aiChatUserName !== undefined) userName = p.aiChatUserName;
        if (p.aiChatAiName !== undefined) aiName = p.aiChatAiName;
        // アイコンパスが送られてきたらURL変換
        if (p.aiChatUserIconPath !== undefined) {
            userIconSrc = p.aiChatUserIconPath ? convertFileSrc(p.aiChatUserIconPath) : TRANSPARENT_ICON;
        }
        if (p.aiChatAiIconPath !== undefined) {
            aiIconSrc = p.aiChatAiIconPath ? convertFileSrc(p.aiChatAiIconPath) : TRANSPARENT_ICON;
        }
        // ログを再描画して新しい名前/アイコンを反映
        redrawLog();
    });
}

// テーマ同期リスナー
function setupThemeListener() {
    listen('app:theme-changed', (event: any) => {
        const isDark = event.payload.isDarkMode;
        document.body.classList.toggle('dark-mode', isDark);
    });
}

function setupEventListeners() {
    apiSelector.addEventListener('change', async () => {
        const newType = apiSelector.value as 'gemini' | 'local';
        aiSettings.apiType = newType;
        await aiChat.updateSettings(aiSettings);
        if (store) {
            await store.set('selectedApiType', newType);
            await store.save();
        }
        showNotification(`Switched to ${newType === 'gemini' ? 'Gemini' : 'Local LLM'}`);
    });

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (!text || isProcessing) return;
        await processUserMessage(text);
    });

    // --- ショートカットキー ---
    document.addEventListener('keydown', async (e) => {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        const key = e.key.toLowerCase();
        const isMac = osType === 'macos';
        const isCtrl = e.ctrlKey;
        const isCmd = e.metaKey;

        // 入力欄にフォーカスがある場合、一部のショートカットは無効化するか、挙動を変える
        // ただし Ctrl+S などは効かせたいので、ここでは除外判定は緩めに

        // Ctrl + T : ダークモード切替
        if (isCtrlOrCmd && key === 't' && !isShift) {
            e.preventDefault();
            await emit('subwindow-toggle-theme');
            return;
        }

        // Ctrl + S : 上書き保存
        if (isCtrlOrCmd && !isShift && key === 's') {
            e.preventDefault();
            await saveLogOverwrite();
            return;
        }

        // Ctrl + O : 読み込み
        if (isCtrlOrCmd && !isShift && key === 'o') {
            e.preventDefault();
            await loadLog();
            return;
        }

        // Ctrl + Shift + C : ログクリア
        if (isCtrlOrCmd && isShift && key === 'c') {
            e.preventDefault();
            // 入力欄でのコピー操作と被らないよう注意が必要だが、
            // 何も選択されていなければ発動、あるいはShift付きはクリアに割り当ててあるのでOK
            await clearLog();
            return;
        }

        // Ctrl + Shift + A : ウィンドウを閉じる
        if (isCtrlOrCmd && isShift && key === 'a') {
            e.preventDefault();
            await getCurrentWindow().close();
            return;
        }

        // F11 : 最大化トグル(Win/Linux)
        if (!isMac && e.key === 'F11') {
            e.preventDefault();
            await getCurrentWindow().toggleMaximize();
            return;
        }
        // 最大化トグル(Mac)
        if (isMac && isCtrl && isCmd && key === 'f') {
            e.preventDefault();
            await getCurrentWindow().toggleMaximize();
            return;
        }
    });

    messageInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    document.getElementById('ai-close-btn')?.addEventListener('click', () => getCurrentWindow().close());
    document.getElementById('ai-fullscreen-btn')?.addEventListener('click', () => getCurrentWindow().toggleMaximize());

    document.getElementById('ai-clear-log-btn')?.addEventListener('click', clearLog);
    document.getElementById('ai-save-log-btn')?.addEventListener('click', saveLogAs);
    document.getElementById('ai-save-overwrite-btn')?.addEventListener('click', saveLogOverwrite);
    document.getElementById('ai-load-log-btn')?.addEventListener('click', loadLog);

    messageInput.addEventListener('input', resizeTextarea);
}

// --- ロジック ---
async function processUserMessage(text: string) {
    setUiLocked(true);
    chatHistory.push({ role: 'user', content: text });
    addMessageToLog('user', text, chatHistory.length - 1);

    messageInput.value = '';
    resizeTextarea();

    chatHistory.push({ role: 'assistant', content: '...' });
    addMessageToLog('assistant', '...', chatHistory.length - 1);

    const historyToSend = chatHistory.slice(0, -1);
    await aiChat.sendMessage(historyToSend);
}

function setUiLocked(locked: boolean) {
    isProcessing = locked;
    sendBtn.disabled = locked;
    messageInput.disabled = locked;
    const controls = document.querySelectorAll('.action-btn');
    controls.forEach(el => (el as HTMLButtonElement).disabled = locked);
}

function addMessageToLog(role: string, content: string, index: number) {
    const row = document.createElement('div');
    row.className = `message-row ${role}`;
    row.dataset.messageId = String(index);

    let htmlContent = "";
    if (role === 'assistant') {
        htmlContent = content === '...' ? '...' : (marked.parse(content) as string);
    } else {
        const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        htmlContent = escaped.replace(/\n/g, '<br>');
    }

    // ★ userName, aiName, userIconSrc, aiIconSrc 変数を使用
    const currentName = role === 'user' ? userName : aiName;
    const currentIcon = role === 'user' ? userIconSrc : aiIconSrc;

    row.innerHTML = `
        <div class="avatar-container">
            <img class="message-icon" src="${currentIcon}">
            <div class="message-actions">
                ${role === 'user'
            ? `<button class="action-btn btn-edit" onclick="window.editMsg(${index})"></button>
                       <button class="action-btn btn-delete" onclick="window.deleteMsg(${index})"></button>`
            : `<button class="action-btn btn-regenerate" onclick="window.regenMsg(${index})"></button>
                       <button class="action-btn btn-copy" onclick="window.copyMsg(${index})"></button>`
        }
            </div>
        </div>
        <div class="message-content">
            <div class="message-sender">${currentName}</div>
            <div class="message-bubble">${htmlContent}</div>
        </div>
    `;

    const existing = document.querySelector(`[data-message-id='${index}']`);
    if (existing) {
        existing.replaceWith(row);
    } else {
        chatLog.appendChild(row);
    }
    autoScroll();
}

function resizeTextarea() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 240) + 'px';
}

function autoScroll() {
    chatLog.scrollTop = chatLog.scrollHeight;
}

function redrawLog() {
    chatLog.innerHTML = '';
    chatHistory.forEach((msg, idx) => addMessageToLog(msg.role, msg.content, idx));
}

function showNotification(msg: string) {
    const container = document.getElementById('notification-container')!;
    const div = document.createElement('div');
    div.className = 'toast-notification show';
    div.textContent = msg;
    container.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// --- ログ保存/読込 (独自形式対応) ---

/**
 * 独自形式(Pastel)のJSONを読み込んでチャット履歴に変換
 */
function parsePastelLog(data: any): ChatMessage[] {
    if (!data.messages || !Array.isArray(data.messages)) return [];

    const history = data.messages.map((m: any) => {
        // currentlySelected を使ってバージョンを選択
        const selectedIdx = m.currentlySelected ?? 0;
        const v = m.versions?.[selectedIdx];
        if (!v) return null;

        // ロールの決定
        const finalRole = (v.role === 'model' || v.role === 'AI') ? 'assistant' : v.role;
        let t = '';

        // SingleStep (User等)
        if (v.type === 'singleStep' && v.content?.[0]?.text) {
            t = v.content[0].text;
        }
        // MultiStep (Assistant等)
        else if (v.type === 'multiStep' && v.steps) {
            // Electron版と同じく 'contentBlock' を探す
            const cs = v.steps.find((s: any) => s.type === 'contentBlock');
            if (cs?.content?.[0]?.text) {
                t = cs.content[0].text;
            } else {
                return null;
            }
        } else {
            return null;
        }

        return { role: finalRole, content: t.trim() };
    }).filter((item: any) => item !== null) as ChatMessage[];

    return history;
}

/**
 * 標準的な LM Studio / OpenAI 形式の解析
 * { messages: [{ role: "user", content: "..." }] }
 */
function parseLmStudioLog(messages: any[]): ChatMessage[] {
    return messages
        .filter(m => m && m.role && m.content)
        .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        }));
}


/**
 * チャット履歴を独自形式(Pastel)のJSONに変換
 */
function convertToPastelLog(history: ChatMessage[]): PastelLog {
    return {
        name: "AI",
        createdAt: Date.now(),
        messages: history.map(msg => ({
            currentlySelected: 0,
            versions: [{
                role: msg.role === 'assistant' ? 'assistant' : 'user', // Electron版に合わせるなら 'assistant'
                type: msg.role === 'user' ? 'singleStep' : 'multiStep',
                // userの場合はcontent
                content: msg.role === 'user' ? [{ type: 'text', text: msg.content }] : undefined,
                // assistantの場合はsteps (Electron版の実装に基づく)
                steps: msg.role === 'assistant'
                    ? [{ type: 'contentBlock', content: [{ type: 'text', text: msg.content }] }]
                    : undefined,
            }]
        }))
    };
}

/**
 * ログ読み込みのメイン関数 (自動判別)
 */
async function loadLogFile(path: string) {
    try {
        const text = await readTextFile(path);
        const parsed = JSON.parse(text);

        let loadedHistory: ChatMessage[] = [];

        // 1. Gemini形式 (chunkedPrompt)
        if (parsed.chunkedPrompt?.chunks) {
            console.log("Format: Gemini");
            loadedHistory = parsed.chunkedPrompt.chunks
                .filter((c: any) => !c.isThought && c.text)
                .map((c: any) => ({
                    role: c.role === 'model' ? 'assistant' : 'user',
                    content: c.text
                }));
        }
        // 2. MirrorShard独自形式 (Pastel)
        // messagesを持ち、かつ中身の構造が versions を持っている場合
        else if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0 && parsed.messages[0].versions) {
            console.log("Format: MirrorShard (Pastel)");
            loadedHistory = parsePastelLog(parsed);
        }
        // 3. LM Studio / OpenAI形式 (messages配列を持つ標準JSON)
        else if (parsed.messages && Array.isArray(parsed.messages)) {
            console.log("Format: LM Studio (Object)");
            loadedHistory = parseLmStudioLog(parsed.messages);
        }
        // 4. ルートが配列の標準形式
        else if (Array.isArray(parsed)) {
            console.log("Format: Generic Array");
            loadedHistory = parseLmStudioLog(parsed);
        }
        else {
            throw new Error("Unknown log format");
        }

        if (loadedHistory.length === 0) {
            throw new Error("Log parsed but no messages found.");
        }

        chatHistory = loadedHistory;
        currentFilePath = path;
        redrawLog();

        // 読み込み成功時のみ通知（自動ロード時はうるさいので抑制しても良い）
        if (document.activeElement !== document.body) {
            // 簡易判定: ユーザー操作中（フォーカスがある）なら通知
            showNotification('Loaded!');
        }

        if (store) {
            await store.set('lastAiChatSessionPath', currentFilePath);
            await store.save();
        }

    } catch (e) {
        console.error("Load failed:", e);
        // 自動ロードでの失敗時はアラートを出さない（ファイル移動・削除の可能性があるため）
        // 明示的な操作のときだけ出すのが理想ですが、一旦コンソールのみに
        // alert(`Load failed: ${e}`); 
        showNotification(`Load Error: ${String(e).substring(0, 30)}...`);
    }
}

async function saveLogOverwrite() {
    if (!currentFilePath) return saveLogAs();
    try {
        // 独自形式に変換して保存
        const pastelData = convertToPastelLog(chatHistory);
        await writeTextFile(currentFilePath, JSON.stringify(pastelData, null, 2));

        showNotification('Saved!');
        if (store) {
            await store.set('lastAiChatSessionPath', currentFilePath);
            await store.save();
        }
    } catch (e) {
        alert('Save failed: ' + e);
    }
}

async function saveLogAs() {
    const path = await save({ filters: [{ name: 'MirrorShard Log', extensions: ['json'] }] });
    if (!path) return;
    currentFilePath = path;
    await saveLogOverwrite();
}

async function clearLog() {
    const yes = await ask('All logs will be cleared. Are you sure?', { title: 'MirrorShard AI', kind: 'warning' });
    if (!yes) return;
    chatHistory = [];
    chatLog.innerHTML = '';
    currentFilePath = null;
    if (store) {
        await store.set('lastAiChatSessionPath', null);
        await store.save();
    }
}

async function loadLog() {
    const path = await open({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path || typeof path !== 'string') return;
    await loadLogFile(path);
}

// --- グローバル操作関数 ---

(window as any).editMsg = async (idx: number) => {
    if (isProcessing) return;
    const row = document.querySelector(`[data-message-id='${idx}']`);
    if (!row) return;
    const bubble = row.querySelector('.message-bubble') as HTMLElement;
    if (!bubble) return;
    if (row.querySelector('.edit-container')) return;

    const originalContent = chatHistory[idx].content;
    bubble.style.display = 'none';

    const editContainer = document.createElement('div');
    editContainer.className = 'edit-container';
    editContainer.style.width = '100%';

    const textarea = document.createElement('textarea');
    textarea.value = originalContent;
    textarea.rows = 3;
    textarea.className = 'cyber-text';
    textarea.style.width = '100%';
    textarea.style.boxSizing = 'border-box';
    textarea.style.marginTop = '5px';
    textarea.style.marginBottom = '5px';

    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '10px';
    btnContainer.style.justifyContent = 'flex-end';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'OK';
    saveBtn.className = 'cyber-button';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'cyber-button';

    saveBtn.onclick = async () => {
        const newText = textarea.value.trim();
        if (!newText || newText === originalContent) {
            cancelEdit();
            return;
        }
        chatHistory = chatHistory.slice(0, idx);
        redrawLog();
        await processUserMessage(newText);
    };

    const cancelEdit = () => {
        bubble.style.display = 'block';
        editContainer.remove();
    };
    cancelBtn.onclick = cancelEdit;

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(saveBtn);
    editContainer.appendChild(textarea);
    editContainer.appendChild(btnContainer);
    bubble.parentElement?.appendChild(editContainer);
    textarea.focus();
};

(window as any).deleteMsg = async (idx: number) => {
    if (isProcessing) return;
    const yes = await ask("Delete this message and all following?", {
        title: 'Confirm Deletion', kind: 'warning'
    });
    if (!yes) return;
    chatHistory = chatHistory.slice(0, idx);
    redrawLog();
};

(window as any).regenMsg = async (idx: number) => {
    if (isProcessing) return;
    chatHistory = chatHistory.slice(0, idx);
    redrawLog();
    setUiLocked(true);
    chatHistory.push({ role: 'assistant', content: '...' });
    addMessageToLog('assistant', '...', chatHistory.length - 1);
    const historyToSend = chatHistory.slice(0, -1);
    await aiChat.sendMessage(historyToSend);
};

(window as any).copyMsg = async (idx: number) => {
    const content = chatHistory[idx].content;
    await writeText(content);
    showNotification("Copied!");
};

init();
// src/ai-chat.ts
import { GoogleGenerativeAI, GenerativeModel, ChatSession } from "@google/generative-ai";

export interface ChatSettings {
    apiType: 'gemini' | 'local';
    geminiApiKey?: string;
    geminiModel?: string;
    localUrl?: string;
    localModel?: string;
    systemPrompt?: string;
    maxTokens?: number;
}

export class AiChat {
    private genAI: GoogleGenerativeAI | null = null;
    private model: GenerativeModel | null = null;
    private chatSession: ChatSession | null = null;
    private currentSettings: ChatSettings = { apiType: 'gemini' };

    private onUpdate: (text: string, isFinal: boolean) => void;

    constructor(onUpdate: (text: string, isFinal: boolean) => void) {
        this.onUpdate = onUpdate;
    }

    public async updateSettings(settings: ChatSettings) {
        this.currentSettings = settings;
        if (this.currentSettings.apiType === 'gemini') {
            const apiKey = this.currentSettings.geminiApiKey;
            const modelName = this.currentSettings.geminiModel || "gemini-2.5-flash";
            if (apiKey) {
                this.genAI = new GoogleGenerativeAI(apiKey);
                this.model = this.genAI.getGenerativeModel({
                    model: modelName,
                    systemInstruction: this.currentSettings.systemPrompt
                });
                this.startNewSession();
            }
        }
    }

    public startNewSession() {
        if (this.currentSettings.apiType === 'gemini' && this.model) {
            this.chatSession = this.model.startChat({
                history: [],
                generationConfig: {
                    maxOutputTokens: this.currentSettings.maxTokens || 2000,
                }
            });
        }
    }

    public async sendMessage(history: { role: string, content: string }[]) {
        const lastMsg = history[history.length - 1];
        if (!lastMsg || lastMsg.role !== 'user') return;

        if (this.currentSettings.apiType === 'gemini') {
            await this.sendToGemini(lastMsg.content);
        } else {
            await this.sendToLocalLLM(history);
        }
    }

    private async sendToGemini(text: string) {
        if (!this.chatSession) {
            this.onUpdate("Error: Gemini session not initialized.", true);
            return;
        }
        try {
            const result = await this.chatSession.sendMessageStream(text);
            let fullText = "";
            for await (const chunk of result.stream) {
                fullText += chunk.text();
                this.onUpdate(fullText, false);
            }
            this.onUpdate(fullText, true);
        } catch (error) {
            console.error("Gemini Error:", error);
            this.onUpdate(`Error: ${String(error)}`, true);
        }
    }

    // Local LLMをストリーミング対応に書き換え
    private async sendToLocalLLM(history: { role: string, content: string }[]) {
        const url = this.currentSettings.localUrl || "http://127.0.0.1:1234/v1/chat/completions";
        const model = this.currentSettings.localModel || "local-model";

        const messages = [];
        if (this.currentSettings.systemPrompt) {
            messages.push({ role: "system", content: this.currentSettings.systemPrompt });
        }
        messages.push(...history);

        const maxTokens = this.currentSettings.maxTokens || 2000;

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: messages,
                    stream: true, // ストリーミング有効化
                    max_tokens: maxTokens, // API側への制限指示
                    temperature: 0.7,
                    model: model
                })
            });

            if (!response.ok) throw new Error(`Status ${response.status}`);
            if (!response.body) throw new Error("No response body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let fullText = "";
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // 行ごとに処理 (SSE形式: data: {...})
                const lines = buffer.split('\n');
                buffer = lines.pop() || ""; // 最後の不完全な行はバッファに戻す

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === "data: [DONE]") continue;
                    if (trimmed.startsWith("data: ")) {
                        try {
                            const json = JSON.parse(trimmed.substring(6));
                            const delta = json.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullText += delta;
                                // 念の為、クライアント側でも文字数制限チェック
                                if (fullText.length > maxTokens * 4) { // トークン数≒文字数*0.5~1.5なので余裕を持たせる
                                    reader.cancel();
                                    break;
                                }
                                this.onUpdate(fullText, false);
                            }
                        } catch (e) {
                            // JSONパースエラーは無視して次へ
                        }
                    }
                }
            }
            this.onUpdate(fullText, true);

        } catch (error) {
            console.error("Local LLM Stream Error:", error);
            this.onUpdate(`Error: ${String(error)}`, true);
        }
    }
}
// src/ai-chat.ts
import { GoogleGenerativeAI, GenerativeModel, ChatSession } from "@google/generative-ai";

export interface ChatSettings {
    apiType: 'gemini' | 'groq' | 'local';
    geminiApiKey?: string;
    geminiModel?: string;
    groqApiKey?: string;
    groqModel?: string;
    localUrl?: string;
    localModel?: string;
    systemPrompt?: string;
    maxTokens?: number;
}

export class AiChat {
    private genAI: GoogleGenerativeAI | null = null;
    private model: GenerativeModel | null = null;
    private chatSession: ChatSession | null = null;
    // 初期値の型エラーを回避
    private currentSettings: ChatSettings = { apiType: 'gemini' };

    private onUpdate: (text: string, isFinal: boolean) => void;

    constructor(onUpdate: (text: string, isFinal: boolean) => void) {
        this.onUpdate = onUpdate;
    }

    public async updateSettings(settings: ChatSettings) {
        this.currentSettings = settings;
        // Geminiの場合のみSDKの初期化が必要
        if (this.currentSettings.apiType === 'gemini') {
            const apiKey = this.currentSettings.geminiApiKey;
            const modelName = this.currentSettings.geminiModel || "gemini-3.1-flash-lite-preview";
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
        } else if (this.currentSettings.apiType === 'groq') {
            await this.sendToGroq(history);
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

    // Groq用の送信処理 (OpenAI互換形式)
    private async sendToGroq(history: { role: string, content: string }[]) {
        const url = "https://api.groq.com/openai/v1/chat/completions";
        const apiKey = this.currentSettings.groqApiKey;
        const model = this.currentSettings.groqModel || "llama-3.3-70b-versatile";

        if (!apiKey) {
            this.onUpdate("Error: Groq API Key is not set.", true);
            return;
        }

        // 認証ヘッダーを付与して共通のストリーミング処理へ
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        };

        await this.fetchOpenAICompatibleStream(url, model, history, headers);
    }

    private async sendToLocalLLM(history: { role: string, content: string }[]) {
        const url = this.currentSettings.localUrl || "http://127.0.0.1:1234/v1/chat/completions";
        const model = this.currentSettings.localModel || "local-model";
        const headers = { "Content-Type": "application/json" };

        await this.fetchOpenAICompatibleStream(url, model, history, headers);
    }

    // Local LLMとGroqで共通のSSEストリーミング処理
    private async fetchOpenAICompatibleStream(url: string, model: string, history: any[], headers: any) {
        const messages = [];
        if (this.currentSettings.systemPrompt) {
            messages.push({ role: "system", content: this.currentSettings.systemPrompt });
        }
        messages.push(...history);

        const maxTokens = this.currentSettings.maxTokens || 2000;

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: headers,
                body: JSON.stringify({
                    messages: messages,
                    stream: true,
                    max_tokens: maxTokens,
                    temperature: 0.7,
                    model: model
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error?.message || `Status ${response.status}`);
            }
            if (!response.body) throw new Error("No response body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let fullText = "";
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === "data: [DONE]") continue;
                    if (trimmed.startsWith("data: ")) {
                        try {
                            const json = JSON.parse(trimmed.substring(6));
                            const delta = json.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullText += delta;
                                if (fullText.length > maxTokens * 4) {
                                    reader.cancel();
                                    break;
                                }
                                this.onUpdate(fullText, false);
                            }
                        } catch (e) { }
                    }
                }
            }
            this.onUpdate(fullText, true);

        } catch (error) {
            console.error("Stream Error:", error);
            this.onUpdate(`Error: ${String(error)}`, true);
        }
    }
}
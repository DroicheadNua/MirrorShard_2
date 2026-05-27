// src/ai-chat.ts
import {
  GoogleGenerativeAI,
  GenerativeModel,
  ChatSession,
} from "@google/generative-ai";
import { t } from "./i18n";

export interface ChatSettings {
  apiType:
    | "gemini"
    | "groq"
    | "cerebras"
    | "openrouter"
    | "cohere"
    | "mistral"
    | "local";
  geminiApiKey?: string;
  geminiModel?: string;
  groqApiKey?: string;
  groqModel?: string;
  cerebrasApiKey?: string;
  cerebrasModel?: string;
  openRouterApiKey?: string;
  openRouterModel?: string;
  cohereApiKey?: string;
  cohereModel?: string;
  mistralApiKey?: string;
  mistralAgentID?: string;
  mistralModel?: string;
  localUrl?: string;
  localModel?: string;
  systemPrompt?: string;
  maxTokens?: number;
  enableMistralAgents?: boolean;
}

export class AiChat {
  private genAI: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;
  private chatSession: ChatSession | null = null;
  // 初期値の型エラーを回避
  private currentSettings: ChatSettings = { apiType: "gemini" };

  private onUpdate: (text: string, isFinal: boolean) => void;

  constructor(onUpdate: (text: string, isFinal: boolean) => void) {
    this.onUpdate = onUpdate;
  }

  public async updateSettings(settings: ChatSettings) {
    this.currentSettings = settings;
    // Geminiの場合のみSDKの初期化が必要
    if (this.currentSettings.apiType === "gemini") {
      const apiKey = this.currentSettings.geminiApiKey;
      const modelName =
        this.currentSettings.geminiModel || "gemini-3.1-flash-lite";
      if (apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: this.currentSettings.systemPrompt,
        });
        this.startNewSession();
      }
    }
  }

  public startNewSession() {
    if (this.currentSettings.apiType === "gemini" && this.model) {
      this.chatSession = this.model.startChat({
        history: [],
        generationConfig: {
          maxOutputTokens: this.currentSettings.maxTokens || 2000,
        },
      });
    }
  }

  public async sendMessage(history: { role: string; content: string }[]) {
    const lastMsg = history[history.length - 1];
    if (!lastMsg || lastMsg.role !== "user") return;

    const apiType = this.currentSettings.apiType;

    if (apiType === "gemini") {
      await this.sendToGemini(lastMsg.content);
    } else if (apiType === "cohere") {
      await this.sendToCohereV2Stream(history);
    } else {
      // Groq, Mistral, Local
      let url = "";
      let apiKey = "";
      let model = "";
      let targetAgentId: string | undefined = undefined;

      if (apiType === "groq") {
        url = "https://api.groq.com/openai/v1/chat/completions";
        apiKey = this.currentSettings.groqApiKey || "";
        model = this.currentSettings.groqModel || "llama-3.3-70b-versatile";
      } else if (apiType === "cerebras") {
        url = "https://api.cerebras.ai/v1/chat/completions";
        apiKey = this.currentSettings.cerebrasApiKey || "";
        model = this.currentSettings.cerebrasModel || "llama3.1-8b";
      } else if (apiType === "openrouter") {
        url = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = this.currentSettings.openRouterApiKey || "";
        model = this.currentSettings.openRouterModel || "openrouter/owl-alpha";
      } else if (apiType === "mistral") {
        // スイッチがON かつ IDがある場合のみ Agent モード判定
        const isAgentActive =
          this.currentSettings.enableMistralAgents &&
          !!this.currentSettings.mistralAgentID;
        // Agent IDがあれば専用エンドポイントへ、なければ通常エンドポイントへ
        url = isAgentActive
          ? "https://api.mistral.ai/v1/agents/completions"
          : "https://api.mistral.ai/v1/chat/completions";
        apiKey = this.currentSettings.mistralApiKey || "";
        model = this.currentSettings.mistralModel || "mistral-small-latest";
        // アクティブな時だけIDをセットする
        if (isAgentActive) {
          targetAgentId = this.currentSettings.mistralAgentID;
        }
      } else if (apiType === "local") {
        url =
          this.currentSettings.localUrl ||
          "http://127.0.0.1:1234/v1/chat/completions";
        apiKey = "local";
        model = this.currentSettings.localModel || "local-model";
      }

      if (apiType !== "local" && !apiKey) {
        this.onUpdate(t("aiChat.error.noApiKey", { api: apiType }), true);
        return;
      }

      await this.sendToOpenAICompatibleStream(
        url,
        apiKey,
        model,
        history,
        targetAgentId,
      );
    }
  }

  private async sendToGemini(text: string) {
    if (!this.chatSession) {
      this.onUpdate(t("aiChat.error.geminiNotInitialized"), true);
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
      this.onUpdate(
        t("aiChat.error.geminiError", { detail: String(error) }),
        true,
      );
    }
  }

  // --- Cohere v2 専用ストリーミング処理 ---
  private async sendToCohereV2Stream(
    history: { role: string; content: string }[],
  ) {
    const url = "https://api.cohere.com/v2/chat";
    const apiKey = this.currentSettings.cohereApiKey;
    const model = this.currentSettings.cohereModel || "command-r-plus-08-2024";

    if (!apiKey) {
      this.onUpdate(t("aiChat.error.cohereNoApiKey"), true);
      return;
    }

    const messages = [];
    if (this.currentSettings.systemPrompt) {
      messages.push({
        role: "system",
        content: this.currentSettings.systemPrompt,
      });
    }
    messages.push(...history);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `Status ${response.status}`);
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
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 不完全な行は次回へ持ち越し

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // SSE形式（data: ）のプレフィックスを外す
          let jsonStr = trimmed;
          if (trimmed.startsWith("data: ")) {
            jsonStr = trimmed.substring(6);
          }
          if (jsonStr === "[DONE]") continue;

          try {
            const json = JSON.parse(jsonStr);
            // ★ Cohere v2 特有のストリーミング形式をパース
            if (
              json.type === "content-delta" &&
              json.delta?.message?.content?.text
            ) {
              fullText += json.delta.message.content.text;

              // 暴走ストップ（文字数換算として余裕を持たせる）
              const maxTokens = this.currentSettings.maxTokens || 2000;
              if (fullText.length > maxTokens * 4) {
                reader.cancel();
                break;
              }
              this.onUpdate(fullText, false);
            }
          } catch {
            // チャンク分割の都合でJSONがパースできない時は無視
          }
        }
      }
      this.onUpdate(fullText, true);
    } catch (error) {
      console.error("Cohere Stream Error:", error);
      this.onUpdate(
        t("aiChat.error.cohereError", { detail: String(error) }),
        true,
      );
    }
  }

  // 汎用ストリーミング関数
  private async sendToOpenAICompatibleStream(
    url: string,
    apiKey: string,
    model: string,
    history: any[],
    agentId?: string,
  ) {
    const apiType = this.currentSettings.apiType;
    const messages = [];
    if (this.currentSettings.systemPrompt) {
      messages.push({
        role: "system",
        content: this.currentSettings.systemPrompt,
      });
    }
    messages.push(...history);

    const maxTokens = this.currentSettings.maxTokens || 2000;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey !== "local") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // リクエストボディを動的に構築
    const requestBody: any = {
      messages: messages,
      stream: true,
      max_tokens: maxTokens,
    };

    // 「今の設定がMistral」かつ「Agent IDがある」時だけ agent_id を使う
    if (apiType === "mistral" && agentId) {
      requestBody.agent_id = agentId;
    } else {
      // それ以外（Groq, LM Studio等）は model を使う
      requestBody.model = model;
      requestBody.temperature = 0.7;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error (${response.status}): ${errText}`);
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
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const json = JSON.parse(trimmed.substring(6));
              const delta = json.choices?.[0]?.delta;

              if (delta) {
                // 1. 通常のテキスト（content）がある場合
                if (typeof delta.content === "string") {
                  fullText += delta.content;
                }

                // 2. ツール呼び出し（tool_calls）がある場合
                if (Array.isArray(delta.tool_calls)) {
                  for (const call of delta.tool_calls) {
                    const args = call.function?.arguments;
                    // ここも string であることを厳密にチェック
                    if (typeof args === "string") {
                      fullText += args;
                    }
                  }
                }
                this.onUpdate(fullText, false);
              }
            } catch {
              /* 不完全なチャンクは無視 */
            }
          }
        }
      }
      this.onUpdate(fullText, true);
    } catch (error) {
      console.error("Stream Error:", error);
      this.onUpdate(
        t("aiChat.error.streamError", { detail: String(error) }),
        true,
      );
    }
  }
}

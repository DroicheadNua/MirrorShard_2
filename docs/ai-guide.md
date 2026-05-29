# **MirrorShard 2 – AI Guide**

**Note:** This document may include descriptions of features still under development.
Actual functionality may differ from the distributed binaries.

This guide is intended for users who want a comprehensive understanding of MirrorShard’s AI features.
If you are new, it is recommended to start with the **Quick Guide**.

---

# AI Features in MirrorShard 2

MirrorShard 2 provides AI assistance across multiple components:

* Main Editor
* AI Chat Window
* Idea Processor
* OpenCode Window (requires OpenCode)
* SillyTavern Window (requires SillyTavern)

Additionally:

* If **Stable Diffusion Web UI** (AUTOMATIC1111, Forge, Forge Neo, stable-diffusion.cpp, etc.) is installed, it can be used for image generation.
* If **Obscura** (a Rust-based headless browser) is installed, AI can perform web searches from the chat window.

---

# Supported AI Providers

* Cloud AI (API key required):

  * Google Gemini
  * Groq
  * Cohere
  * Mistral
  * Cerebras
  * OpenRouter

* Local AI:

  * LM Studio
  * Ollama
  * Other compatible local runtimes

---

# Table of Contents

1. Setting Up AI
2. Switching AI Providers
3. Feature Usage
4. External Tool Integration
5. Image Generation
6. Notes & Limitations
7. Free Usage
8. Design Philosophy

---

# 1. Setting Up AI

## Gemini

1. Log in to Google AI Studio
2. Click **"Get API key" → "Create API key in new project"**
3. Copy the key
4. Paste it into MirrorShard → Settings → AI Settings → Gemini API Key

---

## Groq

Groq is known for extremely fast response speeds.

1. Log in to Groq
2. Open **API Keys**
3. Copy your key (shown only once)
4. Paste into MirrorShard settings

---

## Cerebras

Known for ultra-high-speed inference (up to thousands of tokens/sec).

1. Log in and open **API Keys**
2. Copy the default key
3. Paste into MirrorShard

---

## OpenRouter

OpenRouter is a cloud AI service that provides access to various AI models.

1. Log in to [https://openrouter.ai/](https://openrouter.ai/)
2. Go to **Keys** and click **Create API Key**.
   - You can name the key anything you like.
   - If you are on the free tier, leave the **Credit Limit** blank. As long as you do not add credits to your account, you will not be charged.
3. Copy your key
4. Paste into MirrorShard

---

## Cohere

1. Create an account at [https://cohere.com/](https://cohere.com/)
2. Open Dashboard → API Keys
3. Copy Trial key
4. Paste into MirrorShard

---

## Mistral

1. Register at [https://mistral.ai/](https://mistral.ai/)
2. Enter AI Studio → API Keys
3. Create a key
4. Select a plan (Experiment = free tier)
5. Phone verification required
6. Paste into MirrorShard

---

## Local AI

### LM Studio

1. Load a model
2. Start server (Status: Running)
3. Enable CORS
4. Default endpoint works as-is

---

### Ollama

1. Install from [https://ollama.com/](https://ollama.com/)
2. Run:

```
ollama pull gemma2
```

3. Use endpoint:

```
http://127.0.0.1:11434/v1/chat/completions
```

---

# 2. Switching AI

Each component has its own AI selector:

* Main Editor → sidebar selector
* Chat Window → top-left selector
* Idea Processor → top-right selector

---

## Model Selection

* Gemini and others allow manual model input
* Be aware: newer models may **not be free-tier**

---

## Strengths Overview

* Gemini → highest quality
* Groq / Cerebras → speed
* Mistral → different training bias
* Local AI → privacy, no cost

---

# 3. Feature Usage

---

## ■ Main Editor AI

### 1. Continue Writing

**Shortcut:** `Alt + Enter`

* AI continues text based on context
* Context size affects speed and cost

⚠️ Unlike browser AI tools, context is sent every time
→ Not ideal for very long documents

---

### 2. Missing Link Completion

**Shortcut:** `Alt + Shift + Enter`

* Connects two parts of text

---

### 3. Selection-Based AI Actions

Right-click selected text:

* Translate
* Summarize
* Rewrite
* Generate image prompt
* Generate image

Image generation uses:

* Stable Diffusion
* or Mistral Agents

---

### 4. Code Completion (Code Mode Only)

* Uses FIM (Fill-in-the-Middle)
* Requires local AI
* Recommended: `qwen2.5-coder`

---

## ■ AI Chat Window

Open with `Ctrl + Shift + A`

### Features

* Save / Load chat logs
* Regenerate responses
* Edit previous messages
* Export to editor

---

### Image Generation (Chat)

You can simply say:

> "Generate an image of ..."

#### Mistral Agents

* Enable Image capability
* Enter Agent ID
* Select Mistral

---

#### Stable Diffusion (SD-Link)

1. Install Web UI
2. Enable `--api`
3. Start via `Ctrl + Shift + W`
4. Enable **SD-Link button**
5. Send request

---

### Web Search (Obscura)

1. Install Obscura
2. Set path in settings
3. Enable **Search button**
4. Ask AI to search

⚠️ Limitations:

* Not supported: Cohere, Cerebras
* Mistral Large unstable
* Local models may struggle

By default, the web agent uses DuckDuckGo for search. However, you can achieve much higher search accuracy by using Tavily.

#### Tavily

Tavily is a web search engine optimized for AI agents. It offers 1,000 free requests per month.

1. Sign up at [https://tavily.com/](https://tavily.com/).
2. Copy the automatically generated "default" API key.
3. Open MirrorShard Settings, go to the **AI Settings** tab, paste the key into the **Tavily API Key** field, and check the "Enable Tavily Search" box.
4. Select "Tavily" from the search engine selector in the upper-left corner of the AI chat window.

---

## ■ Idea Processor AI

### Features

* AFA (AI Free Association)
* Missing Link
* Node Alchemy
* Template Completion

---

# 4. External Tools

## OpenCode

* Open with `Ctrl + Shift + K`

---

## SillyTavern

* Open with `Ctrl + Shift + J`
* Recommended for character roleplay

---

# 5. Image Generation

## Settings

* Prompt / Negative Prompt
* Steps / CFG
* Sampler / Scheduler
* Model
* Image size

---

## Notes

### Mistral

* Free tier is very limited

---

### Stable Diffusion

1. Must run in API mode (`--api`)
2. Some models may fail
3. SD-Link requires **high instruction-following AI**
4. Requires GPU (recommended 12GB VRAM)
5. Avoid spaces / non-ASCII in install path

---

# 6. Notes & Limitations

## API Costs

* Free tier stops automatically
* Paid usage may incur charges

---

## Security

* Keep API keys private

---

## Context Handling

* Full chat history is sent
* Be careful when switching AI

---

## Performance Notes

* Large logs may freeze UI
* Use editor for large files

---

## Short Responses Issue

Some models (e.g., Gemini Flash) may output very short responses.

**Fix:** Increase max tokens (3000–5000 recommended)

---

# 7. Free Usage

MirrorShard is designed to work without payment.
See:

👉 `free-ai-guide.md`

---

# 8. Design Philosophy

MirrorShard follows a strict principle:

> **AI does nothing unless explicitly requested.**

* No background processing
* No hidden data sending
* Minimal context usage

This prioritizes:

* User control
* Privacy
* System performance

---

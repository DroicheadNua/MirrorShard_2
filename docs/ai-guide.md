※まだドラフト

# MirrorShard 2 AI Guide

This document explains how to use the AI features in MirrorShard 2.

If you are new to the application, we recommend starting with the Quick Guide first.

---

# Table of Contents

1. Getting Started (API Setup)
2. Choosing and Switching AI
3. Features
4. External Integrations
5. Notes & Limitations
6. Design Philosophy

---

# 1. Getting Started (API Setup)

To use AI features, you need an API key.

### Gemini (Recommended for beginners)

1. Go to: https://aistudio.google.com/
2. Sign in with your Google account
3. Click **"Get API Key"**
4. Select **"Create API key in new project"**
5. Copy the generated API key

In MirrorShard:

1. Press **F2** to open Settings
2. Go to the **AI Settings** tab
3. Paste your API key into **Gemini API Key**

---

# 2. Choosing and Switching AI

MirrorShard supports multiple AI providers:

- Gemini (Cloud)
- Groq (Cloud)
- Cohere
- Mistral
- Local AI (LM Studio / Ollama / etc.)

### Which one should I use?

- **Gemini**: Best overall quality
- **Groq**: Very fast responses
- **Mistral**: More diverse/non-English bias
- **Local AI**: Full privacy and control

### Switching AI

- Main Editor: Use the AI selector in the sidebar
- Chat Window: Use the selector in the top-left
- Idea Processor: Use the selector in the top-right

---

# 3. Features

## 3.1 AI Writing Assistance

Press **Alt + Enter** to let AI continue your text.

- Uses previous context
- Output is appended at cursor position
- Press **ESC** to cancel

---

## 3.2 Missing Link Completion

Press **Alt + Shift + Enter**

- AI fills the gap between two parts of text

---

## 3.3 Text Processing (Right-click menu)

- Translate
- Summarize
- Rewrite

Results are inserted after the selected text.

---

## 3.4 Code Completion (Local AI only)

Available in Code Editor Mode (**Ctrl + K**)

- Uses FIM (Fill-in-the-middle)
- Requires local model (e.g. qwen2.5-coder)

---

## 3.5 AI Chat Window

Open with **Ctrl + Shift + A**

- Chat with AI freely
- Save / load chat logs
- Edit / regenerate responses

---

## 3.6 Idea Processor (AI Features)

Includes:

- AI Free Association
- Missing Link Generation
- Node Alchemy
- Template Completion

---

# 4. External Integrations

## OpenCode

If installed, press **Ctrl + Shift + K** to open.

## SillyTavern

If installed, press **Ctrl + Shift + J** to open.

---

# 5. Notes & Limitations

## API Usage & Costs

Using cloud AI (e.g. Gemini) may incur costs depending on your account.

We recommend checking official pricing pages before use.

---

## Context Handling

MirrorShard sends context **only when you request it**.

Unlike some AI editors:
- No background monitoring
- No automatic text streaming

---

## Response Length Issues

If responses are too short:
- Increase **Max Tokens** (recommended: 3000–5000)

---

## Local AI Notes

- Requires running LM Studio / Ollama
- May be slower on low-end machines
- No cloud restrictions

---

# 6. Design Philosophy

MirrorShard is designed with the principle:

**"AI should never act without explicit user intent."**

AI is only invoked when the user triggers it.

This means:
- No background processing
- No hidden data transmission
- Full user control

While this may result in slightly slower responses,
it prioritizes:

- Privacy
- Transparency
- User agency
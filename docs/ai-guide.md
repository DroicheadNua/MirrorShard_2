# **MirrorShard 2 – AI Guide**

> *Note: This document may include features that are still under development.  
> Some features may differ from the currently distributed build.*

---

# **Table of Contents**

1. AI Setup
2. Choosing and Switching AI
3. Features
4. External Tools Integration
5. Notes and Limitations
6. Design Philosophy

---

# **1. AI Setup**

## ■ What is an API Key?

An API key is a secret token that allows MirrorShard to communicate with an AI service on your behalf.

**Important:**

* Keep your API key private
* Do not share it with others

---

## ■ Recommended for Beginners: Gemini

Gemini is the easiest to set up and provides high-quality responses.

### Setup Steps

1. Go to:
   [https://aistudio.google.com/](https://aistudio.google.com/)

2. Log in with your Google account

3. Click **"Get API Key"**

4. Select **"Create API key in new project"**

5. Copy the generated API key

6. Open MirrorShard and press **F2** (Settings)

7. Go to **AI Settings** tab

8. Paste the API key into **"Gemini API Key"**

---

## ■ Other Cloud AI (Groq, Cohere, Mistral)

To use other cloud AI services:

* Create an API key on their official website
* Enter it in MirrorShard settings

**Note:**
Some services may require billing setup or phone verification.

---

## ■ Local AI (Recommended for Privacy / Offline Use)

Local AI runs entirely on your own machine.

---

### ● LM Studio (GUI-based)

1. Launch LM Studio
2. Open the **Developer** tab
3. Download and load a model
4. Start the server (**Status: Running**)
5. Enable **CORS** in settings

MirrorShard setup:

* Use default endpoint:
  `http://127.0.0.1:1234/v1/chat/completions`

---

### ● Ollama (Lightweight CLI)

1. Install Ollama:
   [https://ollama.com/](https://ollama.com/)

2. Pull a model:

```
ollama pull llama3
```

3. MirrorShard settings:

* Endpoint URL:
  `http://127.0.0.1:11434/v1/chat/completions`

* Model Name:
  e.g. `llama3`

---

Other local AI backends such as koboldcpp are also supported, as long as they provide an OpenAI-compatible API endpoint.

---

# **2. Choosing and Switching AI**

### ■ Recommended Usage

* **Beginners:** Gemini
* **Fast responses:** Groq
* **Privacy / offline:** Local AI

---

### ■ Switching AI

* **Main Editor:** AI selector in the sidebar
* **Chat Window:** Top-left selector
* **Idea Processor:** Selector below top-right buttons

---

# **3. Features**

---

## ■ 1. AI Writing Assistance

### Continue Writing

Press **Alt + Enter**

* AI continues text based on context
* Press **ESC** to cancel

---

### Missing Link Completion

Press **Alt + Shift + Enter**

* AI fills the gap between two parts of text

---

### Text Processing (Right Click)

* Translate
* Summarize
* Rewrite

Output is inserted after selected text.

---

### Image Features (Right Click)

- **AI: Generate Image Prompt**  
  Converts selected text into an English prompt optimized for image generation models.

- **AI: Generate Image**  
  Generates an image from the selected text, saves it to the configured image folder,  
  and inserts an image link at the cursor position.

  You can preview the result instantly using Markdown Preview (Ctrl+M).

  To generate images, use either Stable Diffusion or Mistral Agents.

- **Mistral**: In the settings screen, select "Mistral Agent" for "AI for Visualize (Image Gen)" and set the AI selector in the editor to "Mistral."

- **Stable Diffusion**: In the "AI for Visualize (Image Gen)" setting, choose "Stable Diffusion."

---

## ■ 2. Code Completion (Code Mode Only)

Press **Ctrl + K** to enable Code Mode

Then press **Alt + Enter**

* Uses FIM (Fill-in-the-Middle)
* Local AI only

**Recommended models:**

* qwen2.5-coder
* similar coding models

---

## ■ 3. AI Chat Window

Open with **Ctrl + Shift + A**

Features:

* Free conversation with AI
* Save / load chat logs
* Edit / regenerate responses
* Export logs

### AI Chat – Image Generation

In the AI Chat window, you can simply ask:

> "Generate an image of ..."

and MirrorShard will handle the rest.

---

#### Requirements

Image generation requires either:

- **Mistral Agents**, or  
- **Stable Diffusion Web UI**

🧠 Using Mistral Agents
1. Log in to Mistral and create an Agent in AI Studio  
2. Enable the **Image** capability  
3. Enter your **Agent ID** in MirrorShard settings  
4. Enable "Use Mistral Agents"  
5. Select **Mistral** in the AI selector  

You can now generate images directly from chat or editor.

🎨 Using Stable Diffusion
Stable Diffusion enables image generation with any supported AI model.

---

### Setup

1. Install Stable Diffusion Web UI (A1111, Forge, Forge Neo, etc.)  
2. Register the launch script (e.g., `webui-user.bat`) in settings  
3. Launch it with **Ctrl+Shift+W**  
4. Enable **SD Link** in the chat window  

---

Once enabled:

- The AI generates a structured prompt  
- MirrorShard detects it  
- Sends it to Stable Diffusion via API  
- Displays the generated image automatically

---

## ■ 4. Idea Processor AI Features

---

### AFA (AI Free Association)

* Select a node
* Press **Ctrl + Shift + F**

→ Generates 3 related ideas

---

### Missing Link (Idea Graph)

* Select a connection
* Activate AI

→ Generates content between nodes

---

### Node Alchemy

* Select multiple nodes
* Activate AI

→ Combines ideas into a new node

---

### Template Completion

* Works inside story templates
* AI expands structured content

---

# **4. External Tools Integration**

---

## ■ OpenCode

If installed:

* Open with **Ctrl + Shift + K**

Refer to OpenCode documentation for usage.

---

## ■ SillyTavern

If installed:

* Open with **Ctrl + Shift + J**

Recommended setting in `config.yaml`:

```
browserLaunch:
  enabled: false
```
---

# **5. Image Generation Notes **

## Settings

From the settings window, you can specify:

- Auto-save folder for images
- Image generation prompt
- Image Negative prompt
- Steps
- CFG scale
- Resolution (Image size)

## ⚠️ Mistral

- Free tier allows only a few images per month (~4–5)  
- Suitable for testing, not heavy usage  

## ⚠️ Stable Diffusion

### 1. API Mode Required

Stable Diffusion must be running in API mode.

- If launched from MirrorShard → handled automatically  
- If launched manually → add `--api` to COMMANDLINE_ARGS  

---

### 2. Model Compatibility

Some models (e.g., highly specialized ones like Anima) may fail.

If that happens:
- Try another model, or  
- Use "Generate Image Prompt" and run it manually in Stable Diffusion  

---

### 3. SD Link (Chat Integration)

SD Link works by:

- AI converting your request into a structured English prompt  
- MirrorShard detecting the format  
- Automatically triggering image generation  

👉 This requires **instruction-following capable models**

Recommended:

- Cloud: Gemini, GPT-based (Groq), Mistral Large  
- Local: Instruction-tuned models (e.g., Gemma variants)  

Weak models may:
- Output prompts in Japanese  
- Break the required format  

---

### 4. Mistral Conflict

If Mistral Agents is enabled:

👉 It may override SD Link behavior  

Disable Agents if you want to use SD Link with Mistral.

---

### 5. Hardware Requirements

Stable Diffusion requires a reasonably powerful system.

- Recommended: GPU with ~12GB VRAM  
- Minimum:  
  - GTX 1050 Ti (4GB VRAM)  
  - or 16GB unified memory (Mac)  

Lightweight models (e.g., SD 1.5 LCM) can run on lower-end systems,  
but performance may be limited.

---

# **6. Notes and Limitations**

---

## ■ ⚠️ API Usage Costs

Using cloud AI (Gemini, etc.) may incur charges depending on your account settings.

* Free tier: limited usage
* Paid plan: usage-based billing

**The developer is not responsible for any charges incurred.**

Check official pricing pages before use.

---

## ■ Context Behavior

* Context is sent **only when you trigger AI manually**
* MirrorShard does NOT monitor your text in the background

---

## ■ Long Text Limitations

Very large texts (hundreds of thousands of tokens) may cause performance issues.

---

## ■ Truncated Responses

If responses are cut off:

→ Increase **Max Tokens** in settings

---

## ■ Short Responses (Gemini / Thinking Models)

Some models use internal reasoning ("thinking").

If Max Tokens is too low:

→ Output may be extremely short

**Recommended:**
Set Max Tokens to **3000–5000+**

---

# **7. Design Philosophy**

MirrorShard follows a strict principle:

**"Never let AI take control away from the user."**

* AI is only triggered by explicit user action
* No background monitoring
* No automatic suggestions

This design prioritizes:

* User control
* Privacy
* System performance

---

## ■ Summary

MirrorShard is designed as:

> A tool where **humans lead, AI assists**

---


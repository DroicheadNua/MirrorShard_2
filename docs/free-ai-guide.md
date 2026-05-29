# 💡 Free AI Setup Guide (No Credit Card Required)

MirrorShard includes a wide range of AI-powered features.  
To use them, you typically need either:

- A local AI setup on your machine, or  
- API keys for cloud-based AI services  

In most cases, both options involve either high hardware requirements or paid subscriptions.

---

## 🎯 But MirrorShard is designed to work without paying

MirrorShard intentionally supports AI providers that offer **free API access**, including:

- Google (Gemini)  
- Groq  
- Mistral  
- Cohere  
- Cerebras  
- OpenRouter

All of these services allow you to obtain API keys and use them **without payment**.

> MirrorShard does not support ChatGPT or Claude APIs by design —  
> because they do not provide meaningful free usage tiers.

---

## ⚠️ What to expect from free plans

Free tiers are more limited than paid plans, but they are still powerful enough for most use cases.

In particular:

- **Gemini** and **Mistral** offer very generous free quotas  
- For writing, editing, and idea generation, you will rarely hit the limits  

---

# ☁️ Using Cloud AI (Step-by-step)

### 1. Create a Google account

If you want to stay completely free:

👉 **Do NOT add a payment method**

Without a payment method, charges cannot occur.  
Even if you accidentally select a paid model, it will simply return an error.

---

### 2. Get API keys

Register for the following services and obtain API keys:

- Google (Gemini)  
- Groq  
- Mistral  
- Cohere  
- Cerebras
- OpenRouter

All of them support Google account login and provide free access.

For detailed instructions, see:

👉 `docs/ai-guide.md`

---

### ⚠️ Important note

When using free cloud AI:

> Your input data may be used for training purposes.

Avoid sending sensitive or private information.

---

# 💻 Local AI (Optional)

If your PC has sufficient specs, you can run AI locally.

### Recommended specs:
- GPU with **12GB+ VRAM**, or  
- Unified memory **16GB+ (Mac, etc.)**

---

### Advantages of local AI

- No usage limits  
- No subscription costs  
- No data is sent to external servers  
- Fewer content restrictions  

---

### How to use local AI

Install one of the following:

- LM Studio  
- Ollama  
- KoboldCPP  

Once installed, MirrorShard can connect automatically.

See:

👉 `docs/ai-guide.md`

---

# 🖼️ Image Generation

Image generation requires either:

- A capable local machine, or  
- Paid usage (for cloud-based image APIs)

---

## 🧠 Mistral (Cloud)

Mistral Agents enable image generation inside:

- AI Chat  
- Main Editor  

However:

- Free tier allows only **~4–5 images per month**  
- Suitable for testing, not heavy use  

---

## 🎨 Stable Diffusion (Local)

Stable Diffusion integration enables:

### 1. Editor
- Generate images from selected text  
- Automatically insert image links at the cursor  

### 2. AI Chat (SD Link mode)
- Ask for an image in natural language  
- AI generates a prompt  
- The prompt is sent to Stable Diffusion  
- The generated image is returned and displayed  

---

### ⚠️ Requirements

- GPU with **~12GB VRAM recommended**  
- Or lower-end setup with lightweight models (e.g., SD 1.5 LCM)

Even systems like:
- Mac mini (M-series, 16GB memory)

can be usable with optimized models.

---

### ⚠️ Notes

For setup details and limitations, see:

👉 `docs/ai-guide.md`

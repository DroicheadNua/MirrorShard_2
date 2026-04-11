# Another Canvas for Expanding Ideas

## MirrorShard Idea Processor Guide

Welcome to the MirrorShard Idea Processor.

This tool is designed to help you freely place, connect, and grow fragments of ideas—turning scattered thoughts into structured concepts.

Whether you're outlining a novel, organizing character relationships, brainstorming, or building a mind map, the Idea Processor gives you a flexible space to think visually and creatively.

---

## 1. Launching & File Operations

### Open / Close

* **Launch:** Click the Idea Processor icon in the main window, or press `Ctrl + I`
* **Close:** Click the `×` button in the top-right corner, or press `Ctrl + I` again

### Create / Open Files

* **New File:** Click `New File` or press `Ctrl + N` to reset the canvas
* **Open File:** Click `Load` or press `Ctrl + O` to open a `.mrsd` file
* **Auto Restore:** The last opened file is automatically restored on launch

---

## 2. Working on the Canvas

### Nodes (Idea Fragments)

* **Create:** Double-click empty space on the canvas, or press `Shift + Enter`
* **Edit Text:** Double-click a node
* **Edit Content:** Right-click a node to open the content editor for detailed notes
* **Move:** Drag and drop

---

### Links (Connections Between Ideas)

Connect nodes using lines or arrows.

* **Create:**

  1. Select a starting node
  2. Then:

     * `Ctrl + Click` → Link
     * `Shift + Click` → Arrow
     * `Ctrl + Shift + Click` → Bidirectional arrow

* **Edit Label:** Double-click the line or label

* **Delete:** Select and press `Delete` or `Backspace`

---

### Groups (Idea Clusters)

* **Create:** `Create Group` or `Ctrl + G`
* **Move:** Drag and drop
* **Resize:** Drag the bottom-right handle
* **Rename:** Double-click the label

#### Parenting (Group Hierarchy)

* **Assign Node to Group:**

  1. Select the node
  2. `Ctrl + Click` the parent group

* **Remove from Group:**

  1. Select the node
  2. `Shift + Click` the parent group

---

## 3. Navigation & View Controls

### Pan

Right-click and drag empty space to move around the canvas

### Zoom

* Mouse wheel to zoom in/out
* `Zoom Reset` to restore default zoom
* `Initialize` or `Ctrl + R` to reset view and window state

---

### Outline Panel

Toggle with `Show/Hide Outline` or `Ctrl + Shift + O`

* Displays structure as:

  * `#` Groups
  * `##` Nodes
  * `###` & `####` Markdown subheadings inside node content

* **Jump Navigation:**

  * Click a node → center it on the canvas
  * Click a subheading → open content editor and jump to it

* **Collapse / Expand:**

  * Use ▼ next to groups
  * Use ▲ / ▼ buttons to expand/collapse all

---

### Window Controls

* **Maximize:** `F11`
* **Toggle Dark Mode:** `Ctrl + T`
* **Always on Top:** Toggle button

---

## 4. Selection & Deletion

* **Single Select:** Click an object
* **Multi Select:** Drag to create a selection box
* **Move Multiple:** Drag the selection frame
* **Delete:** `Delete` or `Backspace`

---

## 5. Saving & Exporting

### Saving

* **Auto-save:** Every action is saved automatically
* **On Close:** Prompts for file name if new
* **Save As:** Create a copy anywhere

### Undo / Redo

* Undo: `Ctrl + Z`
* Redo: `Ctrl + Y` or `Ctrl + Shift + Z`

---

### Export

Click `Export` to output the canvas as:

* **HTML:** Visual snapshot embedded in HTML

* **Markdown:** Hierarchical structure (# / ##)

* **PNG:** Image with background

* **PDF / Print**

* **Send to Editor:** Convert to Markdown and open in main editor

---

## 6. Story Archetypes (Templates)

The Idea Processor includes built-in **story structure templates** to help you design compelling narratives.

When you load a template, groups, nodes, and connections are automatically generated.

Edit each node and expand on the provided prompts to develop your story.

### Available Archetypes

* **Actantial Model**
  A structural model by A. J. Greimas for analyzing roles and relationships

* **Hero’s Journey**
  A universal storytelling framework by Joseph Campbell

* **Beat Sheet**
  A simplified structure inspired by Blake Snyder

* **Three-Act Structure**
  A classic and widely used narrative framework

---

## 7. AI Features

The Idea Processor includes four AI-powered features:

### 7.1 AI Free Association

Generate three new ideas based on a selected node.

* Select a node → Click `Activate AI` or press `Ctrl + Shift + F`

Notes:

* Some models may generate more than three results
* Longer outputs are stored in the content editor

---

### 7.2 Missing Link Completion

Generate text that connects two nodes.

* Select a link → Activate AI

You can specify what kind of content to generate (e.g., character, idea).

---

### 7.3 Node Alchemy

Combine multiple nodes into a new synthesized idea.

* Select multiple nodes → Activate AI

---

### 7.4 Template Completion

Available only when editing Story Archetype content.

* Activate AI while editing node content

The AI uses:

* The overall story structure
* Text before the cursor

This enables more context-aware generation with minimal input.

---

## Requirements for AI Features

To use AI features, you need either:

* A cloud AI API key (e.g., Google Gemini or Groq), or
* A local AI environment such as:

  * LM Studio
  * Ollama
  * koboldcpp

For setup instructions, see: **AI Guide (ai-guide.md)**

---

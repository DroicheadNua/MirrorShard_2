import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  initI18n,
  t,
  applyTranslationsToDOM,
  translateRustError,
} from "./i18n";
import { type } from "@tauri-apps/plugin-os";
// import { resolveResource } from '@tauri-apps/api/path';
import { convertFileSrc } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import Konva from "konva";
import JSZip from "jszip";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { save, open, ask } from "@tauri-apps/plugin-dialog";

// =================================================================
// 1. グローバル変数と状態フラグ
// =================================================================
let store: Store | null = null;
let stage: Konva.Stage;
let layer: Konva.Layer;
let transformer: Konva.Transformer;
let selectionRect: Konva.Rect;

let history: string[] = [];
let historyIndex: number = -1;
const MAX_HISTORY = 50;
let isHistoryEnabled = true;

let isInitialized = false;
let isPinned = false;
let isSimpleFullscreen = false;
let osType = "windows";
let isTextEditing = false;
let currentFilePath: string | null = null; // 現在開いているファイルのパス
let isDirty = false; // 変更があるかどうかのフラグ
let projectMetadata: any = null; // 読み込んだファイルのメタデータ（作成日時など）を保持
let isPanning = false;
let didPan = false;
let contentEditorJustClosed = false;
let currentlyEditingNodeId: string | null = null;
let isContentEditing = false;
let lastPointerPosition: { x: number; y: number } = { x: 0, y: 0 };
let selectionStartPos: { x: number; y: number } | null = null;
let isDraggingSelection = false;
let lastRectPos: { x: number; y: number } = { x: 0, y: 0 };
let selectedShape: Konva.Group | null = null;
let selectedNodes: Konva.Group[] = [];
let selectionJustFinished = false;
let isAiThinking = false;
let aiAbortController: AbortController | null = null;
let showAiThinkingOverlay = true;
let aiThinkingMode = "";
let ipAiApi = "gemini";

const editorPane = document.getElementById("ip-editor-pane") as HTMLElement;
const contentEditor = document.getElementById(
  "ip-content-editor",
) as HTMLTextAreaElement;
const outlinePaneContent = document.getElementById(
  "ip-outline-content",
) as HTMLElement;
const outlineCollapsedState = new Map<string, boolean>(); // key: groupId, value: isCollapsed
const nodeCollapsedState = new Map<string, boolean>(); // key: nodeId, value: isCollapsed

// テーマカラー定義
const themes = {
  light: {
    text: "#111111",
    link: "#333333",
    selection: "rgba(203, 7, 7, 0.4)",
    nodeBg: "transparent",
    labelBackground: "#fafae0",
    heading: "#cb0707ff",
    scroll: "rgba(150, 150, 150, 0.5)",
  },
  dark: {
    text: "#cccccc",
    link: "#cccccc",
    selection: "rgba(211, 16, 16, 0.4)",
    nodeBg: "transparent",
    labelBackground: "#4f4f4f",
    heading: "#d31010ff",
    scroll: "rgba(120, 120, 120, 0.5)",
  },
};

// --- .mrsd (canvas.json) 用の型定義 ---
interface MrsdNode {
  id: string;
  type: string; // "file"
  file: string; // "files/xxx.md"
  x: number;
  y: number;
  width: number;
  height: number;
  title: string; // ノード内のテキスト
  parentId: string | null;
  isTemplateItem: boolean;
  placeholder: string;
}

interface MrsdGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  isTemplateRoot: boolean;
  archetype: string;
  childNodeIds: string[];
  isCollapsed: boolean;
}

interface MrsdEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  type?: string; // "arrow", "double_arrow", "line"
}

interface MrsdMetadata {
  createdAt: string;
  updatedAt: string;
}

// canvas.json 全体の構造
interface MrsdJson {
  nodes: MrsdNode[];
  edges: MrsdEdge[];
  groups: MrsdGroup[];
  metadata: MrsdMetadata;
}

enum LinkType {
  LINE = "line",
  ARROW = "arrow",
  DOUBLE_ARROW = "double_arrow",
}
type Vector2d = { x: number; y: number };

// =================================================================
// 2. 履歴管理 (Undo / Redo)
// =================================================================

function recordHistory(message: string = "") {
  if (!isHistoryEnabled) return;

  // stage.toJSON() ではなく、独自のデータ構造を保存する
  const data = _getCurrentStageData();
  const stateJson = JSON.stringify(data);

  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  history.push(stateJson);
  if (history.length > MAX_HISTORY) {
    history.shift();
  } else {
    historyIndex++;
  }
  markAsDirty();
  console.log(`[History] Recorded: ${message} (Index: ${historyIndex})`);
}

async function undo() {
  if (isTextEditing || !isHistoryEnabled) return;
  if (historyIndex <= 0) return;

  isHistoryEnabled = false;
  try {
    historyIndex--;
    const data = JSON.parse(history[historyIndex]);
    await recreateStage(data);
    console.log(`[History] Undo to index: ${historyIndex}`);
  } catch (e) {
    console.error("[History] Undo failed:", e);
  } finally {
    finalizeHistoryAction();
  }
}

async function redo() {
  if (isTextEditing || !isHistoryEnabled) return;
  if (historyIndex >= history.length - 1) return;

  isHistoryEnabled = false;
  try {
    historyIndex++;
    const data = JSON.parse(history[historyIndex]);
    await recreateStage(data);
    console.log(`[History] Redo to index: ${historyIndex}`);
  } catch (e) {
    console.error("[History] Redo failed:", e);
  } finally {
    finalizeHistoryAction();
  }
}

function finalizeHistoryAction() {
  isHistoryEnabled = true;

  if (transformer) {
    transformer.nodes([]);
    transformer.listening(false);
  }
  if (selectionRect) {
    selectionRect.visible(false);
    selectionRect.setAttrs({ strokeEnabled: false });
  }

  selectedNodes = [];
  selectedShape = null;
  layer.draw();
}
// =================================================================
// 3. データ抽出とステージ再構築
// =================================================================

function _getCurrentStageData() {
  const nodesData: any[] = [];
  stage.find<Konva.Group>(".node-group").forEach((node) => {
    const rect = node.findOne<Konva.Rect>(".background");
    const textNode = node.findOne<Konva.Text>(".text");
    if (!rect || !textNode) return;
    nodesData.push({
      id: node.id(),
      x: node.x(),
      y: node.y(),
      width: rect.width(),
      height: rect.height(),
      title: textNode.text(), // 見た目のテキスト
      contentText: node.getAttr("contentText") || "", // 本文
      isTemplateItem: node.getAttr("isTemplateItem") || false,
      placeholder: node.getAttr("placeholder") || "",
      parentId: node.getAttr("parentId") || null, // 親IDを属性から取得
    });
  });

  const linksData: any[] = [];
  stage.find<Konva.Group>(".link-group").forEach((linkGroup) => {
    const nodes = linkGroup.getAttr("nodes") as Konva.Group[];
    const type = linkGroup.getAttr("linkType");
    const label = linkGroup.findOne<Konva.Text>(".link-label");
    const sibling = linkGroup.getAttr("sibling");

    if (sibling && sibling.id() < linkGroup.id()) return; // 双方向の重複排除
    if (nodes && nodes.length === 2 && type) {
      linksData.push({
        id: linkGroup.id(),
        from: nodes[0].id(),
        to: nodes[1].id(),
        type: type,
        label: label ? label.text() : "",
      });
    }
  });

  const groupsData: any[] = [];
  stage.find<Konva.Group>(".container-group").forEach((group) => {
    const bg = group.findOne(".group-bg") as Konva.Rect;
    const title = group.findOne(".group-title") as Konva.Text;
    if (bg && title) {
      groupsData.push({
        id: group.id(),
        x: group.x(),
        y: group.y(),
        width: bg.width(),
        height: bg.height(),
        title: title.text(),
        childNodeIds: group.getAttr("childNodeIds") || [],
        isTemplateRoot: group.getAttr("isTemplateRoot") || false,
        archetype: group.getAttr("archetype") || "",
        isCollapsed: group.getAttr("isCollapsed") || false,
      });
    }
  });

  return { nodes: nodesData, links: linksData, groups: groupsData };
}

// =================================================================
// 4. ステージ再構築 (recreateStage) - Undo/Redoの要
// =================================================================

async function recreateStage(data: any) {
  // レイヤーをクリア（ステージ自体は破棄しない）
  layer.destroyChildren();
  setupSelectionTools();
  selectedNodes = [];
  selectedShape = null;

  // 1. グループノードの復元
  if (data.groups) {
    data.groups.forEach((g: any) => {
      const groupNode = createGroupNode(g.x, g.y, g.label || g.title);
      groupNode.id(g.id);
      groupNode.setAttr("isTemplateRoot", g.isTemplateRoot || false);
      groupNode.setAttr("archetype", g.archetype || "");
      groupNode.setAttr("childNodeIds", g.childNodeIds || []);

      const bg = groupNode.findOne(".group-bg") as Konva.Rect;
      const handle = groupNode.findOne(".resize-handle") as Konva.Circle;
      if (bg && handle) {
        bg.width(g.width);
        bg.height(g.height);
        handle.x(g.width);
        handle.y(g.height);
      }
    });
  }

  // 2. ノードの復元
  if (data.nodes) {
    data.nodes.forEach((n: any) => {
      const nodeGroup = createNewNode(
        n.x,
        n.y,
        n.title || n.text,
        n.contentText,
        false,
      );
      nodeGroup.id(n.id);
      nodeGroup.setAttr("isTemplateItem", n.isTemplateItem || false);
      nodeGroup.setAttr("placeholder", n.placeholder || "");
      nodeGroup.setAttr("parentId", n.parentId || null);
    });
  }

  // 3. リンクの復元
  if (data.links) {
    data.links.forEach((linkData: any) => {
      // IDから実体のノードを探す
      const fromNode = layer.findOne("#" + linkData.from);
      const toNode = layer.findOne("#" + linkData.to);

      if (fromNode && toNode) {
        const linkGroup = createSingleLink(
          fromNode as Konva.Group,
          toNode as Konva.Group,
          linkData.type,
        );
        if (linkGroup) {
          linkGroup.id(linkData.id); // IDを復元
          const labelText = linkGroup.findOne(".link-label") as Konva.Text;
          if (labelText && linkData.label) {
            labelText.text(linkData.label);
            updateLinkPoints(linkGroup); // これで表示状態とサイズが更新される
          }
        }
      }
    });
  }

  // 4. 描画更新
  await updateAllNodesAppearance();
  // ペアリングによる色（Heading色）を再適用するために全グループを走査
  stage.find<Konva.Group>(".container-group").forEach((group) => {
    updateGroupMembersAppearance(group, false);
  });

  layer.batchDraw();
  renderIpOutline();
}

function createNodeFromData(data: any) {
  const colors = getCurrentThemeColors();

  const nodeGroup = new Konva.Group({
    x: data.x,
    y: data.y,
    id: data.id,
    draggable: true,
    name: "node-group",
  });

  // 属性の分離: タイトルは表示用、contentTextは本文用
  nodeGroup.setAttr("parentId", data.parentId || null);
  nodeGroup.setAttr("contentText", data.contentText || "");
  nodeGroup.setAttr("placeholder", data.placeholder || "");
  nodeGroup.setAttr("isTemplateItem", data.isTemplateItem || false);
  const isMac = navigator.userAgent.includes("Mac OS X");
  const textNode = new Konva.Text({
    name: "text",
    text: data.title || t("ideaProcessor.default.newNode"),
    fontSize: 16,
    fontFamily: getKonvaFontFamily(),
    fill: colors.text, // テーマに合わせた文字色（ライトなら黒系）
    padding: 12,
    width: data.width || 200,
    minWidth: 150,
    lineHeight: 1.2,
    wrap: "char",
    offsetX: isMac ? 5 : 0,
  });

  const backgroundRect = new Konva.Rect({
    name: "background",
    x: 0,
    y: 0,
    width: data.width || 200,
    height: textNode.height(),
    fill: colors.nodeBg, // transparent（透明）
    cornerRadius: 10,
    // 枠線 (stroke) は描画しない
  });

  // 背面にRect、前面にTextを追加
  nodeGroup.add(backgroundRect);
  nodeGroup.add(textNode);
  layer.add(nodeGroup);
  adjustNodeSize(nodeGroup);

  return nodeGroup;
}

function adjustNodeSize(nodeGroup: Konva.Group) {
  const textNode = nodeGroup.findOne(".text") as Konva.Text;
  const bg = nodeGroup.findOne(".background") as Konva.Rect;
  if (!textNode || !bg) return;

  const maxWidth = 200;

  // 1. 確実に幅制限を解除
  textNode.setAttr("width", undefined);

  // 2. width() ではなく getClientRect() を使う
  // これにより、フォントのカーニングや描画のハミ出しも含めた「実際のピクセルサイズ」を取得できる
  let textBounds = textNode.getClientRect({ relativeTo: nodeGroup });

  if (textBounds.width > maxWidth) {
    // 最大幅を超える場合はKonvaに折り返しを任せる
    textNode.width(maxWidth);
    // 折り返し後にもう一度、実際の描画サイズを測り直す
    textBounds = textNode.getClientRect({ relativeTo: nodeGroup });
  }

  // 3. 背景サイズを「実際の描画ピクセル領域」と完全に一致させる
  // width()の計算誤差がここで吸収される
  bg.width(textBounds.width);
  bg.height(textBounds.height);

  // リンクの端点更新
  updateConnectedLinks(nodeGroup);
}

// =================================================================
// 5. 初期化とイベントリスナー (Initialize & Events)
// =================================================================

export function initializeIdeaProcessor() {
  if (isInitialized) return;
  isInitialized = true;
  console.log("--- initializeIdeaProcessor Started ---");

  // ステージ作成
  stage = new Konva.Stage({
    container: "ip-container",
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // レイヤー作成
  layer = new Konva.Layer();
  stage.add(layer);

  // ツール初期化
  setupSelectionTools();

  // イベント登録
  setupEventListeners();
  setupKeyboardEvents();

  // リサイズ追従
  window.addEventListener("resize", () => {
    stage.width(window.innerWidth);
    stage.height(window.innerHeight);
    layer.batchDraw();
  });
  setTimeout(() => {
    isDirty = false; // 初期化直後はダーティではない
  }, 100);
}

function setupEventListeners() {
  window.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
  });
  const container = document.getElementById("ip-container");
  if (container) {
    // Macでも確実にメニューを出さないようにする
    container.oncontextmenu = (e) => {
      e.preventDefault();
      return false;
    };
  }
  // ステージ上のクリック（ノード作成・選択解除）
  stage.on("click tap", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    // 範囲選択ドラッグが終わった直後の「クリック残響」なら無視する
    if (selectionJustFinished) {
      console.log("[Debug] Ignoring click event after range selection");
      selectionJustFinished = false;
      return;
    }
    if (e.target === stage) {
      deselectAll();
      return;
    }

    const group = e.target.getParent() as Konva.Group;
    if (!group) return;

    const isCtrl = e.evt.ctrlKey || e.evt.metaKey;
    const isShift = e.evt.shiftKey;

    if (group.name() === "node-group") {
      if (isCtrl && isShift) {
        manageLink(group, LinkType.DOUBLE_ARROW);
      } else if (isShift) {
        manageLink(group, LinkType.ARROW);
      } else if (isCtrl) {
        manageLink(group, LinkType.LINE);
      } else {
        selectShape(group);
      }
    } else if (group.name() === "link-group") {
      selectShape(group);
    } else if (group.name() === "container-group") {
      // グループノードがクリックされた場合
      if (isCtrl && selectedNodes.length > 0) {
        // 登録: 選択中のノードをグループに追加
        const childIds = group.getAttr("childNodeIds") || [];
        selectedNodes.forEach((node) => {
          if (!childIds.includes(node.id())) {
            childIds.push(node.id());
            // 登録された証として色を変える（選択色）
            const bg = node.findOne(".background") as Konva.Rect;
            if (bg) bg.stroke(getCurrentThemeColors().selection);
          }
        });
        group.setAttr("childNodeIds", childIds);
        recordHistory("Nodes added to group");
        renderIpOutline();
        deselectAll();
      } else if (isShift && selectedNodes.length > 0) {
        // 選択されたノードの中にテンプレートアイテムが含まれていないかチェック
        const hasTemplateItem = selectedNodes.some(
          (node) => node.getAttr("isTemplateItem") === true,
        );
        if (hasTemplateItem) {
          console.log("Cannot detach template items from their group.");
          return;
        }
        // 解除: 選択中のノードをグループから外す
        let childIds = group.getAttr("childNodeIds") || [];
        selectedNodes.forEach((node) => {
          childIds = childIds.filter((id: string) => id !== node.id());
          // 色を元に戻す
          const bg = node.findOne(".background") as Konva.Rect;
          if (bg) bg.strokeEnabled(false);
        });
        group.setAttr("childNodeIds", childIds);
        recordHistory("Nodes removed from group");
        renderIpOutline();
        deselectAll();
      } else {
        selectShape(group);
      }
    }
  });

  stage.on("dblclick", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    // 1. ノードのダブルクリック（テキスト編集）
    const nodeGroup = e.target.getParent();
    if (nodeGroup && nodeGroup.name() === "node-group") {
      const textNode = nodeGroup.findOne(".text") as Konva.Text;
      if (textNode) startTextEditing(textNode, nodeGroup as Konva.Group);
      return;
    }

    // 2. グループタイトルのダブルクリック（タイトル編集）
    const groupNode = e.target.getParent();
    if (groupNode && groupNode.name() === "container-group") {
      const titleText = groupNode.findOne(".group-title") as Konva.Text;
      if (titleText && e.target === titleText) {
        startGroupTitleEditing(titleText);
        return;
      }
      // グループ内（背景）ダブルクリックで新規ノード作成＆登録
      const pos = stage.getPointerPosition();
      if (pos) {
        const scale = stage.scaleX();
        const logicalX = (pos.x - stage.x()) / scale;
        const logicalY = (pos.y - stage.y()) / scale;
        const newNode = createNewNode(logicalX, logicalY);
        // グループに登録
        const childIds = groupNode.getAttr("childNodeIds") || [];
        childIds.push(newNode.id());
        groupNode.setAttr("childNodeIds", childIds);
        recordHistory("Node created in group");
      }
      return;
    }

    // 3. リンク（またはラベル）のダブルクリック
    let current: Konva.Node | null = e.target;
    let linkGroup: Konva.Group | null = null;
    while (current && !(current instanceof Konva.Stage)) {
      if (current.name() === "link-group") {
        linkGroup = current as Konva.Group;
        break;
      }
      current = current.getParent();
    }
    if (linkGroup) {
      const labelText = linkGroup.findOne(".link-label") as Konva.Text;
      if (labelText) startLabelEditing(labelText, linkGroup);
      return;
    }

    // 4. 背景のダブルクリック（新規ノード作成）
    if (e.target === stage) {
      const pos = stage.getPointerPosition();
      if (pos) {
        const scale = stage.scaleX();
        const logicalX = (pos.x - stage.x()) / scale;
        const logicalY = (pos.y - stage.y()) / scale;

        createNewNode(logicalX, logicalY);
        // recordHistory('Node created');
      }
    }
  });

  // 編集中はすべてのドラッグ操作を強制停止
  stage.on("dragstart", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    ) {
      e.target.stopDrag();
      e.cancelBubble = true;
    }
  });

  // ノードのドラッグ終了時（履歴記録）
  stage.on("dragend", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    // 複数選択中、かつドラッグされたのがその一部なら、
    // selectionRect 側の dragend に任せるのでここでは何もしない
    if (
      selectedNodes.length > 1 &&
      selectedNodes.includes(e.target as Konva.Group)
    ) {
      return;
    }

    if (e.target.name() === "node-group") {
      recordHistory("Node moved");
      updateConnectedLinks(e.target as Konva.Group);
    }
  });

  // ノードのドラッグ中（リンク追従）
  stage.on("dragmove", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    if (e.target.name() === "resize-handle") return; // グループハンドルのガード

    // ドラッグされているのがノードの場合
    if (e.target.name() === "node-group") {
      const draggedNode = e.target as Konva.Group;

      // リンクの更新処理
      // 複数選択中かどうかに関わらず、動いたノードのリンクを更新
      // (selectedNodes に含まれていれば、他のノードも一緒に動いているはず)
      const nodesToUpdate = selectedNodes.includes(draggedNode)
        ? selectedNodes
        : [draggedNode];

      const linksToUpdate = new Set<Konva.Group>();
      nodesToUpdate.forEach((node) => {
        const links = node.getAttr("links") as Konva.Group[]; // もし旧仕様のリンク保持が残っていれば
        if (links) {
          links.forEach((l) => linksToUpdate.add(l));
        }
        // 現行仕様のグローバル検索
        stage.find<Konva.Group>(".link-group").forEach((linkGroup) => {
          const linkNodes = linkGroup.getAttr("nodes");
          if (linkNodes && (linkNodes[0] === node || linkNodes[1] === node)) {
            linksToUpdate.add(linkGroup);
          }
        });
      });

      linksToUpdate.forEach((link) => updateLinkPoints(link));
    }
  });

  // リンク作成モード（Alt + ドラッグ）などの実装
  // ここではシンプルに「Altキーを押しながらドラッグでリンク作成」を実装
  stage.on("mousedown", (e) => {
    if (contentEditorJustClosed) {
      e.evt.preventDefault();
      e.cancelBubble = true;
      return;
    }
    const isAlt = e.evt.altKey;
    // --- 右クリック (Pan開始) ---
    if (e.evt.button === 2) {
      e.evt.preventDefault();
      // エディタが開いていたら閉じて終了 (ESCと同じ挙動)
      if (isContentEditing) {
        closeContentEditor();
        return;
      }
      isPanning = true;
      didPan = false; // パンしたかどうかのフラグをリセット
      const pos = stage.getPointerPosition();
      if (pos) lastPointerPosition = pos;
      return;
    }
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    if (e.evt.button === 0 && isAlt) {
      const group = e.target.getParent();
      if (group && group.name() === "node-group") {
        // リンク作成開始
        startConnection(group as Konva.Group);
      }
    } else if (e.evt.button === 0 && !isAlt) {
      if (e.target === selectionRect || e.target.name() === "selection-rect") {
        return;
      }
      if (e.target === stage) {
        deselectAll();
        selectionStartPos = stage.getRelativePointerPosition();
        isDraggingSelection = false;
      }
    }
  });

  stage.on("mousemove", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;

    // --- パン処理 (右ドラッグ) ---
    if (isPanning) {
      e.evt.preventDefault();
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const dx = pos.x - lastPointerPosition.x;
      const dy = pos.y - lastPointerPosition.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didPan = true;
        stage.x(stage.x() + dx);
        stage.y(stage.y() + dy);
        const newPos = stage.getPointerPosition();
        if (newPos) lastPointerPosition = newPos;
        layer.batchDraw();
      }
      return;
    }

    // --- リンク作成中 (Alt+左ドラッグ) ---
    if (connectionLine) {
      const pos = stage.getRelativePointerPosition();
      if (pos) {
        const points = connectionLine.points();
        points[2] = pos.x;
        points[3] = pos.y;
        connectionLine.points(points);
        layer.batchDraw();
      }
      return;
    }

    // --- 範囲選択 (左ドラッグ) ---
    if (selectionStartPos && e.evt.buttons === 1) {
      e.evt.preventDefault();

      // 初回の移動で可視化と初期化を行う
      if (!isDraggingSelection) {
        isDraggingSelection = true;
        selectionRect.visible(true);
        selectionRect.setAttrs({
          strokeEnabled: false,
          fill: "rgba(0, 123, 255, 0.3)", // 描画中の色
        });
      }

      const pos = stage.getRelativePointerPosition();
      if (!pos) return;

      const x1 = selectionStartPos.x;
      const y1 = selectionStartPos.y;
      const x2 = pos.x;
      const y2 = pos.y;

      selectionRect.setAttrs({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
      layer.batchDraw();
    }
  });

  stage.on("mouseup mouseleave", (e) => {
    if (
      isAiThinking ||
      contentEditorJustClosed ||
      isTextEditing ||
      isContentEditing
    )
      return;
    // --- 右クリック離上 ---
    if (e.evt.button === 2) {
      if (isPanning) {
        isPanning = false;
        if (!didPan && e.type === "mouseup") {
          // mouseleave時はエディタを開かない
          let current: Konva.Node | null = e.target;
          let clickedNode: Konva.Group | null = null;
          while (current && !(current instanceof Konva.Stage)) {
            if (current.name() === "node-group") {
              clickedNode = current as Konva.Group;
              break;
            }
            current = current.getParent();
          }
          if (clickedNode) openContentEditor(clickedNode);
        }
      }
      stage.container().style.cursor = "default";
      return;
    }

    // --- 左クリック離上 ---
    if (e.evt.button === 0) {
      // リンク作成の確定
      if (connectionLine) {
        const group = e.target.getParent();
        if (
          group &&
          group.name() === "node-group" &&
          connectionStartNode &&
          group !== connectionStartNode
        ) {
          createSingleLink(
            connectionStartNode,
            group as Konva.Group,
            LinkType.ARROW,
          );
          recordHistory("Link created");
        }
        connectionLine.destroy();
        connectionLine = null;
        connectionStartNode = null;
        layer.draw();
        return; // ここで終了
      }

      // --- 範囲選択の完了処理 ---
      if (selectionStartPos) {
        if (isDraggingSelection) {
          // 判定ロジックの安定化（レイヤー基準の絶対座標で比較）
          // selectionRect と nodes は同じ Layer にいるので、この比較が一番正確です
          const selBox = selectionRect.getClientRect();

          selectedNodes = stage
            .find<Konva.Group>(".node-group")
            .filter((node) => {
              // ノードがグループ内でも、getClientRect() は画面上の最終的な位置を返します
              const nodeBox = node.getClientRect();
              return Konva.Util.haveIntersection(selBox, nodeBox);
            });

          if (selectedNodes.length > 0) {
            transformer.nodes(selectedNodes);
            transformer.visible(true);

            // Transformerがイベントを奪わないように設定
            transformer.listening(false);

            // 視覚効果
            selectedNodes.forEach((node) => highlightShape(node));

            // selectionRect（青枠）を最前面にして、確実にドラッグを受け取る
            selectionRect.moveToTop();
            selectionRect.visible(true);
            selectionRect.listening(true); // 確実にイベントを受け取る

            selectionJustFinished = true;
            console.log(`[Selection] ${selectedNodes.length} nodes paired.`);
          } else {
            selectionRect.visible(false);
            transformer.nodes([]);
            selectedNodes = [];
          }
        } else {
          selectionRect.visible(false);
        }
        selectionStartPos = null;
        isDraggingSelection = false;
        layer.batchDraw();
      }
    }
  });

  // --- マウスホイールによるズーム ---
  const scaleBy = 1.1; // 1回のホイールでの拡大率

  stage.on("wheel", (e) => {
    // デフォルトのスクロール（ページ全体の移動など）を無効化
    e.evt.preventDefault();

    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();

    if (!pointer) return;

    // カーソルの位置から見た現在のステージ上の「絶対座標」を計算
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };

    // ホイールの回転方向で拡大/縮小を判定
    // directionY > 0 は手前に回す(下スクロール) -> 縮小
    const direction = e.evt.deltaY > 0 ? -1 : 1;

    // 新しいスケールを計算 (上下限を設ける)
    let newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
    newScale = Math.max(0.1, Math.min(newScale, 5.0)); // 10% ～ 500% に制限

    stage.scale({ x: newScale, y: newScale });

    // 新しいスケールを適用した上で、カーソルの位置がズレないようにステージ全体を動かす
    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };
    stage.position(newPos);

    layer.batchDraw();
  });
}

// リンク作成用の一時変数
let connectionLine: Konva.Line | null = null;
let connectionStartNode: Konva.Group | null = null;

function startConnection(node: Konva.Group) {
  connectionStartNode = node;
  const pos = node.position();
  const rect = node.findOne(".background") as Konva.Rect;
  const center = { x: pos.x + rect.width() / 2, y: pos.y + rect.height() / 2 };

  connectionLine = new Konva.Line({
    stroke: themes.dark.link,
    strokeWidth: 2,
    points: [center.x, center.y, center.x, center.y],
    dash: [10, 5],
  });
  layer.add(connectionLine);
}

// =================================================================
// 6. ノード・リンク作成ロジック (Core Logic)
// =================================================================

function createNewNode(
  x: number,
  y: number,
  textStr?: string,
  contentStr = "",
  isInteractive = true,
) {
  const nodeTitle =
    textStr !== undefined ? textStr : t("ideaProcessor.default.newNode");
  const id = `node_${generateUUID()}`;
  const node = createNodeFromData({
    id,
    x,
    y,
    width: 200,
    height: 60,
    title: nodeTitle,
    contentText: contentStr,
  });
  updateAllNodesAppearance();
  adjustNodeSize(node);
  renderIpOutline();
  // 手動作成（ダブルクリック等）の時だけ編集モードに入る
  if (isInteractive) {
    const textNode = node.findOne(".text") as Konva.Text;
    if (textNode) {
      setTimeout(() => {
        startTextEditing(textNode, node, true);
      }, 50);
    }
  }
  return node;
}

// --- グループノードの作成 ---
function createGroupNode(x: number, y: number, titleStr?: string) {
  const groupTitle =
    titleStr !== undefined ? titleStr : t("ideaProcessor.default.groupName");
  const id = `group_${generateUUID()}`;
  const colors = getCurrentThemeColors();

  const groupNode = new Konva.Group({
    id: id,
    x: x,
    y: y,
    draggable: true,
    name: "container-group",
  });

  // 子ノードIDリスト
  groupNode.setAttr("childNodeIds", []);

  // 背景枠 (点線)
  const bgRect = new Konva.Rect({
    name: "group-bg",
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    fill: "rgba(0,0,0,0)", // 完全透明ではなく、クリック判定用にアルファ0
    stroke: colors.text,
    strokeWidth: 1, // 1px
    dash: [5, 5],
    cornerRadius: 10,
  });

  // グループタイトル
  const titleText = new Konva.Text({
    name: "group-title",
    text: groupTitle,
    y: -25, // 枠の上に配置
    fontSize: 14,
    fontFamily: getKonvaFontFamily(),
    fill: colors.text,
  });

  // リサイズハンドル
  const resizeHandle = new Konva.Circle({
    name: "resize-handle",
    x: 300,
    y: 200,
    radius: 10, // 少し大きくして掴みやすく
    fill: colors.selection,
    stroke: colors.selection,
    strokeWidth: 1,
    draggable: true,
    visible: false, // 初期は非表示
    cursor: "nwse-resize",
  });

  // 追加順序が重要（ハンドルを最後にすることで最前面へ）
  groupNode.add(bgRect);
  groupNode.add(titleText);
  groupNode.add(resizeHandle);

  layer.add(groupNode);
  groupNode.moveToBottom();

  // --- イベント処理 ---

  let previousPos = groupNode.position();

  // --- 1. ハンドルの操作ロジック ---

  // ハンドルをクリック・ドラッグ開始した瞬間、親へのイベント伝播を止め、親の移動をロックする
  resizeHandle.on("mousedown touchstart", (e) => {
    e.cancelBubble = true; // ★親にイベントを渡さない
    groupNode.draggable(false); // ★親のドラッグを禁止
  });

  resizeHandle.on("dragmove", (e) => {
    e.cancelBubble = true;

    // 最小サイズ制限
    const newW = Math.max(100, resizeHandle.x());
    const newH = Math.max(50, resizeHandle.y());

    // ハンドルの位置を制限内に強制補正
    resizeHandle.x(newW);
    resizeHandle.y(newH);

    // 枠のサイズを更新
    bgRect.width(newW);
    bgRect.height(newH);

    layer.batchDraw();
  });

  resizeHandle.on("dragend", (e) => {
    e.cancelBubble = true;
    groupNode.draggable(true); // ★親のドラッグ許可を戻す
    recordHistory("Group resized");
  });

  // --- 2. グループ本体のドラッグロジック ---

  groupNode.on("dragstart", (e) => {
    // 万が一ハンドルがターゲットなら何もしない（念の為のガード）
    if (e.target.name() === "resize-handle") {
      e.cancelBubble = true;
      return;
    }
    previousPos = groupNode.position();
  });

  groupNode.on("dragmove", (e) => {
    if (e.target.name() === "resize-handle") return;

    const currentPos = groupNode.position();
    const dx = currentPos.x - previousPos.x;
    const dy = currentPos.y - previousPos.y;

    // 子ノード連動移動
    const childIds = groupNode.getAttr("childNodeIds") || [];
    childIds.forEach((childId: string) => {
      const child = layer.findOne("#" + childId) as Konva.Group;
      if (child) {
        child.x(child.x() + dx);
        child.y(child.y() + dy);
        updateConnectedLinks(child);
      }
    });
    previousPos = currentPos;
  });

  groupNode.on("dragend", (e) => {
    if (e.target.name() === "resize-handle") return;
    recordHistory("Group moved");
  });

  // タイトル編集
  titleText.on("dblclick", (e) => {
    e.cancelBubble = true; // 親のダブルクリック（新規作成）を防ぐ
    startGroupTitleEditing(titleText);
  });

  return groupNode;
}

function createSingleLink(
  fromNode: Konva.Group,
  toNode: Konva.Group,
  type: LinkType = LinkType.ARROW,
) {
  const id = `link_${generateUUID()}`;
  const colors = getCurrentThemeColors();
  const linkColor = colors.link;

  const linkGroup = new Konva.Group({
    name: "link-group",
    id: id,
    fromNodeId: fromNode.id(),
    toNodeId: toNode.id(),
    linkType: type,
  });

  linkGroup.setAttr("nodes", [fromNode, toNode]);

  // --- 線の生成 ---
  // hitStrokeWidth (当たり判定の太さ) を追加してクリックしやすくする
  if (type === LinkType.LINE) {
    linkGroup.add(
      new Konva.Line({
        stroke: linkColor,
        strokeWidth: 2,
        name: "link-shape",
        hitStrokeWidth: 15,
      }),
    );
  } else if (type === LinkType.ARROW) {
    linkGroup.add(
      new Konva.Arrow({
        points: [0, 0, 10, 10], // 必須なのでとりあえずダミーを入れる
        stroke: linkColor,
        fill: linkColor,
        strokeWidth: 2,
        pointerLength: 10,
        pointerWidth: 10,
        name: "link-shape",
        hitStrokeWidth: 15,
      }),
    );
  } else if (type === LinkType.DOUBLE_ARROW) {
    linkGroup.add(
      new Konva.Arrow({
        points: [0, 0, 10, 10],
        stroke: linkColor,
        fill: linkColor,
        strokeWidth: 2,
        pointerLength: 10,
        pointerWidth: 10,
        name: "link-shape-1",
        hitStrokeWidth: 15,
      }),
    );
    linkGroup.add(
      new Konva.Arrow({
        points: [0, 0, 10, 10],
        stroke: linkColor,
        fill: linkColor,
        strokeWidth: 2,
        pointerLength: 10,
        pointerWidth: 10,
        name: "link-shape-2",
        hitStrokeWidth: 15,
      }),
    );
  }

  // ラベルオブジェクトを生成 (Konva.Labelは背景とテキストをまとめるコンテナ)
  const labelGroup = new Konva.Label({
    name: "link-label-group",
    visible: false, // 初期は非表示
  });

  // TagがTextの背景として自動でリサイズされる
  labelGroup.add(
    new Konva.Tag({
      fill: colors.labelBackground,
      stroke: colors.text,
      strokeWidth: 1,
      cornerRadius: 3,
      name: "link-label-bg",
    }),
  );

  labelGroup.add(
    new Konva.Text({
      text: "",
      fontSize: 14,
      fontFamily: getKonvaFontFamily(),
      fill: linkColor, // 文字色もリンク色と同じ
      padding: 5,
      name: "link-label",
    }),
  );

  // メインのlinkGroupに追加
  linkGroup.add(labelGroup);

  layer.add(linkGroup);
  // 階層構造を整理する
  // 1. まず全グループを最背面に
  stage.find(".container-group").forEach((g) => g.moveToBottom());
  // 2. リンクをその一つ上に（全リンクをグループより上へ）
  linkGroup.moveToTop();
  // 3. 最後に全ノードを最前面に
  stage.find(".node-group").forEach((n) => n.moveToTop());
  // 4. 選択ツールをさらにその上に
  if (transformer) transformer.moveToTop();
  if (selectionRect) selectionRect.moveToTop();
  updateLinkPoints(linkGroup);

  // ホバー時に線を太くする
  linkGroup.on("mouseenter", () => {
    document.body.style.cursor = "pointer"; // カーソルを指マークに
    linkGroup.find("Line, Arrow").forEach((shape: any) => {
      shape.strokeWidth(4); // 線を太くする
    });
    layer.batchDraw();
  });

  linkGroup.on("mouseleave", () => {
    document.body.style.cursor = "default"; // カーソルを元に
    linkGroup.find("Line, Arrow").forEach((shape: any) => {
      shape.strokeWidth(2); // 線の太さを元に
    });
    layer.batchDraw();
  });

  return linkGroup;
}

function manageLink(clickedNode: Konva.Group, type: LinkType) {
  // すでに選択済みなら解除
  if (selectedNodes.includes(clickedNode)) {
    selectedNodes = selectedNodes.filter((n) => n !== clickedNode);
    // 選択解除されたノードの見た目を元に戻す
    const bg = clickedNode.findOne(".background") as Konva.Rect;
    if (bg) {
      bg.fill("transparent");
    }
  } else {
    // 選択リストに追加してハイライト
    selectedNodes.push(clickedNode);
    highlightShape(clickedNode);
  }

  layer.batchDraw();

  // 2つ選択されたらリンク作成（既存のロジック）
  if (selectedNodes.length === 2) {
    const node1 = selectedNodes[0];
    const node2 = selectedNodes[1];

    // リンク重複チェック
    const isDuplicate = layer.find(".link-group").some((linkGroup: any) => {
      const fromId = linkGroup.getAttr("fromNodeId");
      const toId = linkGroup.getAttr("toNodeId");
      return (
        (fromId === node1.id() && toId === node2.id()) ||
        (fromId === node2.id() && toId === node1.id())
      );
    });

    if (!isDuplicate) {
      createSingleLink(node1, node2, type);
      recordHistory("Link created");
    } else {
      console.log("Link already exists.");
    }

    deselectAll();
  }
}

function updateConnectedLinks(node: Konva.Group) {
  // 全リンクを走査して、このノードに繋がっているものだけ更新
  // (効率化のため。数が多い場合はキャッシュMapを使うのが定石だが今回はシンプルに)
  const links = layer.find(".link-group");
  links.forEach((linkGroup: any) => {
    const nodes = linkGroup.getAttr("nodes");
    if (nodes && (nodes[0] === node || nodes[1] === node)) {
      updateLinkPoints(linkGroup);
    }
  });
  layer.batchDraw();
}

function updateLinkPoints(linkGroup: Konva.Group) {
  let nodes = linkGroup.getAttr("nodes");

  // Undo後の復元ロジック
  if (!nodes || nodes.length < 2) {
    const fromId = linkGroup.getAttr("fromNodeId");
    const toId = linkGroup.getAttr("toNodeId");
    const fromNode = layer.findOne("#" + fromId);
    const toNode = layer.findOne("#" + toId);

    if (fromNode && toNode) {
      nodes = [fromNode, toNode];
      linkGroup.setAttr("nodes", nodes);
    } else {
      // 接続先が見つからない（削除済み）場合は描画スキップ
      return;
    }
  }

  const [node1, node2] = nodes;
  const rect1 = getClientRect(node1);
  const rect2 = getClientRect(node2);

  // 交点計算 (Infinity/NaN対策済み関数)
  const { start, end } = getIntersections(rect1, rect2);

  // 最終安全装置
  if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
    return;
  }

  const type = linkGroup.getAttr("linkType");
  if (type === LinkType.DOUBLE_ARROW) {
    // 双方向の場合は2本の矢印を逆向きにセット
    const arrow1 = linkGroup.findOne(".link-shape-1") as Konva.Arrow;
    const arrow2 = linkGroup.findOne(".link-shape-2") as Konva.Arrow;
    if (arrow1) arrow1.points([start.x, start.y, end.x, end.y]);
    if (arrow2) arrow2.points([end.x, end.y, start.x, start.y]); // 逆向き！
  } else {
    // 通常の線または片道矢印
    const shape = linkGroup.findOne(".link-shape") as Konva.Line;
    if (shape) shape.points([start.x, start.y, end.x, end.y]);
  }

  // --- ラベルの位置と表示状態の更新 ---
  const labelGroup = linkGroup.findOne(".link-label-group") as Konva.Label;
  const labelText = linkGroup.findOne(".link-label") as Konva.Text;

  if (labelGroup && labelText) {
    const text = labelText.text();

    // 1. 空文字なら隠して終了
    if (!text || text.trim() === "") {
      labelGroup.hide();
    } else {
      // 2. 文字があるなら表示して位置合わせ
      labelGroup.show();

      // リンクの中点
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;

      // Konva.Label は Tag のサイズに合わせて自動調整されるが、
      // 中心に配置するにはオフセットが必要
      const width = labelGroup.width();
      const height = labelGroup.height();

      labelGroup.position({
        x: midX - width / 2,
        y: midY - height / 2,
      });
    }
  }
}

function startLabelEditing(labelText: Konva.Text, linkGroup: Konva.Group) {
  if (isTextEditing) return;
  isTextEditing = true;

  const labelGroup = labelText.getParent() as Konva.Label;

  // 編集中はラベルを隠す
  labelGroup.hide();
  layer.batchDraw();

  // ラベルが見えていない(空の)場合、リンクの中央を計算してそこに入力欄を出す
  const stageBox = document
    .getElementById("ip-container")!
    .getBoundingClientRect();
  let areaLeft = 0;
  let areaTop = 0;

  // リンクの形状（矢印/線）を取得して端点を再計算
  const arrow =
    linkGroup.findOne(".link-shape") || linkGroup.findOne(".link-shape-1");
  if (arrow && (arrow as Konva.Arrow).points().length >= 4) {
    const pts = (arrow as Konva.Arrow).points();
    // リンクの中点 (ステージ上の相対座標)
    const midX = (pts[0] + pts[2]) / 2;
    const midY = (pts[1] + pts[3]) / 2;

    // ステージのズームと位置（pan）を考慮して絶対座標に変換
    const absX = midX * stage.scaleX() + stage.x();
    const absY = midY * stage.scaleY() + stage.y();

    areaLeft = stageBox.left + absX;
    areaTop = stageBox.top + absY;
  } else {
    // 万が一計算できない場合はマウス位置など（基本ここには来ない）
    areaLeft = stageBox.left + stage.getPointerPosition()!.x;
    areaTop = stageBox.top + stage.getPointerPosition()!.y;
  }

  // 入力欄の中心を合わせるための補正（初期サイズ分ずらす）
  areaLeft -= 20;
  areaTop -= 10;

  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);

  // 初期値
  textarea.value = labelText.text();

  // スタイル設定（スクロールバーなし、自動サイズ）
  textarea.style.position = "absolute";
  textarea.style.left = areaLeft + "px";
  textarea.style.top = areaTop + "px";

  // フォントスタイル同期
  const color = getCurrentThemeColors();
  textarea.style.fontSize = "12px";
  textarea.style.fontFamily = labelText.fontFamily();
  textarea.style.lineHeight = "1.2em";
  textarea.style.color = color.text;
  textarea.style.background = color.labelBackground;
  textarea.style.border = "1px solid " + color.text;
  textarea.style.outline = "none";
  textarea.style.overflow = "hidden";
  textarea.style.borderRadius = "3px";
  textarea.style.minWidth = "80px";
  textarea.style.zIndex = "500";

  // サイズ自動調整関数
  const updateSize = () => {
    textarea.style.width = "0px"; // 一旦縮める
    textarea.style.height = "0px";
    textarea.style.width = Math.max(40, textarea.scrollWidth) + 2 + "px";
    textarea.style.height = textarea.scrollHeight + 2 + "px";
  };
  updateSize(); // 初期サイズ

  textarea.focus();

  let isRemoving = false;

  const removeTextarea = () => {
    if (isRemoving) return;
    if (!textarea.parentNode) return;

    isRemoving = true;

    const newVal = textarea.value;

    // 値を更新
    if (newVal !== labelText.text()) {
      labelText.text(newVal);
      recordHistory("Label edited");
    }

    // ここで updateLinkPoints を呼ぶことで
    // 「空なら非表示」「文字があれば表示＆位置調整」が自動で行われる
    updateLinkPoints(linkGroup);

    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener("input", updateSize);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === "Escape") removeTextarea();
  });

  textarea.addEventListener("blur", removeTextarea);
}

function startGroupTitleEditing(titleText: Konva.Text) {
  if (isTextEditing) return;
  isTextEditing = true;

  // Konva側のテキストを隠す
  titleText.hide();
  layer.batchDraw();

  const areaPosition = titleText.getAbsolutePosition();
  const stageBox = document
    .getElementById("ip-container")!
    .getBoundingClientRect();
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);

  const color = getCurrentThemeColors();

  textarea.value = titleText.text();
  textarea.style.position = "absolute";
  textarea.style.left = stageBox.left + areaPosition.x + "px";
  textarea.style.top = stageBox.top + areaPosition.y + "px";
  textarea.style.background = color.labelBackground;
  textarea.style.color = color.text;
  textarea.style.border = "1px solid " + color.text;
  textarea.style.outline = "none";
  textarea.style.fontFamily = titleText.fontFamily();
  textarea.style.zIndex = "500";
  textarea.style.overflow = "hidden";
  textarea.focus();

  // 初期サイズ計算
  const updateSize = () => {
    textarea.style.width = "auto";
    textarea.style.height = "auto";
    textarea.style.width = textarea.scrollWidth + 10 + "px";
    textarea.style.height = textarea.scrollHeight + "px";
  };
  updateSize();

  textarea.focus();

  let isRemoving = false;

  const removeTextarea = () => {
    if (isRemoving) return;
    if (!textarea.parentNode) return;
    isRemoving = true;
    const newVal = textarea.value;
    if (newVal !== titleText.text()) {
      titleText.text(newVal);
      recordHistory("Group title edited");
      renderIpOutline();
    }
    titleText.show();
    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener("input", updateSize); // 入力時にサイズ更新

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === "Escape") removeTextarea();
  });
  textarea.addEventListener("blur", removeTextarea);
}

// --- テンプレート用ノード作成ヘルパー ---
function createTemplateNode(options: {
  x: number;
  y: number;
  title: string;
  placeholder: string;
}) {
  // 既存の createNewNode を利用
  const node = createNewNode(
    options.x,
    options.y,
    options.title,
    undefined,
    false,
  );

  // テンプレート属性を追加
  node.setAttr("isTemplateItem", true);
  node.setAttr("placeholder", options.placeholder);

  // 必要なら色を変える（例えばテンプレートは少し黄色っぽくするなど）
  // 今回は一旦デフォルト色のまま
  // colors.templateBg があれば適用
  /*
  const colors = getCurrentThemeColors();
  const bg = node.findOne('.background') as Konva.Rect;
  if (bg && colors.templateBg) bg.fill(colors.templateBg);
  */

  return node;
}

function generateTemplate(templateName: string) {
  // 画面中央あたりを基準にする
  const centerX = (-stage.x() + stage.width() / 2) / stage.scaleX();
  const centerY = (-stage.y() + stage.height() / 2) / stage.scaleY();
  const offsetX = centerX - 400; // 左上に配置するためのオフセット
  const offsetY = centerY - 300;

  // --- 1. グレマスの行為者モデル ---
  if (templateName === "greimas") {
    const group = createGroupNode(
      offsetX + 110,
      offsetY + 100,
      t("ideaProcessor.template.greimas.groupName"),
    );
    group.setAttr("isTemplateRoot", true);
    group.setAttr("archetype", "greimas");
    const bg = group.findOne(".group-bg") as Konva.Rect;
    const handle = group.findOne(".resize-handle") as Konva.Circle;
    if (bg) {
      bg.width(650);
      bg.height(350);
      handle.x(650);
      handle.y(350);
    }

    // ノード定義 (相対座標を考慮して配置)
    const startX = offsetX;
    const startY = offsetY;
    const gp = "ideaProcessor.template.greimas";
    const sujet = createTemplateNode({
      x: startX + 400,
      y: startY + 320,
      title: t(gp + ".nodes.sujet"),
      placeholder: t(gp + ".placeholders.sujet"),
    });
    const objet = createTemplateNode({
      x: startX + 400,
      y: startY + 170,
      title: t(gp + ".nodes.objet"),
      placeholder: t(gp + ".placeholders.objet"),
    });
    const destinateur = createTemplateNode({
      x: startX + 170,
      y: startY + 170,
      title: t(gp + ".nodes.destinateur"),
      placeholder: t(gp + ".placeholders.destinateur"),
    });
    const destinataire = createTemplateNode({
      x: startX + 630,
      y: startY + 170,
      title: t(gp + ".nodes.destinataire"),
      placeholder: t(gp + ".placeholders.destinataire"),
    });
    const adjuvant = createTemplateNode({
      x: startX + 170,
      y: startY + 320,
      title: t(gp + ".nodes.adjuvant"),
      placeholder: t(gp + ".placeholders.adjuvant"),
    });
    const opposant = createTemplateNode({
      x: startX + 630,
      y: startY + 320,
      title: t(gp + ".nodes.opposant"),
      placeholder: t(gp + ".placeholders.opposant"),
    });

    // グループへの登録
    const nodes = [sujet, objet, destinateur, destinataire, adjuvant, opposant];
    const childIds = nodes.map((n) => n.id());
    group.setAttr("childNodeIds", childIds);
    nodes.forEach((node) => {
      node.setAttr("parentId", group.id());
    });
    updateGroupMembersAppearance(group, false); // 念のため色更新

    // リンク作成
    createSingleLink(sujet, objet, LinkType.ARROW);
    createSingleLink(destinateur, objet, LinkType.ARROW);
    createSingleLink(objet, destinataire, LinkType.ARROW);
    createSingleLink(adjuvant, sujet, LinkType.ARROW);
    createSingleLink(opposant, sujet, LinkType.ARROW);

    recordHistory("Template created: Greimas");
  }

  // --- 2. 英雄の旅 (Hero's Journey) ---
  else if (templateName === "heros-journey") {
    const group = createGroupNode(
      offsetX + 50,
      offsetY + 50,
      t("ideaProcessor.template.herosJourney.groupName"),
    );
    group.setAttr("isTemplateRoot", true);
    group.setAttr("archetype", "heros-journey");
    const bg = group.findOne(".group-bg") as Konva.Rect;
    const handle = group.findOne(".resize-handle") as Konva.Circle;
    if (bg) {
      bg.width(900);
      bg.height(700);
      handle.x(900);
      handle.y(700);
    }

    const steps = 12;
    const cx = offsetX + 450;
    const cy = offsetY + 350;
    const rx = 380;
    const ry = 280;

    const hj = "ideaProcessor.template.herosJourney";
    const journeyData = [
      { title: t(hj + ".steps.1"), placeholder: t(hj + ".placeholders.1") },
      { title: t(hj + ".steps.2"), placeholder: t(hj + ".placeholders.2") },
      { title: t(hj + ".steps.3"), placeholder: t(hj + ".placeholders.3") },
      { title: t(hj + ".steps.4"), placeholder: t(hj + ".placeholders.4") },
      { title: t(hj + ".steps.5"), placeholder: t(hj + ".placeholders.5") },
      { title: t(hj + ".steps.6"), placeholder: t(hj + ".placeholders.6") },
      { title: t(hj + ".steps.7"), placeholder: t(hj + ".placeholders.7") },
      { title: t(hj + ".steps.8"), placeholder: t(hj + ".placeholders.8") },
      { title: t(hj + ".steps.9"), placeholder: t(hj + ".placeholders.9") },
      { title: t(hj + ".steps.10"), placeholder: t(hj + ".placeholders.10") },
      { title: t(hj + ".steps.11"), placeholder: t(hj + ".placeholders.11") },
      { title: t(hj + ".steps.12"), placeholder: t(hj + ".placeholders.12") },
    ];

    const createdNodes: Konva.Group[] = [];
    journeyData.forEach((data, i) => {
      const angle = (i / steps) * 2 * Math.PI - Math.PI / 2;
      const nx = cx + rx * Math.cos(angle);
      const ny = cy + ry * Math.sin(angle);
      createdNodes.push(
        createTemplateNode({
          x: nx,
          y: ny,
          title: data.title,
          placeholder: data.placeholder,
        }),
      );
    });

    group.setAttr(
      "childNodeIds",
      createdNodes.map((n) => n.id()),
    );
    createdNodes.forEach((node) => {
      node.setAttr("parentId", group.id());
    });
    updateGroupMembersAppearance(group, false);

    for (let i = 0; i < createdNodes.length; i++) {
      const from = createdNodes[i];
      const to = createdNodes[(i + 1) % createdNodes.length];
      createSingleLink(from, to, LinkType.ARROW);
    }
    recordHistory("Template created: Hero's Journey");
  }

  // --- 3. ビートシート (Beat Sheet) ---
  else if (templateName === "beat-sheet") {
    const group = createGroupNode(
      offsetX + 50,
      offsetY + 50,
      t("ideaProcessor.template.beatSheet.groupName"),
    );
    group.setAttr("isTemplateRoot", true);
    group.setAttr("archetype", "beat-sheet");
    const bg = group.findOne(".group-bg") as Konva.Rect;
    const handle = group.findOne(".resize-handle") as Konva.Circle;
    if (bg) {
      bg.width(1050);
      bg.height(550);
      handle.x(1050);
      handle.y(550);
    }

    const bs = "ideaProcessor.template.beatSheet";
    const beatData = [
      { title: t(bs + ".beats.1"), placeholder: "" },
      { title: t(bs + ".beats.2"), placeholder: "" },
      { title: t(bs + ".beats.3"), placeholder: "" },
      { title: t(bs + ".beats.4"), placeholder: "" },
      { title: t(bs + ".beats.5"), placeholder: "" },
      { title: t(bs + ".beats.6"), placeholder: "" },
      { title: t(bs + ".beats.7"), placeholder: "" },
      { title: t(bs + ".beats.8"), placeholder: "" },
      { title: t(bs + ".beats.9"), placeholder: "" },
      { title: t(bs + ".beats.10"), placeholder: "" },
      { title: t(bs + ".beats.11"), placeholder: "" },
      { title: t(bs + ".beats.12"), placeholder: "" },
    ];
    // 相対座標定義 (Electron版準拠 + オフセット)
    const positions = [
      { x: 79, y: 103 },
      { x: 303, y: 146 },
      { x: 510, y: 107 },
      { x: 711, y: 68 },
      { x: 902, y: 156 },
      { x: 798, y: 338 },
      { x: 537, y: 278 },
      { x: 284, y: 291 },
      { x: 87, y: 393 },
      { x: 237, y: 518 },
      { x: 505, y: 472 },
      { x: 815, y: 494 },
    ];

    const createdNodes: Konva.Group[] = [];
    beatData.forEach((data, i) => {
      const p = positions[i];
      createdNodes.push(
        createTemplateNode({
          x: offsetX + p.x,
          y: offsetY + p.y,
          title: data.title,
          placeholder: data.placeholder,
        }),
      );
    });

    group.setAttr(
      "childNodeIds",
      createdNodes.map((n) => n.id()),
    );
    createdNodes.forEach((node) => {
      node.setAttr("parentId", group.id());
    });
    updateGroupMembersAppearance(group, false);

    for (let i = 0; i < 11; i++) {
      createSingleLink(createdNodes[i], createdNodes[i + 1], LinkType.ARROW);
    }
    recordHistory("Template created: Beat Sheet");
  }

  // --- 4. 三幕構成 ---
  else if (templateName === "three-act-structure") {
    const group = createGroupNode(
      offsetX + 100,
      offsetY + 100,
      t("ideaProcessor.template.threeAct.groupName"),
    );
    group.setAttr("isTemplateRoot", true);
    group.setAttr("archetype", "three-act-structure");
    const bg = group.findOne(".group-bg") as Konva.Rect;
    const handle = group.findOne(".resize-handle") as Konva.Circle;
    if (bg) {
      bg.width(800);
      bg.height(250);
      handle.x(800);
      handle.y(250);
    }

    const ta = "ideaProcessor.template.threeAct";
    const actData = [
      { title: t(ta + ".acts.1"), placeholder: "" },
      { title: t(ta + ".acts.2"), placeholder: "" },
      { title: t(ta + ".acts.3"), placeholder: "" },
    ];

    const createdNodes: Konva.Group[] = [];
    actData.forEach((data, i) => {
      createdNodes.push(
        createTemplateNode({
          x: offsetX + 150 + i * 250,
          y: offsetY + 150,
          title: data.title,
          placeholder: data.placeholder,
        }),
      );
    });

    group.setAttr(
      "childNodeIds",
      createdNodes.map((n) => n.id()),
    );
    createdNodes.forEach((node) => {
      node.setAttr("parentId", group.id());
    });
    updateGroupMembersAppearance(group, false);

    createSingleLink(createdNodes[0], createdNodes[1], LinkType.ARROW);
    createSingleLink(createdNodes[1], createdNodes[2], LinkType.ARROW);
    recordHistory("Template created: Three-Act Structure");
  }

  layer.batchDraw();
  renderIpOutline();
}

// =================================================================
// コンテンツエディタ (Markdown編集)
// =================================================================

function openContentEditor(nodeGroup: Konva.Group) {
  if (!editorPane || !contentEditor) return;

  isContentEditing = true;
  isTextEditing = true; // ショートカットキー等を無効化するため

  // stage.listening(false) は、Tauri版ではパンなどが動かなくなる可能性があるため
  // 代わりに isContentEditing フラグでイベントをガードする方針

  if (currentlyEditingNodeId && currentlyEditingNodeId !== nodeGroup.id()) {
    saveContentChanges();
  }

  currentlyEditingNodeId = nodeGroup.id();

  // テキストノードから内容を取得
  let content = nodeGroup.getAttr("contentText") || "";

  // プレースホルダー処理 (テンプレートなどで設定されている場合)
  const placeholder =
    nodeGroup.getAttr("placeholder") ||
    t("ideaProcessor.placeholder.contentEditor");
  let isInitialContent = false;
  contentEditor.placeholder = placeholder;

  if (!content.trim() && !placeholder) {
    // 空の場合はデフォルト文字を入れない方が使いやすいか
    // content = 'New Content';
    // isInitialContent = true;
  }
  contentEditor.value = content;

  editorPane.classList.remove("hidden");
  contentEditor.focus();

  // カーソル制御
  if (isInitialContent) {
    contentEditor.select();
  } else {
    // 末尾にカーソル
    contentEditor.setSelectionRange(
      contentEditor.value.length,
      contentEditor.value.length,
    );
  }

  // リスナー登録
  contentEditor.addEventListener("keydown", handleContentEditorKeyDown);
}

const handleContentEditorKeyDown = (e: KeyboardEvent) => {
  // エディタ内でのDelete等はキャンバスに伝播させない
  e.stopPropagation();

  const isCtrl = e.ctrlKey || e.metaKey;
  const isShift = e.shiftKey;
  const key = e.key.toLowerCase();

  // Template Completion のショートカット
  if (isCtrl && isShift && key === "f") {
    e.preventDefault();
    e.stopPropagation();
    triggerTemplateCompletion();
    return;
  }

  // DeleteやBackspaceがノード削除を暴発させないようにする
  if (e.key === "Delete" || e.key === "Backspace") {
    e.stopPropagation();
  }

  // Escapeで閉じる
  if (e.key === "Escape") {
    e.preventDefault();
    closeContentEditor();
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    closeContentEditor();
  }
};

function saveContentChanges() {
  if (!currentlyEditingNodeId) return;

  const node = layer.findOne("#" + currentlyEditingNodeId) as Konva.Group;
  if (node) {
    const textNode = node.findOne(".text") as Konva.Text;
    if (textNode) {
      const oldText = node.getAttr("contentText") || "";
      const newText = contentEditor.value;

      if (oldText !== newText) {
        node.setAttr("contentText", newText);

        recordHistory("Node content changed");
        renderIpOutline();
      }
    }
  }
}

function closeContentEditor() {
  saveContentChanges();
  if (editorPane) editorPane.classList.add("hidden");

  // ★ ブラウザのテキスト選択状態を強制クリア
  if (window.getSelection) {
    window.getSelection()?.removeAllRanges();
  }
  // テキストエリア自体のフォーカスも外す
  if (contentEditor) contentEditor.blur();

  currentlyEditingNodeId = null;
  isContentEditing = false;
  isTextEditing = false;

  // ガードフラグを立てる
  contentEditorJustClosed = true;
  setTimeout(() => {
    contentEditorJustClosed = false;
  }, 200);

  // ステージにフォーカスを戻す
  const container = stage.container();
  container.focus(); // Konvaコンテナにフォーカス

  if (contentEditor) {
    contentEditor.removeEventListener("keydown", handleContentEditorKeyDown);
  }
  layer.batchDraw();
}

// =================================================================
// 7. 数学・ヘルパー関数
// =================================================================

function getClientRect(node: Konva.Group) {
  const bg = node.findOne(".background") as Konva.Rect;
  return {
    x: node.x(),
    y: node.y(),
    width: bg ? bg.width() : 150,
    height: bg ? bg.height() : 100,
  };
}

function getIntersections(r1: any, r2: any) {
  const c1 = { x: r1.x + r1.width / 2, y: r1.y + r1.height / 2 };
  const c2 = { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };

  const intersect = (
    w: number,
    h: number,
    from: Vector2d,
    to: Vector2d,
  ): Vector2d => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    // ゼロ除算・重なり対策
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return from;

    let t = Infinity;
    // 矩形の境界との交差判定 (y = ax + b の応用)
    const hw = w / 2;
    const hh = h / 2;

    if (dx !== 0) t = Math.min(t, Math.abs(hw / dx));
    if (dy !== 0) t = Math.min(t, Math.abs(hh / dy));

    if (!isFinite(t)) return from;

    return { x: from.x + dx * t, y: from.y + dy * t };
  };

  return {
    start: intersect(r1.width, r1.height, c1, c2),
    end: intersect(r2.width, r2.height, c2, c1),
  };
}

function generateUUID() {
  return window.crypto.randomUUID();
}

function setupKeyboardEvents() {
  // AI動作中のガード
  window.addEventListener(
    "keydown",
    (e) => {
      if (isAiThinking) {
        // Escapeは中断処理として通す
        if (e.key === "Escape") {
          abortAiProcessing();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
  // 通常のキー処理
  document.addEventListener("keydown", async (e) => {
    if (isAiThinking) return; // 保険
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const key = e.key.toLowerCase();
    const isControl = e.ctrlKey;
    const isCmd = e.metaKey;

    if (isTextEditing) return;

    if (isCtrl && key === "z" && !isShift) {
      e.preventDefault();
      undo();
    }
    if ((isCtrl && key === "y") || (isCtrl && isShift && key === "z")) {
      e.preventDefault();
      redo();
    }
    // 閉じる (Ctrl + I)
    if (isCtrl && key === "i" && !isShift) {
      e.preventDefault();
      IPClose();
    }
    // テーマ切り替え (Ctrl + T)
    if (isCtrl && key === "t" && !isShift) {
      e.preventDefault();
      IPThemeToggle();
    }
    if (isCtrl && key === "o" && !isShift) {
      e.preventDefault();
      loadFromMrsd();
    }
    if (isCtrl && key === "n" && !isShift) {
      e.preventDefault();
      newFile();
    }
    if (isCtrl && key === "g" && !isShift) {
      e.preventDefault();
      createGroupNodeByButton();
    }
    if (isCtrl && key === "r" && !isShift) {
      e.preventDefault();
      InitializeStage();
    }
    if (isCtrl && key === "r" && isShift) {
      e.preventDefault();
      return;
    }
    if (isCtrl && key === "p" && !isShift) {
      e.preventDefault();
    }
    if (isCtrl && isShift && key === "o") {
      e.preventDefault();
      toggleOutlinePane();
    }
    if (isCtrl && e.shiftKey && key === "f") {
      e.preventDefault();
      if (isContentEditing) {
        triggerTemplateCompletion();
      } else if (selectedShape && selectedShape.name() === "link-group") {
        triggerIpMissingLink();
      } else if (selectedNodes.length > 1 && !isTextEditing) {
        triggerNodeAlchemy();
      } else if (selectedNodes.length === 1 && !isTextEditing) {
        triggerFreeAssociation();
      }
    }
    if (isCtrl && key === "f" && !isShift) {
      if (!isTextEditing) e.preventDefault();
    }
    if (isCtrl && key === "e" && !isShift) {
      e.preventDefault();
      e.stopPropagation();
      const exportMenu = document.getElementById("ip-export-menu");
      if (exportMenu) exportMenu.classList.toggle("hidden");
    }

    // フルスクリーン切り替え
    // Mac: Cmd + Ctrl + F
    // Win: F11
    if (osType === "macos") {
      if (isCmd && isControl && key === "f") {
        e.preventDefault();
        IPToggleFullscreen();
      }
    } else {
      if (key === "f11") {
        e.preventDefault();
        IPToggleFullscreen();
      }
    }

    // サブウィンドウ
    if (e.key === "F2") {
      e.preventDefault();
      invoke("open_settings_window");
    }

    if (isCtrl && isShift && key === "a") {
      e.preventDefault();
      invoke("open_ai_chat");
    }

    if (isCtrl && key === "b" && isShift) {
      e.preventDefault();
      invoke("open_vivliostyle");
    }

    if (
      (isCtrl && key === "`") ||
      (isCtrl && key === "@")
    ) {
      e.preventDefault();
      invoke("open_terminal_window");
    }

    // Shift + Enter : 画面中央にノード作成
    if (isShift && e.key === "Enter") {
      e.preventDefault();

      const scale = stage.scaleX();
      const stagePos = stage.position();

      // 画面中央の論理座標（ズーム・パン考慮）
      // width/height はステージサイズ（ウィンドウサイズ）
      let targetX = (-stagePos.x + stage.width() / 2) / scale;
      let targetY = (-stagePos.y + stage.height() / 2) / scale;

      // 重なりチェック
      // 中心から少しずつ下にずらして空いている場所を探す
      const nodeHeight = 70; // ずらす幅
      let existingNode: Konva.Node | null = null;

      // ループ上限を設けて無限ループ防止
      let attempts = 0;
      const maxAttempts = 20;

      do {
        // getIntersection はスクリーン上の絶対座標(クライアント座標に近い)で判定するが、
        // Konvaの場合は stage.getIntersection({x, y}) でステージ上の絶対座標を指定する
        const absoluteCheckPos = {
          x: targetX * scale + stagePos.x,
          y: targetY * scale + stagePos.y,
        };

        // その地点に何かあるか？
        existingNode = stage.getIntersection(absoluteCheckPos);

        // ノードグループの一部であれば「重なっている」と判定
        let isOverlapping = false;
        if (existingNode) {
          // 親を辿って node-group か確認
          let parent = existingNode.getParent();
          while (parent && parent !== stage) {
            if (parent.name() === "node-group") {
              isOverlapping = true;
              break;
            }
            parent = parent.getParent();
          }
        }

        if (isOverlapping) {
          targetY += nodeHeight; // 下にずらす
        } else {
          break; // 空いている
        }
        attempts++;
      } while (attempts < maxAttempts);

      // ノード作成 (中心座標になるようにオフセット調整)
      // createNewNode は左上座標を指定するので、幅の半分(60)と高さの半分(30)を引く
      createNewNode(targetX - 60, targetY - 30);
      recordHistory("Node created (Shift+Enter)");
    }

    // --- 削除機能 ---
    if ((key === "delete" || key === "backspace") && !isTextEditing) {
      if (selectedShape) {
        e.preventDefault();

        // 1. テンプレートノード（子）の単体削除を禁止
        if (selectedShape.getAttr("isTemplateItem") === true) {
          console.log("Template items are protected.");
          return;
        }

        // 2. ノード（node-group）を消す場合のリンク巻き添え処理
        if (selectedShape.name() === "node-group") {
          const links = layer.find(".link-group");
          links.forEach((link: any) => {
            const nodes = link.getAttr("nodes");
            if (
              nodes &&
              (nodes[0] === selectedShape || nodes[1] === selectedShape)
            ) {
              link.destroy();
            }
          });
        }

        // 3. グループ（container-group）を消す場合の処理
        if (selectedShape.name() === "container-group") {
          const childIds = selectedShape.getAttr("childNodeIds") || [];

          // テンプレートルートなら所属ノード（と、そのリンク）をすべて道連れにする
          if (selectedShape.getAttr("isTemplateRoot") === true) {
            childIds.forEach((id: string) => {
              const childNode = layer.findOne("#" + id) as Konva.Group;
              if (childNode) {
                // 子ノードに繋がっているリンクも消す
                const links = layer.find(".link-group");
                links.forEach((link: any) => {
                  const nodes = link.getAttr("nodes");
                  if (
                    nodes &&
                    (nodes[0] === childNode || nodes[1] === childNode)
                  ) {
                    link.destroy();
                  }
                });
                childNode.destroy();
              }
            });
          } else {
            // 通常のグループなら、ペアリングを解除するだけ（ノードは残す）
            childIds.forEach((id: string) => {
              const childNode = layer.findOne("#" + id) as Konva.Group;
              if (childNode) {
                childNode.setAttr("parentId", null);
                const bg = childNode.findOne(".background") as Konva.Rect;
                if (bg) bg.strokeEnabled(false);
              }
            });
          }
        }

        // 4. 最後に選択されていた本体を削除
        selectedShape.destroy();
        deselectAll();
        recordHistory("Deleted");
        renderIpOutline();
      }
    }
  });
}

function startTextEditing(
  textNode: Konva.Text,
  group: Konva.Group,
  isNew = false,
) {
  if (isTextEditing) return;
  isTextEditing = true;

  textNode.hide();
  deselectAll();
  layer.batchDraw();

  const stageBox = document
    .getElementById("ip-container")!
    .getBoundingClientRect();
  const bg = group.findOne(".background") as Konva.Rect;
  const bgPos = bg.getAbsolutePosition();

  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);

  textarea.value = textNode.text();
  textarea.style.position = "absolute";
  textarea.style.left = stageBox.left + bgPos.x + "px";
  textarea.style.top = stageBox.top + bgPos.y + "px";
  const scale = stage.scaleX();
  textarea.style.width = bg.width() * scale + "px";
  textarea.style.height = bg.height() * scale + "px";
  textarea.style.fontSize = textNode.fontSize() * scale + "px";
  textarea.style.fontFamily = textNode.fontFamily();
  textarea.style.lineHeight = "1.2";
  textarea.style.textAlign = textNode.align();

  const color = getCurrentThemeColors();
  textarea.style.color = color.text;
  // グロー効果（CSSのtext-shadow）を適用
  if (document.body.classList.contains("custom-glow")) {
    textarea.style.textShadow = "var(--custom-text-shadow)";
  } else {
    textarea.style.textShadow = "none";
  }
  textarea.style.background = color.labelBackground;
  textarea.style.border = "1px solid " + color.text;
  textarea.style.borderRadius = 6 * scale + "px";
  textarea.style.outline = "none";
  textarea.style.resize = "none";
  textarea.style.padding = 12 * scale + "px";
  textarea.style.margin = "0px";
  textarea.style.overflow = "hidden";
  textarea.style.zIndex = "500";
  textarea.style.minWidth = 150 * scale + "px";
  textarea.style.boxSizing = "border-box";

  // --- サイズ調整ロジック ---
  const updateTextareaSize = () => {
    // 一旦リセットしないと縮まない
    textarea.style.height = "0px";
    textarea.style.width = "0px";

    // スクロールサイズに合わせて広げる
    const newWidth = textarea.scrollWidth;
    const newHeight = textarea.scrollHeight;

    textarea.style.width = newWidth + "px";
    textarea.style.height = newHeight + "px";
  };

  // DOM描画待ちをしてからリサイズ計算を走らせる
  requestAnimationFrame(() => {
    updateTextareaSize();
  });

  textarea.focus();

  // 新規なら全選択、既存なら末尾へ
  if (isNew) {
    textarea.select();
  } else {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // イベントリスナー
  textarea.addEventListener("mousedown", (e) => e.stopPropagation());
  textarea.addEventListener("click", (e) => e.stopPropagation());

  // 入力時のリサイズ
  textarea.addEventListener("input", updateTextareaSize);

  let isRemoving = false; // 多重実行を防止するローカルフラグ
  const removeTextarea = () => {
    if (isRemoving) return;
    if (!textarea.parentNode) return;

    isRemoving = true;

    const newVal = textarea.value;
    const oldText = textNode.text(); // 変更判定用

    // テキスト更新
    if (newVal !== oldText) {
      textNode.text(newVal);
      updateConnectedLinks(group);
    }
    adjustNodeSize(group);
    // 履歴記録の分岐
    if (isNew) {
      // 新規作成時は、テキスト確定をもって「Node created」とする
      recordHistory("Node created");
      renderIpOutline();
    } else if (newVal !== oldText) {
      // 既存編集は変更があった場合のみ
      recordHistory("Node text changed");
      renderIpOutline();
    }
    textNode.show();
    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === "Escape") removeTextarea();
  });

  textarea.addEventListener("blur", removeTextarea);
}

// --- 現在のテーマカラーを動的に取得するヘルパー ---
function getCurrentThemeColors() {
  const isDark = document.body.classList.contains("dark-mode");
  // ダークモードならカスタム設定を無視して固定値を返す
  if (isDark) {
    return themes.dark;
  }

  // :root (documentElement) のインラインスタイルから直接読み取る
  const inlineStyle = document.documentElement.style;
  const customText = inlineStyle.getPropertyValue("--editor-text-color").trim();
  const customSelection = inlineStyle
    .getPropertyValue("--editor-selection-color")
    .trim();
  const customHeading = inlineStyle.getPropertyValue("--heading-color").trim();
  const customScrollbar = inlineStyle
    .getPropertyValue("--scrollbar-color")
    .trim();
  const customBg = inlineStyle.getPropertyValue("--window-bg-color").trim();
  const customEdBg = inlineStyle.getPropertyValue("--editor-bg-color").trim();

  return {
    text: customText || themes.light.text,
    link: customText || themes.light.text, // リンクはテキストに合わせる
    selection: customSelection || themes.light.selection,
    nodeBg: customEdBg || themes.light.nodeBg,
    labelBackground: customBg || themes.light.labelBackground,
    heading: customHeading || themes.light.heading,
    scrollbar: customScrollbar || themes.light.scroll,
  };
}

// --- 選択状態のリセット ---
function deselectAll() {
  console.log("[Debug] deselectAll called");
  const colors = getCurrentThemeColors();

  // ハイライト解除
  stage.find(".node-group").forEach((node: any) => {
    const bg = node.findOne(".background");
    if (bg) {
      bg.fill(colors.nodeBg);
      bg.strokeEnabled(false);
    }
  });

  // リンクと矢印を正しい色に戻す
  stage.find(".link-group").forEach((link: any) => {
    link.find("Line, Arrow").forEach((shape: any) => {
      shape.stroke(colors.link);
      shape.fill(colors.link);
    });
  });

  stage.find(".container-group").forEach((group: any) => {
    const bg = group.findOne(".group-bg") as Konva.Rect;
    if (bg) {
      bg.stroke(colors.text);
      bg.fill(colors.nodeBg);
      bg.dash([5, 5]);
    }
    // ハンドルを隠す
    const handle = group.findOne(".resize-handle") as Konva.Circle;
    if (handle) handle.visible(false);
    // 所属ノードのハイライトも解除 (false)
    updateGroupMembersAppearance(group, false);
  });

  transformer.nodes([]);
  selectedNodes = [];
  selectedShape = null;
  layer.batchDraw();
}

// --- ハイライト適用（ノード・リンク共通） ---
function highlightShape(shape: Konva.Group) {
  const colors = getCurrentThemeColors();

  if (shape.name() === "node-group") {
    // ノードの場合：背景を塗る
    const bg = shape.findOne(".background") as Konva.Rect;
    if (bg) {
      bg.strokeEnabled(false);
      bg.fill(colors.selection);
    }
  } else if (shape.name() === "container-group") {
    const bg = shape.findOne(".group-bg") as Konva.Rect;
    if (bg) {
      bg.stroke(colors.selection);
      bg.fill(colors.selection);
      bg.dash([]);
      const handle = shape.findOne(".resize-handle") as Konva.Circle;
      if (handle) {
        handle.fill(colors.selection);
        handle.visible(true); // 選択時は必ず表示
      }
    }
  } else if (shape.name() === "link-group") {
    // リンクの場合：線とアローヘッドを塗る
    shape.find("Line, Arrow").forEach((s: any) => {
      s.stroke(colors.heading); // 線の色
      s.fill(colors.heading); // アローヘッドの中身
    });
  }
}

function updateGroupMembersAppearance(
  groupNode: Konva.Group,
  isSelected: boolean,
) {
  const colors = getCurrentThemeColors();
  const childIds = groupNode.getAttr("childNodeIds") || [];

  childIds.forEach((id: string) => {
    const node = layer.findOne("#" + id) as Konva.Group;
    if (node) {
      const bg = node.findOne(".background") as Konva.Rect;
      if (bg) {
        if (isSelected) {
          bg.stroke(colors.selection);
          bg.strokeWidth(1);
          bg.fill(colors.selection);
          bg.strokeEnabled(true);
        } else {
          bg.strokeEnabled(false);
          bg.fill(colors.nodeBg);
        }
      }
    }
  });
  layer.batchDraw();
}

// --- 形状（ノードまたはリンク・グループ）の単一選択 ---
function selectShape(shape: Konva.Group) {
  deselectAll();
  selectedShape = shape;

  if (shape.name() === "node-group") {
    transformer.nodes([shape]);
    selectedNodes = [shape];
  } else if (shape.name() === "container-group") {
    // グループノードの選択処理
    transformer.nodes([]); // グループにはTransformerをつけない
    selectedNodes = []; // グループ自体は複数選択の対象にしない（単独扱い）

    // ハンドルを表示
    const handle = shape.findOne(".resize-handle") as Konva.Circle;
    if (handle) handle.visible(true);

    // 登録済みノードの色を更新（メンバーであることを示す）
    updateGroupMembersAppearance(shape, true);
  } else if (shape.name() === "link-group") {
    transformer.nodes([]);
    selectedNodes = [];
  }

  // 最後に共通のハイライト処理を呼ぶ
  highlightShape(shape);
  layer.batchDraw();
}

// ■ 現在のテーマ・設定に合わせてKonvaノードの色と影を一括更新する
async function updateAllNodesAppearance() {
  if (!store) return;
  const isDark = document.body.classList.contains("dark-mode");
  const colors = getCurrentThemeColors();
  const userFont = document.documentElement.style
    .getPropertyValue("--user-font-family")
    .replace(/"/g, "");
  const finalFont = userFont || "serif-ja, serif";

  // グロー設定の取得
  const enableGlow =
    !isDark && (await store.get<boolean>("enableGlow")) === true;
  const gColor =
    (await store.get<string>("glowColor")) || "rgba(0, 255, 65, 0.5)";
  const gRadius = (await store.get<number>("glowRadius")) || 5;

  // --- ノードの更新 ---
  stage.find(".node-group").forEach((group: any) => {
    const textNode = group.findOne(".text") as Konva.Text;
    if (textNode) {
      textNode.fill(colors.text); // カスタムカラーを適用
      if (enableGlow) {
        textNode.shadowColor(gColor);
        textNode.shadowBlur(gRadius);
        textNode.shadowOffsetX(0);
        textNode.shadowOffsetY(0);
        textNode.shadowOpacity(1);
        textNode.shadowEnabled(true);
      } else {
        textNode.shadowEnabled(false);
      }
    }
  });

  // --- リンクとラベルの更新 ---
  stage.find(".link-group").forEach((group: any) => {
    // 線の色
    group.find("Line, Arrow").forEach((shape: any) => {
      shape.stroke(colors.link);
      shape.fill(colors.link);
    });

    // ラベルのテキスト色と影
    const labelText = group.findOne(".link-label") as Konva.Text;
    if (labelText) {
      labelText.fill(colors.text);
      if (enableGlow) {
        labelText.shadowColor(gColor);
        labelText.shadowBlur(gRadius);
        labelText.shadowOffsetX(0);
        labelText.shadowOffsetY(0);
        labelText.shadowOpacity(1);
        labelText.shadowEnabled(true);
      } else {
        labelText.shadowEnabled(false);
      }
    }

    // ラベルの背景色
    const labelBg = group.findOne(".link-label-bg") as Konva.Rect;
    if (labelBg) {
      labelBg.fill(colors.labelBackground);
    }
  });

  stage.find(".container-group").forEach((group: any) => {
    // もしこのグループが「選択中」なら、テーマ色で上書きせず選択色を維持する
    const isSelected = selectedShape === group;

    const bg = group.findOne(".group-bg") as Konva.Rect;
    if (bg) {
      // 選択中なら selection、そうでなければ text 色
      bg.stroke(isSelected ? colors.selection : colors.text);
    }

    const title = group.findOne(".group-title") as Konva.Text;
    if (title) {
      title.fill(colors.text);
    }
  });

  stage.find(".text, .link-label, .group-title").forEach((textNode: any) => {
    textNode.fontFamily(finalFont);
  });

  layer.batchDraw();
}

// --- セーブ処理 (saveToMrsd) ---
async function saveToMrsd(forceSaveAs = false) {
  let savePath = currentFilePath;

  if (!savePath || forceSaveAs) {
    const selected = await save({
      filters: [{ name: "MirrorShard Data", extensions: ["mrsd"] }],
    });
    if (!selected) return;
    savePath = selected;
  }

  try {
    const zip = new JSZip();
    const filesFolder = zip.folder("files");

    // 1. グループ情報の抽出 & 座標マップ作成
    const groups: MrsdGroup[] = [];
    // ノード保存時の計算用に、グループの座標を記録しておくマップ
    const groupPosMap = new Map<string, { x: number; y: number }>();
    const nodeParentMap = new Map<string, string>();

    stage.find<Konva.Group>(".container-group").forEach((group) => {
      const bg = group.findOne(".group-bg") as Konva.Rect;
      const title = group.findOne(".group-title") as Konva.Text;
      const childIds = group.getAttr("childNodeIds") || [];

      // 所属マップと座標マップを更新
      childIds.forEach((childId: string) => {
        nodeParentMap.set(childId, group.id());
      });
      groupPosMap.set(group.id(), { x: group.x(), y: group.y() });

      if (bg && title) {
        groups.push({
          id: group.id(),
          x: group.x(),
          y: group.y(),
          width: bg.width(),
          height: bg.height(),
          label: title.text(),
          isTemplateRoot: group.getAttr("isTemplateRoot") || false,
          archetype: group.getAttr("archetype") || "",
          childNodeIds: group.getAttr("childNodeIds") || [],
          isCollapsed: false,
        });
      }
    });

    // 2. ノード情報の抽出 (相対座標変換)
    const nodes: MrsdNode[] = [];

    stage.find<Konva.Group>(".node-group").forEach((node) => {
      const bg = node.findOne(".background") as Konva.Rect;
      const textNode = node.findOne(".text") as Konva.Text;
      if (!bg || !textNode) return;

      const title = textNode.text();
      const content = node.getAttr("contentText") || "";
      const placeholder = node.getAttr("placeholder") || "";
      const safeTitle =
        title
          .split("\n")[0]
          .substring(0, 15)
          .replace(/[\\/:*?"<>|]/g, "_") || "Untitled";
      const fileName = `${safeTitle}_${node.id().slice(-6)}.md`;

      const parentId = nodeParentMap.get(node.id()) || null;
      let saveX = node.x();
      let saveY = node.y();

      // グループ所属ノードは、グループ原点からの「相対座標」に変換して保存
      if (parentId) {
        const parentPos = groupPosMap.get(parentId);
        if (parentPos) {
          saveX = saveX - parentPos.x;
          saveY = saveY - parentPos.y;
        }
      }

      nodes.push({
        id: node.id(),
        type: "file",
        file: `files/${fileName}`,
        x: saveX, // 相対座標または絶対座標
        y: saveY,
        width: bg.width(),
        height: bg.height(),
        title: title,
        parentId: parentId,
        isTemplateItem: node.getAttr("isTemplateItem") || false,
        placeholder: placeholder,
      });

      const fileContent = content || null;
      if (filesFolder) {
        filesFolder.file(fileName, fileContent);
      }
    });

    // 3. リンク情報の抽出 (変更なし)
    const edges: MrsdEdge[] = [];
    stage.find<Konva.Group>(".link-group").forEach((link) => {
      const label = link.findOne(".link-label") as Konva.Text;
      edges.push({
        id: link.id(),
        fromNode: link.getAttr("fromNodeId"),
        toNode: link.getAttr("toNodeId"),
        label: label ? label.text() : "",
        type: link.getAttr("linkType"),
      });
    });

    // 4. JSON構築
    const now = new Date().toISOString();
    const canvasData: MrsdJson = {
      nodes: nodes,
      edges: edges,
      groups: groups,
      metadata: {
        createdAt: projectMetadata?.createdAt || now,
        updatedAt: now,
      },
    };

    zip.file("canvas.json", JSON.stringify(canvasData, null, 2));

    const content = await zip.generateAsync({ type: "uint8array" });
    await invoke("force_save_file", {
      path: savePath,
      content: Array.from(content),
    });

    currentFilePath = savePath;
    isDirty = false;
    projectMetadata = canvasData.metadata;

    _updateTitle(); // ファイル名表示更新

    // 次回起動時のためにパスをストアに保存
    if (store) {
      await store.set("lastIdeaFilePath", savePath);
      await store.save();
    }

    console.log("Saved successfully to:", savePath);
  } catch (e) {
    console.error("Save failed:", e);
    alert(t("ideaProcessor.alert.saveFailed") + "\n" + translateRustError(e));
  }
}

async function saveByBtn() {
  await saveToMrsd(true);
}

// --- ロード処理 (loadFromMrsd) ---
async function loadFromMrsd(targetPath?: string) {
  // 手動ロードで、未保存の変更がある場合のみ確認
  if (!targetPath && isDirty) {
    const yes = await ask(
      t("ideaProcessor.dialog.unsavedChanges.loadMessage"),
      {
        title: t("ideaProcessor.dialog.unsavedChanges.loadTitle"),
        kind: "warning",
      },
    );
    if (!yes) return;
  }

  let path = targetPath;

  // パスが指定されていない（ボタンから呼ばれた）場合はダイアログを開く
  if (!path) {
    const selected = await open({
      multiple: false,
      filters: [{ name: "MirrorShard Data", extensions: ["mrsd"] }],
    });
    if (!selected) return;
    path = selected as string;
  }

  try {
    // Macの forbidden path エラー回避のため、assetプロトコル経由で取得
    const assetUrl = convertFileSrc(path);
    const response = await fetch(assetUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }

    // バイナリデータとしてArrayBufferを取得し、JSZip用にUint8Arrayに変換
    const arrayBuffer = await response.arrayBuffer();
    const binaryData = new Uint8Array(arrayBuffer);

    // JSZipで展開
    const zip = await JSZip.loadAsync(binaryData);

    const canvasFile = zip.file("canvas.json");
    if (!canvasFile) throw new Error("Invalid format: canvas.json not found");
    const jsonStr = await canvasFile.async("string");
    const data: MrsdJson = JSON.parse(jsonStr);

    // 1. ステージ初期化
    if (transformer) transformer.destroy();
    layer.destroyChildren();
    setupSelectionTools();
    selectedNodes = [];
    selectedShape = null;

    projectMetadata = data.metadata || { createdAt: new Date().toISOString() };

    // 2. グループ復元 & 座標マップ作成
    const groupIdMap = new Map<string, string[]>(); // GroupID -> ChildIDs
    const groupPosMap = new Map<string, { x: number; y: number }>(); // GroupID -> {x, y}

    if (data.groups) {
      data.groups.forEach((g) => {
        const groupNode = createGroupNode(g.x, g.y, g.label);
        groupNode.id(g.id);
        groupNode.setAttr("isTemplateRoot", g.isTemplateRoot || false);
        groupNode.setAttr("archetype", g.archetype || "");

        // サイズ復元
        const bg = groupNode.findOne(".group-bg") as Konva.Rect;
        const handle = groupNode.findOne(".resize-handle") as Konva.Circle;
        if (bg && handle) {
          bg.width(g.width);
          bg.height(g.height);
          handle.x(g.width);
          handle.y(g.height);
        }
        groupIdMap.set(g.id, []);
        // 親の座標を記録しておく
        groupPosMap.set(g.id, { x: g.x, y: g.y });
      });
    }

    // 3. ノード復元 (絶対座標計算)
    for (const n of data.nodes) {
      const title = n.title || "New Node";
      let content = ""; // 本文

      // .mdファイルから本文を読み込む
      if (n.file) {
        const mdFile = zip.file(n.file);
        if (mdFile) {
          content = await mdFile.async("string");
        }
      }
      // もし .md がなくて JSON に contentText があればそれを使う (後方互換)
      if (!content && (n as any).contentText) {
        content = (n as any).contentText;
      }

      // 座標の計算
      let finalX = n.x;
      let finalY = n.y;

      // 親グループが存在する場合、親の座標を足して「絶対座標」に戻す
      if (n.parentId && groupPosMap.has(n.parentId)) {
        const parentPos = groupPosMap.get(n.parentId)!;
        finalX += parentPos.x;
        finalY += parentPos.y;
      }

      const nodeGroup = createNewNode(finalX, finalY, title, content, false);

      nodeGroup.id(n.id);
      // 読み込んだデータをノードの属性として再セットする
      nodeGroup.setAttr("isTemplateItem", n.isTemplateItem || false);
      nodeGroup.setAttr("placeholder", n.placeholder || "");
      nodeGroup.setAttr("parentId", n.parentId || null);
      // サイズ自動調整
      adjustNodeSize(nodeGroup);

      // 所属マップへの登録
      if (n.parentId && groupIdMap.has(n.parentId)) {
        groupIdMap.get(n.parentId)?.push(n.id);
      }
    }

    // 4. グループ所属情報の適用 (childNodeIds)
    groupIdMap.forEach((childIds, groupId) => {
      const groupNode = layer.findOne("#" + groupId) as Konva.Group;
      if (groupNode) {
        groupNode.setAttr("childNodeIds", childIds);
      }
    });

    // 5. リンク復元
    if (data.edges) {
      data.edges.forEach((e) => {
        const fromNode = layer.findOne("#" + e.fromNode) as Konva.Group;
        const toNode = layer.findOne("#" + e.toNode) as Konva.Group;

        let linkType = LinkType.ARROW;
        if (e.type === "double_arrow") linkType = LinkType.DOUBLE_ARROW;
        else if (e.type === "line") linkType = LinkType.LINE;

        if (fromNode && toNode) {
          const linkGroup = createSingleLink(fromNode, toNode, linkType);
          if (linkGroup) {
            linkGroup.id(e.id);
            if (e.label) {
              const labelText = linkGroup.findOne(".link-label") as Konva.Text;
              if (labelText) labelText.text(e.label);
            }
          }
        }
      });
    }

    // 6. 仕上げ: リンク端点計算 & 空ラベル非表示
    stage.find(".link-group").forEach((linkGroup: any) => {
      updateLinkPoints(linkGroup);
    });

    await updateAllNodesAppearance();
    renderIpOutline();
    layer.batchDraw();
    currentFilePath = path;
    isDirty = false;
    history = [];
    recordHistory("Loaded .mrsd");
    _updateTitle();
    if (store) {
      await store.set("lastIdeaFilePath", path);
      await store.save();
    }
    console.log(`Loaded from: ${path}`);
  } catch (e) {
    console.error("Load failed:", e);
    alert(t("ideaProcessor.alert.loadFailed") + e);
  }
}

async function newFile() {
  if (isDirty) {
    const yes = await ask(t("ideaProcessor.dialog.unsavedChanges.newMessage"), {
      title: t("ideaProcessor.dialog.unsavedChanges.newTitle"),
      kind: "warning",
    });
    if (!yes) return;
  }

  // 全クリア
  layer.destroyChildren();
  setupSelectionTools();
  selectedNodes = [];
  selectedShape = null;

  // ステージ位置とズームをリセット
  stage.position({ x: 0, y: 0 });
  stage.scale({ x: 1, y: 1 });

  layer.batchDraw();

  currentFilePath = null;
  isDirty = false;
  history = [];
  recordHistory("Initial Empty State");
  isDirty = false;
  _updateTitle(); // Untitledに戻す
  renderIpOutline();

  // ストアのパスもクリアしておく
  if (store) {
    await store.set("lastIdeaFilePath", null);
    await store.save();
  }
  console.log("New file created");
}

async function zoomReset() {
  stage.scale({ x: 1, y: 1 });
  layer.batchDraw();
}

async function InitializeStage() {
  stage.x(0);
  stage.y(0);
  stage.scale({ x: 1, y: 1 });
  layer.batchDraw();
}

function toggleOutlinePane() {
  const pane = document.getElementById("ip-outline-pane");
  if (pane) {
    pane.classList.toggle("hidden");
    if (!pane.classList.contains("hidden")) {
      renderIpOutline();
    }
  }
}

// --- オートセーブ (2秒後に実行) ---
const autoSaveChanges = debounce(async () => {
  // ファイルパスがあり、かつ変更がある場合のみ保存
  if (currentFilePath && isDirty) {
    console.log("[AutoSave] Saving changes...");

    // 上書き保存 (false = ダイアログを出さない)
    await saveToMrsd(false);
  }
}, 2000);

// --- 変更通知とオートセーブトリガー ---
function markAsDirty() {
  if (!isDirty) {
    isDirty = true;
    // タイトルに * をつけるなどの処理が必要ならここ
  }
  // 変更があるたびにタイマーをリセットして予約
  autoSaveChanges();
}

// --- デバウンス関数 (連打防止) ---
function debounce(func: Function, wait: number) {
  let timeout: any;

  // 第一引数に `this: any` を指定することでTSがthisの型を正しく認識するので@ts-ignoreは不要
  return function (this: any, ...args: any[]) {
    clearTimeout(timeout);
    // アロー関数内なのでそのままthisを渡せば正常に機能する
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// --- タイトル（ファイル名）更新 ---
function _updateTitle() {
  const el = document.getElementById("ip-filename-display");
  if (el) {
    // パス区切り文字 (Win: \, Mac/Linux: /) で分割してファイル名を取得
    const fileName = currentFilePath
      ? currentFilePath.split(/[\\/]/).pop()
      : "Untitled";
    el.textContent = fileName || "Untitled";
  }
}

// --- 範囲選択ツールの初期化とイベント登録 ---
function setupSelectionTools() {
  if (transformer) transformer.destroy();
  if (selectionRect) selectionRect.destroy();

  transformer = new Konva.Transformer({
    visible: false,
    resizeEnabled: false,
    rotateEnabled: false,
    borderEnabled: false, // 枠線は selectionRect に任せるので隠す
    anchorSize: 0,
  });
  layer.add(transformer);

  selectionRect = new Konva.Rect({
    name: "selection-rect",
    fill: "rgba(0, 123, 255, 0.1)",
    stroke: "#007bff",
    strokeWidth: 1,
    visible: false,
    draggable: true,
  });
  layer.add(selectionRect);

  selectionRect.on("dragstart", (_e) => {
    if (!transformer.visible() || isTextEditing) {
      selectionRect.stopDrag();
      return;
    }
    lastRectPos = selectionRect.position();
    // 複数移動開始時に履歴記録を一時停止
    isHistoryEnabled = false;
  });

  selectionRect.on("dragmove", () => {
    // デバッグログ: ここでselectedNodesが空だと、中身が置いていかれる
    if (selectedNodes.length === 0) {
      console.warn("[Selection] No nodes paired during drag!");
      return;
    }

    const pos = selectionRect.position();
    const dx = pos.x - lastRectPos.x;
    const dy = pos.y - lastRectPos.y;

    // 中身を動かす
    selectedNodes.forEach((node) => {
      node.move({ x: dx, y: dy });
    });

    lastRectPos = pos;
    transformer.forceUpdate();

    // リンク更新 (Setで重複排除)
    const linksToUpdate = new Set<Konva.Group>();
    const nodeSet = new Set(selectedNodes);
    stage.find(".link-group").forEach((lg: any) => {
      const ns = lg.getAttr("nodes");
      if (ns && (nodeSet.has(ns[0]) || nodeSet.has(ns[1]))) {
        linksToUpdate.add(lg);
      }
    });
    linksToUpdate.forEach((link) => updateLinkPoints(link));

    layer.batchDraw();
  });

  selectionRect.on("dragend", () => {
    // ★重要: 移動が終わってから一度だけ記録
    isHistoryEnabled = true;
    recordHistory("Moved multiple nodes");
  });
}

// --- 現在のフォントファミリーを取得するヘルパー ---
function getKonvaFontFamily() {
  // まずインラインスタイルから探す
  let font =
    document.documentElement.style.getPropertyValue("--user-font-family");

  // なければ計算済みスタイルから探す（CSSファイルで定義されている場合）
  if (!font) {
    font = getComputedStyle(document.documentElement).getPropertyValue(
      "--user-font-family",
    );
  }

  // 余計なクォーテーションや空白を除去
  font = font.trim().replace(/"/g, "").replace(/'/g, "");

  // 見つからなければデフォルトを返す
  return font || "serif-ja, serif";
}

// =================================================================
//  アウトライン関係
// =================================================================

// --- アウトライン描画 ---
function renderIpOutline() {
  if (!outlinePaneContent) return;
  outlinePaneContent.innerHTML = ""; // クリア

  // 1. グループ（旧: background-shape -> 新: container-group）の収集
  const groups = stage.find<Konva.Group>(".container-group").sort((a, b) => {
    const textA = a.findOne<Konva.Text>(".group-title")?.text() || "";
    const textB = b.findOne<Konva.Text>(".group-title")?.text() || "";
    return textA.localeCompare(textB, "ja");
  });

  // 2. ノードの収集
  const nodes = stage.find<Konva.Group>(".node-group").sort((a, b) => {
    const textA = a.findOne<Konva.Text>(".text")?.text() || "";
    const textB = b.findOne<Konva.Text>(".text")?.text() || "";
    return textA.localeCompare(textB, "ja");
  });

  // 3. 親子関係の解決 (childNodeIds を使う方式に合わせる)
  // ノードID -> グループID のマップを作成
  const nodeParentMap = new Map<string, string>();
  groups.forEach((g) => {
    const childIds = g.getAttr("childNodeIds") || [];
    childIds.forEach((cid: string) => nodeParentMap.set(cid, g.id()));
  });

  const orphanNodes = nodes.filter((n) => !nodeParentMap.has(n.id()));

  // --- A. グループごとの描画 ---
  groups.forEach((group) => {
    const groupId = group.id();
    const isCollapsed = outlineCollapsedState.get(groupId) ?? false;

    const groupWrapper = document.createElement("div");

    // ヘッダー作成
    const groupHeader = document.createElement("div");
    groupHeader.className = "outline-group-header";

    const toggle = document.createElement("span");
    toggle.className = "outline-toggle";
    if (isCollapsed) toggle.classList.add("collapsed");
    toggle.textContent = "▼";
    toggle.dataset.groupId = groupId;

    const groupLabel = document.createElement("span");
    groupLabel.className = "outline-group-label";
    groupLabel.textContent =
      group.findOne<Konva.Text>(".group-title")?.text() || "Group";

    groupHeader.appendChild(toggle);
    groupHeader.appendChild(groupLabel);
    groupWrapper.appendChild(groupHeader);

    // 子ノードリスト作成
    const nodeList = document.createElement("ul");
    nodeList.className = "outline-node-list";
    if (isCollapsed) nodeList.style.display = "none";

    // 所属ノードをフィルタリングして追加
    // childIdsの順序、または名前順で表示（ここでは名前順のnodes配列からフィルタ）
    nodes
      .filter((n) => nodeParentMap.get(n.id()) === groupId)
      .forEach((node) => {
        renderNodeWithSubheadings(node, nodeList);
      });

    groupWrapper.appendChild(nodeList);
    outlinePaneContent.appendChild(groupWrapper);
  });

  // --- B. 所属なし（Others） ---
  if (orphanNodes.length > 0) {
    const groupId = "others-group";
    const isCollapsed = outlineCollapsedState.get(groupId) ?? false;

    const groupWrapper = document.createElement("div");
    const groupHeader = document.createElement("div");
    groupHeader.className = "outline-group-header";

    const toggle = document.createElement("span");
    toggle.className = "outline-toggle";
    if (isCollapsed) toggle.classList.add("collapsed");
    toggle.textContent = "▼";
    toggle.dataset.groupId = groupId;

    const groupLabel = document.createElement("span");
    groupLabel.className = "outline-group-label";
    groupLabel.textContent = "Others";

    groupHeader.appendChild(toggle);
    groupHeader.appendChild(groupLabel);
    groupWrapper.appendChild(groupHeader);

    const nodeList = document.createElement("ul");
    nodeList.className = "outline-node-list";
    if (isCollapsed) nodeList.style.display = "none";

    orphanNodes.forEach((node) => {
      renderNodeWithSubheadings(node, nodeList);
    });

    groupWrapper.appendChild(nodeList);
    outlinePaneContent.appendChild(groupWrapper);
  }
}

// --- ノードとサブ見出しの描画 ---
function renderNodeWithSubheadings(
  node: Konva.Group,
  containerElement: HTMLElement,
) {
  const parentLi = document.createElement("li");

  // --- Markdown解析 ---
  const content = (node.getAttr("contentText") as string) || "";
  const subHeadings: { level: number; text: string; original: string }[] = [];

  if (content) {
    const lines = content.split("\n");
    lines.forEach((line: string) => {
      const match = line.match(/^(#{3,6})\s+(.*)/);
      if (match) {
        subHeadings.push({
          level: match[1].length,
          text: match[2],
          original: line,
        });
      }
    });
  }

  // 開閉状態（デフォルトは false = 開く）
  const isCollapsed = nodeCollapsedState.get(node.id()) ?? false;

  // --- ノード行（ヘッダー）の作成 ---
  const nodeHeader = document.createElement("div");
  nodeHeader.className = "outline-node-header";
  nodeHeader.style.display = "flex";
  nodeHeader.style.alignItems = "center";
  // 行全体の高さを少し確保してクリックしやすく
  nodeHeader.style.lineHeight = "1.5";

  // トグルボタンまたはスペーサー
  const toggleWidth = "20px"; // グループのトグル幅に合わせる

  if (subHeadings.length > 0) {
    const toggle = document.createElement("span");
    toggle.className = "outline-toggle node-toggle";
    if (isCollapsed) toggle.classList.add("collapsed");

    toggle.textContent = "▼";
    toggle.dataset.nodeId = node.id();

    // ★スタイル調整
    toggle.style.display = "inline-block";
    toggle.style.width = toggleWidth;
    toggle.style.textAlign = "center";
    toggle.style.cursor = "pointer";
    toggle.style.fontSize = "12px"; // グループと同じくらいに
    toggle.style.userSelect = "none";
    // 色を少し薄くしても良い
    toggle.style.color = "var(--ui-text-color, #666)";

    nodeHeader.appendChild(toggle);
  } else {
    // インデント合わせ
    const spacer = document.createElement("span");
    spacer.style.display = "inline-block";
    spacer.style.width = toggleWidth;
    nodeHeader.appendChild(spacer);
  }

  // ノードタイトル
  const title = node.findOne<Konva.Text>(".text")?.text() || "...";
  const nodeEl = document.createElement("div");
  nodeEl.className = "outline-node";
  nodeEl.textContent = title;
  nodeEl.dataset.id = node.id();
  nodeEl.style.cursor = "pointer";
  nodeEl.style.flex = "1"; // 残りの幅を使う
  // 余計なマージンを消して詰める
  nodeEl.style.padding = "2px 0";

  nodeHeader.appendChild(nodeEl);
  parentLi.appendChild(nodeHeader);

  // --- サブ見出しリスト ---
  if (subHeadings.length > 0) {
    const subList = document.createElement("ul");
    subList.className = "outline-sub-node-list";
    // インデントの微調整 (トグルの幅分だけ下げるなど)
    subList.style.paddingLeft = "20px";
    subList.style.marginTop = "0";
    subList.style.marginBottom = "0";

    if (isCollapsed) {
      subList.style.display = "none";
    } else {
      subList.style.display = "block";
    }

    subHeadings.forEach((h) => {
      const subLi = document.createElement("li");
      subLi.className = "outline-sub-node";
      subLi.textContent = h.text;
      subLi.dataset.parentId = node.id();
      subLi.dataset.headingText = h.original;

      // 階層インデント
      const baseIndent = 5;
      subLi.style.paddingLeft = `${(h.level - 3) * 10 + baseIndent}px`;
      subLi.style.cursor = "pointer";
      subLi.style.color = "var(--ui-text-color, #666)";
      subLi.style.opacity = "0.9";
      subLi.style.fontSize = "0.9em";
      subLi.style.lineHeight = "1.4";

      subList.appendChild(subLi);
    });

    parentLi.appendChild(subList);
  }

  containerElement.appendChild(parentLi);
}

function jumpToNode(nodeId: string, targetHeading?: string) {
  const node = layer.findOne("#" + nodeId) as Konva.Group;
  if (!node) return;

  // アクティブ表示の更新
  document
    .querySelectorAll(".outline-node")
    .forEach((el) => el.parentElement?.classList.remove("is-active"));
  const targetEl = document.querySelector(`.outline-node[data-id="${nodeId}"]`);
  targetEl?.parentElement?.classList.add("is-active");

  // --- ステージ移動 (アニメーション) ---
  const container = document.getElementById("ip-container")!;
  const containerRect = container.getBoundingClientRect();
  const targetX = containerRect.width / 2;
  const targetY = containerRect.height / 2;

  const nodeRect = node.getClientRect();
  // 現在のスケールを考慮して、ノード中心を計算
  const nodeCenterX = nodeRect.x + nodeRect.width / 2;
  const nodeCenterY = nodeRect.y + nodeRect.height / 2;

  // ステージをどれだけ動かせばよいか（現在のステージ位置からの差分ではなく、絶対位置計算）
  // stage.x() + (画面中心 - ノード中心)
  const newX = stage.x() + (targetX - nodeCenterX);
  const newY = stage.y() + (targetY - nodeCenterY);

  new Konva.Tween({
    node: stage,
    duration: 0.3,
    x: newX,
    y: newY,
    easing: Konva.Easings.EaseInOut,
  }).play();

  // --- エディタ内ジャンプ ---
  if (targetHeading) {
    openContentEditor(node);

    // エディタが表示され、値がセットされるのを待つ
    setTimeout(() => {
      if (contentEditor) {
        const text = contentEditor.value;
        const index = text.indexOf(targetHeading);
        if (index !== -1) {
          contentEditor.focus();
          contentEditor.setSelectionRange(index, index + targetHeading.length);
          // スクロール (簡易的)
          const lineHeight = 20; // 概算
          const lines = text.substring(0, index).split("\n").length;
          contentEditor.scrollTop = lines * lineHeight - 50;
        }
      }
    }, 100);
  } else {
    // ノード自体のジャンプ時は選択状態にする
    selectShape(node);
  }
}

function setAllIpOutlineCollapsed(isCollapsed: boolean) {
  // 1. グループの状態設定
  stage.find<Konva.Group>(".container-group").forEach((group) => {
    outlineCollapsedState.set(group.id(), isCollapsed);
  });
  outlineCollapsedState.set("others-group", isCollapsed);

  // 2. ノードの状態設定
  stage.find<Konva.Group>(".node-group").forEach((node) => {
    // サブ見出しがあるかチェックして、あれば状態セット（全ノードセットしても実害はない）
    nodeCollapsedState.set(node.id(), isCollapsed);
  });

  renderIpOutline();
}

// =================================================================
//  エクスポート関係
// =================================================================

/**
 * 現在のキャンバスの状態をMarkdown文字列に変換する
 */
function generateMarkdownContent(): string {
  const groups = stage.find<Konva.Group>(".container-group");
  const nodes = stage.find<Konva.Group>(".node-group");

  let markdown = "";

  // 1. 親子関係のマップを作成 (NodeID -> GroupID)
  const nodeParentMap = new Map<string, string>();
  groups.forEach((group) => {
    const childIds = group.getAttr("childNodeIds") || [];
    childIds.forEach((cid: string) => nodeParentMap.set(cid, group.id()));
  });

  // 親がいないノードを抽出
  const orphanNodes = nodes.filter((n) => !nodeParentMap.has(n.id()));

  // 2. 各グループを処理
  groups.forEach((group) => {
    const groupLabel =
      group.findOne<Konva.Text>(".group-title")?.text() || "Untitled Group";
    markdown += `# ${groupLabel}\n\n`;

    // このグループに所属する子ノードを探して処理
    const childNodes = nodes.filter(
      (n) => nodeParentMap.get(n.id()) === group.id(),
    );

    childNodes.forEach((node) => {
      markdown += convertNodeToMarkdown(node);
    });
  });

  // 3. 親がいないノードを "# Others" として処理
  if (orphanNodes.length > 0) {
    markdown += `# Others\n\n`;
    orphanNodes.forEach((node) => {
      markdown += convertNodeToMarkdown(node);
    });
  }

  return markdown;
}

/**
 * 1つのノードをMarkdownのセクションに変換するヘルパー関数
 */
function convertNodeToMarkdown(node: Konva.Group): string {
  let section = "";
  const title = node.findOne<Konva.Text>(".text")?.text() || "Untitled";
  const content = node.getAttr("contentText") || "";

  section += `## ${title}\n`;
  if (content.trim()) {
    section += `${content}\n`;
  }

  // --- リンク情報の処理 (現行アーキテクチャ対応) ---
  // ステージ上の全リンクから、自身が関わっているものを抽出
  const relatedLinks = stage
    .find<Konva.Group>(".link-group")
    .filter((linkGroup) => {
      const linkNodes = linkGroup.getAttr("nodes");
      return linkNodes && (linkNodes[0] === node || linkNodes[1] === node);
    });

  if (relatedLinks.length > 0) {
    section += "\n"; // リンク情報との間に空行を入れる

    relatedLinks.forEach((linkGroup) => {
      const linkNodes = linkGroup.getAttr("nodes") as Konva.Group[];
      const linkLabel =
        linkGroup.findOne<Konva.Text>(".link-label")?.text().trim() || "";

      // 送信元か送信先かを判定 (nodes[0]が起点)
      const isOutgoing = linkNodes[0] === node;
      const otherNode = isOutgoing ? linkNodes[1] : linkNodes[0];
      const otherNodeTitle =
        otherNode.findOne<Konva.Text>(".text")?.text() || "...";

      let linkTypeSymbol = "";
      const type = linkGroup.getAttr("linkType");
      if (type === "double_arrow") {
        linkTypeSymbol = "interaction";
      } else if (type === "arrow") {
        linkTypeSymbol = isOutgoing ? "to" : "from";
      } else {
        linkTypeSymbol = "relation";
      }

      section += `【${linkTypeSymbol} ${otherNodeTitle}】`;
      if (linkLabel) {
        section += `:${linkLabel}`;
      }
      section += "\n";
    });
  }

  return section + "\n";
}

// --- 1. Markdownファイルとして保存 ---
async function exportAsMarkdown() {
  const content = generateMarkdownContent(); // 既存の関数を呼び出し

  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.mrsd$/, ".md")
    : "Untitled.md";
  const savePath = await save({
    title: "Export as Markdown",
    defaultPath: defaultName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (savePath) {
    try {
      await writeTextFile(savePath, content);
      console.log("Exported to Markdown:", savePath);
      // 必要ならTauriのshellプラグインでフォルダを開く処理を追加
    } catch (e) {
      console.error(e);
      alert(t("ideaProcessor.alert.markdownExportFailed"));
    }
  }
}

// --- 2. メインエディタに送信 ---
async function sendToEditor() {
  const markdownContent = generateMarkdownContent();
  try {
    // パスではなく、テキスト自体を送信する
    await emit("send-content-to-editor", { content: markdownContent });
    console.log("Sent content to editor.");
  } catch (e) {
    console.error(e);
    alert(t("ideaProcessor.alert.editorSendFailed"));
  }
}

// --- 3. PNG画像として保存 ---
async function exportAsPng() {
  // 選択状態の解除
  if (selectedShape) deselectAll();

  // 書き出し範囲の計算 (Electron版のロジックを流用)
  const allShapes = [
    ...stage.find(".node-group"),
    ...stage.find(".container-group"),
  ];
  if (allShapes.length === 0) {
    alert(t("ideaProcessor.alert.noContentToExport"));
    return;
  }

  let box = allShapes[0].getClientRect({ relativeTo: layer });
  allShapes.forEach((shape) => {
    const nodeRect = shape.getClientRect({ relativeTo: layer });
    const right = Math.max(box.x + box.width, nodeRect.x + nodeRect.width);
    const bottom = Math.max(box.y + box.height, nodeRect.y + nodeRect.height);
    box.x = Math.min(box.x, nodeRect.x);
    box.y = Math.min(box.y, nodeRect.y);
    box.width = right - box.x;
    box.height = bottom - box.y;
  });

  const padding = 20;
  const exportArea = {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };

  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.mrsd$/, ".png")
    : "canvas.png";
  const savePath = await save({
    title: "Export as PNG",
    defaultPath: defaultName,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });

  if (!savePath) return;

  stage.toDataURL({
    ...exportArea,
    pixelRatio: 2,
    mimeType: "image/png",
    callback: async (dataUrl) => {
      try {
        // 背景色の合成 (Electron版と同じく、オフスクリーンキャンバスを使用)
        const offscreenCanvas = document.createElement("canvas");
        const ctx = offscreenCanvas.getContext("2d")!;
        offscreenCanvas.width = exportArea.width * 2;
        offscreenCanvas.height = exportArea.height * 2;

        const isDark = document.body.classList.contains("dark-mode");
        ctx.fillStyle = isDark ? "#333333" : "antiquewhite";
        ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

        const img = new Image();
        img.onload = async () => {
          ctx.drawImage(img, 0, 0);
          const finalDataUrl = offscreenCanvas.toDataURL("image/png");

          // Base64からバイナリ(Uint8Array)へ変換
          const base64Data = finalDataUrl.split(",")[1];
          const binaryString = window.atob(base64Data);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // TauriのAPIで書き込み
          await writeFile(savePath, bytes);
          console.log("Exported to PNG:", savePath);
        };
        img.src = dataUrl;
      } catch (e) {
        console.error(e);
        alert(t("ideaProcessor.alert.imageExportFailed"));
      }
    },
  });
}

// --- 4. HTMLとして保存 ---
async function exportAsHtml() {
  // 1. 選択状態の解除
  if (selectedShape) deselectAll();

  // 2. 書き出し範囲の計算
  const allShapes = [
    ...stage.find(".node-group"),
    ...stage.find(".container-group"),
  ];
  if (allShapes.length === 0) {
    alert(t("ideaProcessor.alert.noContentToExport"));
    return;
  }

  let box = allShapes[0].getClientRect({ relativeTo: layer });
  allShapes.forEach((shape) => {
    const nodeRect = shape.getClientRect({ relativeTo: layer });
    const right = Math.max(box.x + box.width, nodeRect.x + nodeRect.width);
    const bottom = Math.max(box.y + box.height, nodeRect.y + nodeRect.height);
    box.x = Math.min(box.x, nodeRect.x);
    box.y = Math.min(box.y, nodeRect.y);
    box.width = right - box.x;
    box.height = bottom - box.y;
  });

  const padding = 20;
  const exportArea = {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };

  // 3. 保存ダイアログ
  const defaultName = currentFilePath
    ? currentFilePath.replace(/\.mrsd$/, ".html")
    : "canvas.html";
  const savePath = await save({
    title: "Export as HTML",
    defaultPath: defaultName,
    filters: [{ name: "HTML Document", extensions: ["html"] }],
  });

  if (!savePath) return;

  // 4. 画像生成とHTML構築
  stage.toDataURL({
    ...exportArea,
    pixelRatio: 2,
    mimeType: "image/png",
    callback: async (dataUrl) => {
      try {
        // 背景色の合成
        const offscreenCanvas = document.createElement("canvas");
        const ctx = offscreenCanvas.getContext("2d")!;
        offscreenCanvas.width = exportArea.width * 2;
        offscreenCanvas.height = exportArea.height * 2;

        const isDark = document.body.classList.contains("dark-mode");
        const bgColor = isDark ? "#333333" : "antiquewhite"; // テーマ連動
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

        const img = new Image();
        img.onload = async () => {
          ctx.drawImage(img, 0, 0);
          const finalDataUrl = offscreenCanvas.toDataURL("image/png");

          const htmlContent = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Exported Canvas</title>
  <style>
    body { margin: 0; background-color: ${bgColor}; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    img { max-width: 100%; height: auto; display: block; box-shadow: 0 4px 8px rgba(0,0,0,0.1); border-radius: 8px; }
  </style>
</head>
<body>
  <img src="${finalDataUrl}" alt="Canvas Image">
</body>
</html>`;

          await writeTextFile(savePath, htmlContent);
          console.log("Exported to HTML:", savePath);
        };
        img.src = dataUrl;
      } catch (e) {
        console.error(e);
        alert(t("ideaProcessor.alert.htmlExportFailed"));
      }
    },
  });
}

// --- 5. PDFとして印刷 (ブラウザ標準機能) ---
function exportAsPdf() {
  if (selectedShape) deselectAll();

  const allShapes = [
    ...stage.find(".node-group"),
    ...stage.find(".container-group"),
  ];
  if (allShapes.length === 0) {
    alert(t("ideaProcessor.alert.noContentToExport"));
    return;
  }

  let box = allShapes[0].getClientRect({ relativeTo: layer });
  allShapes.forEach((shape) => {
    const nodeRect = shape.getClientRect({ relativeTo: layer });
    const right = Math.max(box.x + box.width, nodeRect.x + nodeRect.width);
    const bottom = Math.max(box.y + box.height, nodeRect.y + nodeRect.height);
    box.x = Math.min(box.x, nodeRect.x);
    box.y = Math.min(box.y, nodeRect.y);
    box.width = right - box.x;
    box.height = bottom - box.y;
  });

  const padding = 20;
  const exportArea = {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };

  stage.toDataURL({
    ...exportArea,
    pixelRatio: 2,
    mimeType: "image/png",
    callback: (dataUrl) => {
      const offscreenCanvas = document.createElement("canvas");
      const ctx = offscreenCanvas.getContext("2d")!;
      offscreenCanvas.width = exportArea.width * 2;
      offscreenCanvas.height = exportArea.height * 2;

      const isDark = document.body.classList.contains("dark-mode");
      const bgColor = isDark ? "#333333" : "antiquewhite";
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        const finalDataUrl = offscreenCanvas.toDataURL("image/png");

        // iframeを使って印刷ダイアログを呼び出す
        const iframe = document.createElement("iframe");
        iframe.style.display = "none"; // 画面には見せない
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(`
                      <html><head><style>
                          @page { margin: 0; size: landscape; }
                          body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background-color: ${bgColor}; }
                          img { max-width: 100%; max-height: 100%; object-fit: contain; }
                      </style></head><body>
                          <img src="${finalDataUrl}" onload="window.print();">
                      </body></html>
                  `);
          doc.close();

          // 印刷ダイアログが閉じた後、しばらくしてiframeを掃除する
          setTimeout(() => {
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
          }, 10000);
        }
      };
      img.src = dataUrl;
    },
  });
}

// --- OpenAI互換APIの共通リクエスト関数 ---
async function fetchOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
    signal: aiAbortController?.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API Error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// --- Cohere (v2 API) への直接リクエスト関数 ---
async function fetchCohereV2(
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
): Promise<string> {
  const response = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      // v2 APIはOpenAIと同じ messages 配列が使えます
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
    signal: aiAbortController?.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cohere API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  // ★ Cohere v2 特有のレスポンス解読位置
  return data.message?.content?.[0]?.text || "";
}

// =================================================================
// AI アシスト機能 (AI Free Association)
// =================================================================

async function triggerFreeAssociation() {
  if (isAiThinking) return;

  if (!selectedShape || selectedShape.name() !== "node-group") {
    alert(t("ideaProcessor.ai.selectNodeToExpand"));
    return;
  }

  const selectedNode = selectedShape as Konva.Group;
  const textNode = selectedNode.findOne<Konva.Text>(".text");
  if (!textNode) return;
  const nodeTitle = textNode.text();

  if (!store) return;

  // 設定取得 (名前を faMaxTokens に変更)
  const charLimit = (await store.get<number>("faMaxTokens")) || 30;
  // API自体の出力上限は3つのアイデア＋改行＋トークン比率を考慮して
  // charLimit の 5倍程度を確保
  const apiMaxTokens = charLimit * 5;

  // ストアからユーザー設定のシステムプロンプトを取得
  const userSystemPrompt = (await store?.get<string>("aiSystemPrompt")) || "";
  const baseSystemPrompt = t("prompts.ideaProcessor.expandNode");
  // プロンプトの合成
  const systemPrompt = userSystemPrompt
    ? `${baseSystemPrompt}\n\n${t("prompts.ideaProcessor.userInstructionPrefix")}${userSystemPrompt}`
    : baseSystemPrompt;
  const prompt = t("prompts.ideaProcessor.freeAssociationPrompt", {
    nodeTitle,
    charLimit: String(charLimit),
  });

  // 状態更新とUIガード
  isAiThinking = true;
  aiAbortController = new AbortController();
  aiThinkingMode = "Free Association";
  setAiLoading(true);

  try {
    let resultText = "";

    // セレクターの変数 (ipAiApi) を使用
    if (ipAiApi === "gemini") {
      const apiKey = await store.get<string>("geminiApiKey");
      const model =
        (await store.get<string>("geminiModel")) || "gemini-3.1-flash-lite";
      console.log(`Loaded:${model}`);
      if (!apiKey) throw new Error(t("ideaProcessor.ai.geminiAPIError"));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
          }),
          signal: aiAbortController.signal, // 中断シグナルを渡す
        },
      );
      if (!response.ok)
        throw new Error(`Gemini API Error: ${response.statusText}`);
      const data = await response.json();
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (ipAiApi === "cohere") {
      const apiKey = (await store.get<string>("cohereApiKey")) || "";
      const model =
        (await store.get<string>("cohereModel")) || "command-r-plus-08-2024";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.cohereAPIError"));

      resultText = await fetchCohereV2(
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    } else {
      // Groq, Mistral, Local AI (OpenAI互換グループ)
      let url = "",
        apiKey = "",
        model = "";

      if (ipAiApi === "groq") {
        url = "https://api.groq.com/openai/v1/chat/completions";
        apiKey = (await store.get<string>("groqApiKey")) || "";
        model =
          (await store.get<string>("groqModel")) || "llama-3.3-70b-versatile";
      } else if (ipAiApi === "cerebras") {
        url = "https://api.cerebras.ai/v1/chat/completions";
        apiKey = (await store.get<string>("cerebrasApiKey")) || "";
        model = (await store.get<string>("cerebrasModel")) || "gemma-4-31b";
      } else if (ipAiApi === "openrouter") {
        url = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = (await store.get<string>("openRouterApiKey")) || "";
        model =
          (await store.get<string>("openRouterModel")) ||
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
      } else if (ipAiApi === "mistral") {
        url = "https://api.mistral.ai/v1/chat/completions";
        apiKey = (await store.get<string>("mistralApiKey")) || "";
        model =
          (await store.get<string>("mistralModel")) || "mistral-small-latest";
      } else if (ipAiApi === "local") {
        url =
          (await store.get<string>("localLlmUrl")) ||
          "http://127.0.0.1:1234/v1/chat/completions";
        apiKey = "local"; // ローカルはキー不要なことが多いがダミーとして
        model = (await store.get<string>("localLlmModel")) || "local-model";
      }

      if (ipAiApi !== "local" && !apiKey)
        throw new Error(t("ideaProcessor.alert.noApiKey", { api: ipAiApi }));

      // 互換API共通のフェッチ処理
      resultText = await fetchOpenAICompatible(
        url,
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    }

    if (!resultText) throw new Error(t("ideaProcessor.ai.invalidResponse"));

    // --- 結果のパースとアニメーション生成 ---
    const ideas = resultText
      .split("\n")
      .map((line) => line.replace(/^[-・*1-9.\s]+/, "").trim())
      .filter((idea) => idea !== "");

    if (ideas.length === 0) throw new Error(t("ideaProcessor.ai.parseFailed"));
    const newNodes: Konva.Group[] = [];
    const startPos = selectedNode.position();
    const bgRect = selectedNode.findOne<Konva.Rect>(".background");

    // 元ノードの中心座標を計算
    const centerX = startPos.x + (bgRect ? bgRect.width() / 2 : 60);
    const centerY = startPos.y + (bgRect ? bgRect.height() / 2 : 30);

    // 最大3つに制限
    const finalIdeas = ideas.slice(0, 3);

    finalIdeas.forEach((rawIdeaText, i) => {
      // 放射状に配置するための計算
      const angleOffset = -Math.PI / 2; // 12時方向から開始
      const angle = angleOffset + (i / finalIdeas.length) * Math.PI * 2;
      const distance = 250; // 展開距離
      const endPos = {
        x: centerX + distance * Math.cos(angle) - 60,
        y: centerY + distance * Math.sin(angle) - 30,
      };

      // 元ノードの中心位置に初期ノードを作成（編集モードなし）
      // 先頭50文字をタイトルに設定、残りはContentTextに
      const isTruncated = rawIdeaText.length > 50 || rawIdeaText.includes("\n");
      const sTitle =
        rawIdeaText.split("\n")[0].substring(0, 50) +
        (isTruncated ? "..." : "");
      const fContent = isTruncated ? rawIdeaText : "";

      const newNode = createNewNode(
        centerX - 60,
        centerY - 30,
        sTitle,
        fContent,
        false,
      );
      newNodes.push(newNode);

      // アニメーションの初期状態（小さく、透明に）
      newNode.scale({ x: 0.1, y: 0.1 });
      newNode.opacity(0);

      // アニメーション実行
      new Konva.Tween({
        node: newNode,
        duration: 0.6,
        x: endPos.x,
        y: endPos.y,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        easing: Konva.Easings.EaseOut,
        onFinish: () => {
          // 全てのアニメーションが終わったらリンクを張る
          if (i === finalIdeas.length - 1) {
            newNodes.forEach((node) => {
              createSingleLink(selectedNode, node, LinkType.ARROW);
            });
            recordHistory("AI Free Association executed");
            renderIpOutline();
            layer.batchDraw();
          }
        },
      }).play();
    });
  } catch (e: any) {
    handleAiError(e);
  } finally {
    clearAiProcessingState();
  }
}

// =================================================================
// テンプレート補完 (Template Completion)
// =================================================================
async function triggerTemplateCompletion() {
  if (isAiThinking || !currentlyEditingNodeId || !store) return;

  // 1. ターゲットノードと親グループの検証
  const currentNode = layer.findOne(
    "#" + currentlyEditingNodeId,
  ) as Konva.Group;
  if (!currentNode) return;

  const parentId = currentNode.getAttr("parentId");
  if (!parentId) {
    alert(t("ideaProcessor.ai.missingParentGroup"));
    return;
  }
  const parentGroup = layer.findOne("#" + parentId) as Konva.Group;
  if (!parentGroup) {
    alert(t("ideaProcessor.ai.templateGroupNotFound"));
    return;
  }
  if (!parentGroup.getAttr("isTemplateRoot")) {
    alert(t("ideaProcessor.ai.notTemplateRoot"));
    return;
  }

  // --- 1. アーキタイプ名と基本構造の取得 ---
  const archetype = parentGroup.getAttr("archetype") || "unknown";

  // 行為者モデル（分析用）は補完から除外
  if (archetype === "greimas") {
    alert(t("ideaProcessor.ai.greimasNotSupported"));
    return;
  }
  // 予期せぬエラー防止のため、身分証がない場合もガード
  if (!archetype && !parentGroup.getAttr("isTemplateRoot")) {
    return;
  }

  const hj = "ideaProcessor.template.herosJourney";
  const bs = "ideaProcessor.template.beatSheet";
  const ta = "ideaProcessor.template.threeAct";
  const ARCHETYPE_DEFINITIONS: Record<string, string[]> = {
    "heros-journey": [
      t(hj + ".steps.1"),
      t(hj + ".steps.2"),
      t(hj + ".steps.3"),
      t(hj + ".steps.4"),
      t(hj + ".steps.5"),
      t(hj + ".steps.6"),
      t(hj + ".steps.7"),
      t(hj + ".steps.8"),
      t(hj + ".steps.9"),
      t(hj + ".steps.10"),
      t(hj + ".steps.11"),
      t(hj + ".steps.12"),
    ],
    "beat-sheet": [
      t(bs + ".beats.1"),
      t(bs + ".beats.2"),
      t(bs + ".beats.3"),
      t(bs + ".beats.4"),
      t(bs + ".beats.5"),
      t(bs + ".beats.6"),
      t(bs + ".beats.7"),
      t(bs + ".beats.8"),
      t(bs + ".beats.9"),
      t(bs + ".beats.10"),
      t(bs + ".beats.11"),
      t(bs + ".beats.12"),
    ],
    "three-act-structure": [
      t(ta + ".acts.1"),
      t(ta + ".acts.2"),
      t(ta + ".acts.3"),
    ],
  };

  const archetypeStructureArray = ARCHETYPE_DEFINITIONS[archetype] || [];
  const archetypeStructure = archetypeStructureArray
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");

  // --- 2. ユーザーが書き換えた現在の物語構成（currentStory）の収集 ---
  const childIds = (parentGroup.getAttr("childNodeIds") as string[]) || [];
  let currentStory = "";
  let currentStepNumber = 0;

  childIds.forEach((id, index) => {
    const child = layer.findOne("#" + id) as Konva.Group;
    if (child) {
      const textNode = child.findOne(".text") as Konva.Text;
      const userTitle = textNode ? textNode.text() : "Untitled";

      // 各ノードのタイトルを80文字程度でカットオフ（コンテキスト節約）
      const displayTitle =
        userTitle.length > 80 ? userTitle.substring(0, 80) + "..." : userTitle;
      currentStory += `${index + 1}. ${displayTitle}\n`;

      if (id === currentlyEditingNodeId) {
        currentStepNumber = index + 1;
      }
    }
  });

  // 3. テキストエリアからコンテキスト（直前の文章）を取得
  const textarea = document.getElementById(
    "ip-content-editor",
  ) as HTMLTextAreaElement;
  if (!textarea) return;

  const cursor = textarea.selectionStart;
  const fullText = textarea.value;

  let limit = Number(await store.get<number>("aiContextLimit")) || 2000;
  if (ipAiApi !== "local" && limit > 2000) {
    console.warn(`Cloud AI context limited to 2000`);
    limit = 2000;
  }

  const contextStart = Math.max(0, cursor - limit);
  const contextText = fullText.slice(contextStart, cursor);

  // --- 3. プロンプト構築 ---
  const userSystemPrompt = (await store?.get<string>("aiSystemPrompt")) || "";
  const baseSystemPrompt = t("prompts.ideaProcessor.templateCompletion");
  // プロンプトの合成
  const systemPrompt = userSystemPrompt
    ? `${baseSystemPrompt}\n\n${t("prompts.ideaProcessor.userInstructionPrefix")}${userSystemPrompt}`
    : baseSystemPrompt;

  const prompt = t("prompts.ideaProcessor.templateCompletionPrompt", {
    archetype,
    archetypeStructure,
    currentStory,
    currentStepNumber: String(currentStepNumber),
    contextText,
  });

  // 4. 通信準備とUIロック
  isAiThinking = true;
  aiAbortController = new AbortController();
  aiThinkingMode = "Template Completion";
  setAiLoading(true);

  try {
    let resultText = "";
    // 出力トークンはFreeAssociation用(faMaxTokens)ではなく、通常用(aiMaxTokens)を使う
    const maxTokens = Number(await store.get<number>("aiMaxTokens")) || 1000;

    // --- 5. API通信 (FreeAssociationと同じロジックを流用) ---
    if (ipAiApi === "gemini") {
      const apiKey = await store.get<string>("geminiApiKey");
      const model =
        (await store.get<string>("geminiModel")) || "gemini-1.5-flash";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.geminiAPIError"));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
          }),
          signal: aiAbortController.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Gemini API Error: ${response.statusText}`);
      const data = await response.json();
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (ipAiApi === "cohere") {
      const apiKey = (await store.get<string>("cohereApiKey")) || "";
      const model =
        (await store.get<string>("cohereModel")) || "command-r-plus-08-2024";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.cohereAPIError"));

      resultText = await fetchCohereV2(
        apiKey,
        model,
        prompt,
        systemPrompt,
        maxTokens,
      );
    } else {
      let url = "",
        apiKey = "",
        model = "";

      if (ipAiApi === "groq") {
        url = "https://api.groq.com/openai/v1/chat/completions";
        apiKey = (await store.get<string>("groqApiKey")) || "";
        model =
          (await store.get<string>("groqModel")) || "llama-3.3-70b-versatile";
      } else if (ipAiApi === "cerebras") {
        url = "https://api.cerebras.ai/v1/chat/completions";
        apiKey = (await store.get<string>("cerebrasApiKey")) || "";
        model = (await store.get<string>("cerebrasModel")) || "gemma-4-31b";
      } else if (ipAiApi === "openrouter") {
        url = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = (await store.get<string>("openRouterApiKey")) || "";
        model =
          (await store.get<string>("openRouterModel")) ||
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
      } else if (ipAiApi === "mistral") {
        url = "https://api.mistral.ai/v1/chat/completions";
        apiKey = (await store.get<string>("mistralApiKey")) || "";
        model =
          (await store.get<string>("mistralModel")) || "mistral-small-latest";
      } else if (ipAiApi === "local") {
        url =
          (await store.get<string>("localLlmUrl")) ||
          "http://127.0.0.1:1234/v1/chat/completions";
        apiKey = "local";
        model = (await store.get<string>("localLlmModel")) || "local-model";
      }

      if (ipAiApi !== "local" && !apiKey)
        throw new Error(t("ideaProcessor.alert.noApiKey", { api: ipAiApi }));

      // 互換API共通のフェッチ処理
      resultText = await fetchOpenAICompatible(
        url,
        apiKey,
        model,
        prompt,
        systemPrompt,
        maxTokens,
      );
    }

    if (!resultText) throw new Error(t("ideaProcessor.ai.invalidResponse"));

    // --- 6. 結果をテキストエリアに挿入 ---
    const newText =
      fullText.slice(0, cursor) +
      resultText +
      fullText.slice(textarea.selectionEnd);
    textarea.value = newText;

    // カーソルを挿入した文章の末尾に移動
    const newCursorPos = cursor + resultText.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;

    // スクロールを一番下（またはカーソル位置）へ
    textarea.scrollTop = textarea.scrollHeight;
    textarea.focus();

    // ※ コンテンツの保存（saveContentChanges）は、ユーザーが確認してエディタを閉じる時に自動で行われます。
  } catch (e: any) {
    handleAiError(e);
  } finally {
    clearAiProcessingState();
  }
}

// --- AIセレクターの初期化 ---
async function initAiSelector() {
  const displayBtn = document.getElementById("ip-ai-display");
  const optionsContainer = document.getElementById("ip-ai-options");
  if (!displayBtn || !optionsContainer || !store) return;

  // --- 1. オプションの動的生成 ---
  optionsContainer.innerHTML = ""; // 既存のHTML（もしあれば）をクリア

  // 常に表示
  optionsContainer.innerHTML += `<div class="custom-option" data-value="gemini">Gemini (Cloud)</div>`;

  // チェックボックスに応じて追加
  if (await store.get<boolean>("enableGroq")) {
    optionsContainer.innerHTML += `<div class="custom-option" data-value="groq">Groq</div>`;
  }
  if (await store.get<boolean>("enableCerebras")) {
    optionsContainer.innerHTML += `<div class="custom-option" data-value="cerebras">Cerebras</div>`;
  }
  if (await store.get<boolean>("enableOpenRouter")) {
    optionsContainer.innerHTML += `<div class="custom-option" data-value="openrouter">OpenRouter</div>`;
  }
  if (await store.get<boolean>("enableCohere")) {
    optionsContainer.innerHTML += `<div class="custom-option" data-value="cohere">Cohere</div>`;
  }
  if (await store.get<boolean>("enableMistral")) {
    optionsContainer.innerHTML += `<div class="custom-option" data-value="mistral">Mistral</div>`;
  }

  // 常に表示
  optionsContainer.innerHTML += `<div class="custom-option" data-value="local">Local AI</div>`;

  // --- 2. イベントリスナーの再設定 ---
  const options = document.querySelectorAll("#ip-ai-options .custom-option");

  // 開閉ロジック
  displayBtn.addEventListener("click", (e) => {
    if (isAiThinking) return;
    e.stopPropagation();
    optionsContainer.classList.toggle("open");
  });

  document.addEventListener("click", () => {
    optionsContainer.classList.remove("open");
  });

  // 選択ロジック
  options.forEach((opt) => {
    opt.addEventListener("click", async () => {
      const value = opt.getAttribute("data-value");
      if (value && store) {
        ipAiApi = value; // グローバル変数
        await store.set("ipAiApi", value);
        await store.save();
        displayBtn.textContent = opt.textContent;
        optionsContainer.classList.remove("open");
      }
    });
  });

  // --- 3. 初期値の復元 ---
  const val = (await store.get<string>("ipAiApi")) || "gemini";
  ipAiApi = val;
  const target = Array.from(options).find(
    (o) => o.getAttribute("data-value") === val,
  );
  if (target && target.textContent) {
    displayBtn.textContent = target.textContent;
  } else {
    // 設定されたAPIが無効化された場合のフォールバック
    displayBtn.textContent = "Gemini (Cloud)";
    ipAiApi = "gemini";
  }
}

// --- AI通信の中断 ---
function abortAiProcessing() {
  if (aiAbortController) {
    console.log("Sending abort signal...");
    aiAbortController.abort();
  }
}

// --- オーバーレイ制御 ---
function updateAiThinkingStyle() {
  const root = document.documentElement.style;
  if (showAiThinkingOverlay) {
    root.setProperty("--ai-thinking-bg", "rgba(0, 0, 0, 0.5)");
    root.setProperty("--ai-thinking-blur", "blur(2px)");
  } else {
    root.setProperty("--ai-thinking-bg", "transparent");
    root.setProperty("--ai-thinking-blur", "none");
  }
}

function setAiLoading(isLoading: boolean) {
  const overlayId = "ai-loading-overlay";
  document.querySelectorAll(`#${overlayId}`).forEach((el) => el.remove());

  if (isLoading) {
    updateAiThinkingStyle();
    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.className = "loading-overlay";

    overlay.style.pointerEvents = "all";

    if (showAiThinkingOverlay) {
      overlay.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text">AI is thinking...</div>
        <div class="loading-text">Mode: ${aiThinkingMode}</div>
      `;
    }

    // イベント遮断
    const blockEvent = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "auxclick",
      "wheel",
      "contextmenu",
      "dragstart",
    ].forEach((evt) => {
      overlay.addEventListener(evt, blockEvent, { capture: true }); // captureをtrueにして先に捕まえる
    });

    document.body.appendChild(overlay);

    // Konva側のドラッグも明示的に止める
    stage.stopDrag();
  }
}

function handleAiError(e: any) {
  if (e.name === "AbortError") {
    console.log("AI Task was aborted by user.");
    return;
  }
  console.error(e);
  alert(`AI Error: ${e.message || e}`);
}

function clearAiProcessingState() {
  isAiThinking = false;
  aiAbortController = null;
  setAiLoading(false);

  const aiButton = document.getElementById("ip-ai-btn") as HTMLButtonElement;
  if (aiButton) aiButton.disabled = false;

  stage.container().focus();
  stage.container().style.cursor = "default";
}

// =================================================================
// Node Alchemy (複数アイデアの融合)
// =================================================================
async function triggerNodeAlchemy() {
  if (isAiThinking || selectedNodes.length < 2 || !store) return;

  // 0. ダイアログを表示してユーザーの指示を仰ぐ
  // ストアから前回の入力を取得（デフォルトは一般的な指示に）
  const lastPrompt =
    (await store.get<string>("lastAlchemyPrompt")) ||
    t("ideaProcessor.default.alchemyPrompt");

  const userInstruction = await showStringInput(
    t("ideaProcessor.default.aiPromptInput"),
    lastPrompt,
  );

  // キャンセルされた場合は処理を中断
  if (userInstruction === null) {
    return;
  }

  // 次回のためにストアに保存
  await store.set("lastAlchemyPrompt", userInstruction);
  await store.save();

  // --- 1. 中心座標の計算 (全ノードの平均) ---
  let sumX = 0,
    sumY = 0;
  let combinedContext = "";

  selectedNodes.forEach((node, index) => {
    // 座標取得
    const bg = node.findOne(".background") as Konva.Rect;
    const nx = node.x();
    const ny = node.y();
    const nw = bg ? bg.width() : 150;
    const nh = bg ? bg.height() : 60;

    // 中心点を足していく
    sumX += nx + nw / 2;
    sumY += ny + nh / 2;

    // テキスト収集
    const textNode = node.findOne<Konva.Text>(".text");

    // タイトルが空なら "要素 N" または "Element N" にする
    const fallbackTitle = t("ideaProcessor.ai.fallbackTitle", {
      index: String(index + 1),
    });
    const title = textNode ? textNode.text() : fallbackTitle;

    const content = node.getAttr("contentText") || "";

    // 辞書からフォーマットを呼び出し
    const elementHeader = t("ideaProcessor.ai.elementFormat", {
      index: String(index + 1),
      title: title,
    });

    combinedContext += `${elementHeader}\n${content}\n\n`;
  });

  // 割り算して平均値（最終的な出現座標）を決定
  const centerX = sumX / selectedNodes.length;
  const centerY = sumY / selectedNodes.length;

  // --- 2. コンテキストのカットオフ（制限超過防止） ---
  let limit = Number(await store.get<number>("aiContextLimit")) || 2000;
  if (ipAiApi !== "local" && limit > 4000) {
    console.warn(`Cloud AI context limited to 4000`);
    limit = 4000;
  }

  if (combinedContext.length > limit) {
    // 上限を超えた場合は切り捨てて、AIにそれが分かるように注記を入れる
    combinedContext =
      combinedContext.slice(0, limit) + "\n\n(※文字数制限により以降カット)";
  }

  // --- 3. プロンプト構築と通信 ---
  const userSystemPrompt = (await store?.get<string>("aiSystemPrompt")) || "";
  const baseSystemPrompt = t("prompts.ideaProcessor.nodeAlchemy");
  // プロンプトの合成
  const systemPrompt = userSystemPrompt
    ? `${baseSystemPrompt}\n\n${t("prompts.ideaProcessor.userInstructionPrefix")}${userSystemPrompt}`
    : baseSystemPrompt;

  // ユーザーの入力を直接プロンプトに埋め込む
  const charLimit = (await store.get<number>("faMaxTokens")) || 200;
  const apiMaxTokens = charLimit * 5;
  const prompt = t("prompts.ideaProcessor.nodeAlchemyPrompt", {
    userInstruction,
    charLimit: String(charLimit),
    combinedContext,
  });

  // 通信準備とUIロック
  isAiThinking = true;
  aiAbortController = new AbortController();
  aiThinkingMode = "Node Alchemy";
  setAiLoading(true);

  try {
    let resultText = "";

    // --- 4. API通信 (AFAと全く同じロジックを流用) ---
    if (ipAiApi === "gemini") {
      const apiKey = await store.get<string>("geminiApiKey");
      const model =
        (await store.get<string>("geminiModel")) || "gemini-3.1-flash-lite";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.geminiAPIError"));
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
          }),
          signal: aiAbortController.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Gemini API Error: ${response.statusText}`);
      const data = await response.json();
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (ipAiApi === "cohere") {
      const apiKey = (await store.get<string>("cohereApiKey")) || "";
      const model =
        (await store.get<string>("cohereModel")) || "command-r-plus-08-2024";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.cohereAPIError"));

      resultText = await fetchCohereV2(
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    } else {
      let url = "",
        apiKey = "",
        model = "";

      if (ipAiApi === "groq") {
        url = "https://api.groq.com/openai/v1/chat/completions";
        apiKey = (await store.get<string>("groqApiKey")) || "";
        model =
          (await store.get<string>("groqModel")) || "llama-3.3-70b-versatile";
      } else if (ipAiApi === "cerebras") {
        url = "https://api.cerebras.ai/v1/chat/completions";
        apiKey = (await store.get<string>("cerebrasApiKey")) || "";
        model = (await store.get<string>("cerebrasModel")) || "gemma-4-31b";
      } else if (ipAiApi === "openrouter") {
        url = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = (await store.get<string>("openRouterApiKey")) || "";
        model =
          (await store.get<string>("openRouterModel")) ||
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
      } else if (ipAiApi === "mistral") {
        url = "https://api.mistral.ai/v1/chat/completions";
        apiKey = (await store.get<string>("mistralApiKey")) || "";
        model =
          (await store.get<string>("mistralModel")) || "mistral-small-latest";
      } else if (ipAiApi === "local") {
        url =
          (await store.get<string>("localLlmUrl")) ||
          "http://127.0.0.1:1234/v1/chat/completions";
        apiKey = "local";
        model = (await store.get<string>("localLlmModel")) || "local-model";
      }

      if (ipAiApi !== "local" && !apiKey)
        throw new Error(t("ideaProcessor.alert.noApiKey", { api: ipAiApi }));

      resultText = await fetchOpenAICompatible(
        url,
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    }

    if (!resultText) throw new Error(t("ideaProcessor.ai.invalidResponse"));

    // --- 5. アニメーション付きでノードを生成 ---
    const isTruncated = resultText.length > 50 || resultText.includes("\n");
    const shortTitle =
      resultText.split("\n")[0].substring(0, 50) + (isTruncated ? "..." : "");
    const finalContent = isTruncated ? resultText : "";

    const newNode = createNewNode(
      centerX - 60,
      centerY - 30,
      shortTitle,
      finalContent,
      false,
    );

    // 初期状態は極小・透明
    newNode.scale({ x: 0.1, y: 0.1 });
    newNode.opacity(0);

    // AFAと同じアニメーションで登場させる
    new Konva.Tween({
      node: newNode,
      duration: 0.6,
      x: centerX - 60,
      y: centerY - 30,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      easing: Konva.Easings.EaseOut,
      onFinish: () => {
        // 錬金術の「素材」となったノードから、新しいノードへ矢印を引く場合は以下
        // 選択ノードが多いと矢印が大量に引かれることになるので一旦コメントアウト
        // selectedNodes.forEach(originalNode => {
        //   createSingleLink(originalNode, newNode, LinkType.ARROW);
        // });

        // 選択を解除して履歴を記録
        deselectAll();
        recordHistory("Node Alchemy executed");
        renderIpOutline();
        layer.batchDraw();
      },
    }).play();
  } catch (e: any) {
    handleAiError(e);
  } finally {
    clearAiProcessingState();
  }
}

// --- 必要な時だけDOMを生成して文字列入力を受け取る関数 ---
async function showStringInput(
  title: string,
  defaultValue: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
      justify-content: center; z-index: 10000; backdrop-filter: blur(2px);
    `;

    const theme = getCurrentThemeColors();
    const isDark = document.body.classList.contains("dark-mode");

    // ダイアログの背景色は、ノード背景(nodeBg)が透明な場合は専用の色にする
    const bgColor = isDark ? "#222" : "#f0f0f0";

    const container = document.createElement("div");
    container.style.cssText = `
      background: ${bgColor};
      border: 1px solid ${theme.text};
      padding: 20px; border-radius: 8px; width: 320px;
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
      color: ${theme.text};
      font-family: sans-serif;
    `;

    container.innerHTML = `
      <div style="margin-bottom: 15px; font-weight: bold; border-bottom: 1px solid ${theme.text}; padding-bottom: 5px;">${title}</div>
      <input type="text" id="dynamic-str-input" value="${defaultValue}"
             style="width: 100%; background: ${isDark ? "rgba(0,0,0,0.3)" : "white"}; color: inherit; border: 1px solid ${theme.text}; padding: 5px; margin-bottom: 20px; box-sizing: border-box;">
      <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="dyn-btn-cancel" style="padding: 5px 12px; cursor: pointer; background: transparent; border: 1px solid gray; color: gray;">Cancel</button>
          <button id="dyn-btn-ok" style="padding: 5px 12px; cursor: pointer; background: transparent; border: 1px solid ${theme.text}; color: ${theme.text}; font-weight: bold;">Run</button>
      </div>
    `;

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    const input = overlay.querySelector(
      "#dynamic-str-input",
    ) as HTMLInputElement;
    input.focus();
    input.select();

    const done = (val: string | null) => {
      document.body.removeChild(overlay);
      resolve(val);
    };

    overlay
      .querySelector("#dyn-btn-ok")
      ?.addEventListener("click", () => done(input.value));
    overlay
      .querySelector("#dyn-btn-cancel")
      ?.addEventListener("click", () => done(null));

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value);
      }
      if (e.key === "Escape") done(null);
    });
  });
}

// =================================================================
// IP Missing Link (2つのノードの間を埋める)
// =================================================================
async function triggerIpMissingLink() {
  if (
    isAiThinking ||
    !selectedShape ||
    selectedShape.name() !== "link-group" ||
    !store
  )
    return;

  // 1. リンクの両端のノードを取得
  const linkGroup = selectedShape as Konva.Group;
  // リンク自体に属性があるか、または両端がテンプレートアイテムならガード
  const isTemplateLink = linkGroup.getAttr("isTemplateItem") === true;
  const nodes = linkGroup.getAttr("nodes") as Konva.Group[];
  const isBothTemplate =
    nodes &&
    nodes[0].getAttr("isTemplateItem") &&
    nodes[1].getAttr("isTemplateItem");

  if (isTemplateLink || isBothTemplate) {
    alert(t("ideaProcessor.ai.cannotModifyCoreLink"));
    return;
  }

  if (!nodes || nodes.length < 2) return;

  const fromNode = nodes[0];
  const toNode = nodes[1];

  // 元のリンクの「線種」と「ラベル」を記憶しておく
  const originalType =
    (linkGroup.getAttr("linkType") as LinkType) || LinkType.ARROW;
  const labelNode = linkGroup.findOne(".link-label") as Konva.Text;
  const originalLabelText = labelNode ? labelNode.text() : "";

  // 2. 情報の抽出
  const fromTitle =
    fromNode.findOne<Konva.Text>(".text")?.text() ||
    t("ideaProcessor.default.linkStart");
  const fromContent = fromNode.getAttr("contentText") || "";

  const toTitle =
    toNode.findOne<Konva.Text>(".text")?.text() ||
    t("ideaProcessor.default.linkEnd");
  const toContent = toNode.getAttr("contentText") || "";

  // 3. ユーザーへの指示入力ダイアログ
  const lastPrompt =
    (await store.get<string>("lastMissingLinkPrompt")) ||
    t("ideaProcessor.default.missingLinkPrompt");
  const userInstruction = await showStringInput(
    t("ideaProcessor.default.aiPromptInput"),
    lastPrompt,
  );

  if (userInstruction === null) return;

  await store.set("lastMissingLinkPrompt", userInstruction);
  await store.save();

  // 4. プロンプトの構築
  const charLimit = (await store.get<number>("faMaxTokens")) || 200;
  const apiMaxTokens = charLimit * 5;
  const userSystemPrompt = (await store?.get<string>("aiSystemPrompt")) || "";
  const baseSystemPrompt = t("prompts.ideaProcessor.missingLink");
  // プロンプトの合成
  const systemPrompt = userSystemPrompt
    ? `${baseSystemPrompt}\n\n${t("prompts.ideaProcessor.userInstructionPrefix")}${userSystemPrompt}`
    : baseSystemPrompt;

  // --- 1. 線種と言語化のマッピング ---
  let relationTypeDesc = "";
  let relationFlowDesc = "";

  switch (originalType) {
    case LinkType.ARROW:
      relationTypeDesc = t("prompts.ideaProcessor.linkArrow");
      relationFlowDesc = t("prompts.ideaProcessor.linkArrowFlow", {
        from: fromTitle,
        to: toTitle,
      });
      break;
    case LinkType.DOUBLE_ARROW:
      relationTypeDesc = t("prompts.ideaProcessor.linkDoubleArrow");
      relationFlowDesc = t("prompts.ideaProcessor.linkDoubleArrowFlow", {
        from: fromTitle,
        to: toTitle,
      });
      break;
    case LinkType.LINE:
      relationTypeDesc = t("prompts.ideaProcessor.linkLine");
      relationFlowDesc = t("prompts.ideaProcessor.linkLineFlow", {
        from: fromTitle,
        to: toTitle,
      });
      break;
  }

  // --- 2. ラベルがある場合の補足 ---
  const actionDesc = originalLabelText
    ? t("prompts.ideaProcessor.linkActionDetail", { label: originalLabelText })
    : t("prompts.ideaProcessor.linkActionUnspecified");

  // --- 3. プロンプトの組み立て（セクション化） ---
  const prompt = t("prompts.ideaProcessor.missingLinkPrompt", {
    userInstruction,
    charLimit: String(charLimit),
    fromTitle,
    fromContent,
    toTitle,
    toContent,
    relationTypeDesc,
    relationFlowDesc,
    actionDesc,
  });

  // 5. 新ノードの出現座標を計算（リンクの中点より少し上）
  let midX = (fromNode.x() + toNode.x()) / 2;
  let midY = (fromNode.y() + toNode.y()) / 2;

  // 矢印の線分から正確な中点を取る
  const arrow =
    linkGroup.findOne(".link-shape") || linkGroup.findOne(".link-shape-1");
  if (arrow && (arrow as Konva.Arrow).points().length >= 4) {
    const pts = (arrow as Konva.Arrow).points();
    midX = (pts[0] + pts[2]) / 2;
    midY = (pts[1] + pts[3]) / 2;
  }

  // 6. 通信準備
  isAiThinking = true;
  aiAbortController = new AbortController();
  aiThinkingMode = "Missing Link (Canvas)";
  setAiLoading(true);

  try {
    let resultText = "";

    // --- API通信 (AFA・NAと全く同じロジック) ---
    if (ipAiApi === "gemini") {
      const apiKey = await store.get<string>("geminiApiKey");
      const model =
        (await store.get<string>("geminiModel")) || "gemini-3.1-flash-lite";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.geminiAPIError"));
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
          }),
          signal: aiAbortController.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Gemini API Error: ${response.statusText}`);
      const data = await response.json();
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (ipAiApi === "cohere") {
      const apiKey = (await store.get<string>("cohereApiKey")) || "";
      const model =
        (await store.get<string>("cohereModel")) || "command-r-plus-08-2024";
      if (!apiKey) throw new Error(t("ideaProcessor.ai.cohereAPIError"));

      resultText = await fetchCohereV2(
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    } else {
      let url = "",
        apiKey = "",
        model = "";

      if (ipAiApi === "groq") {
        url = "https://api.groq.com/openai/v1/chat/completions";
        apiKey = (await store.get<string>("groqApiKey")) || "";
        model =
          (await store.get<string>("groqModel")) || "llama-3.3-70b-versatile";
      } else if (ipAiApi === "cerebras") {
        url = "https://api.cerebras.ai/v1/chat/completions";
        apiKey = (await store.get<string>("cerebrasApiKey")) || "";
        model = (await store.get<string>("cerebrasModel")) || "gemma-4-31b";
      } else if (ipAiApi === "openrouter") {
        url = "https://openrouter.ai/api/v1/chat/completions";
        apiKey = (await store.get<string>("openRouterApiKey")) || "";
        model =
          (await store.get<string>("openRouterModel")) ||
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
      } else if (ipAiApi === "mistral") {
        url = "https://api.mistral.ai/v1/chat/completions";
        apiKey = (await store.get<string>("mistralApiKey")) || "";
        model =
          (await store.get<string>("mistralModel")) || "mistral-small-latest";
      } else if (ipAiApi === "local") {
        url =
          (await store.get<string>("localLlmUrl")) ||
          "http://127.0.0.1:1234/v1/chat/completions";
        apiKey = "local";
        model = (await store.get<string>("localLlmModel")) || "local-model";
      }

      if (ipAiApi !== "local" && !apiKey)
        throw new Error(t("ideaProcessor.alert.noApiKey", { api: ipAiApi }));

      resultText = await fetchOpenAICompatible(
        url,
        apiKey,
        model,
        prompt,
        systemPrompt,
        apiMaxTokens,
      );
    }

    if (!resultText) throw new Error(t("ideaProcessor.ai.invalidResponse"));

    // 7. アニメーション付きでノードを挿入し、リンクを引き直す
    const isTruncated = resultText.length > 50 || resultText.includes("\n");
    const shortTitle =
      resultText.split("\n")[0].substring(0, 50) + (isTruncated ? "..." : "");
    const finalContent = isTruncated ? resultText : "";

    // 中点に作成 (少し上にズラして被りを防ぐ)
    const newNode = createNewNode(
      midX - 60,
      midY - 60,
      shortTitle,
      finalContent,
      false,
    );

    newNode.scale({ x: 0.1, y: 0.1 });
    newNode.opacity(0);

    new Konva.Tween({
      node: newNode,
      duration: 0.6,
      x: midX - 60,
      y: midY - 60,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      easing: Konva.Easings.EaseOut,
      onFinish: () => {
        // 元のリンクを破壊する前に、属性を継承して新しいリンクを2本引く
        linkGroup.destroy();

        // 1. 起点 -> 新ノード (元の線種を維持、ラベルを移植)
        const link1 = createSingleLink(fromNode, newNode, originalType);
        if (originalLabelText) {
          const l1Text = link1.findOne(".link-label") as Konva.Text;
          if (l1Text) {
            l1Text.text(originalLabelText);
            updateLinkPoints(link1); // ラベル位置を更新
          }
        }

        // 2. 新ノード -> 終点 (元の線種を維持、ラベルは空)
        createSingleLink(newNode, toNode, originalType);

        deselectAll();
        recordHistory("IP Missing Link executed");
        renderIpOutline();
        layer.batchDraw();
      },
    }).play();
  } catch (e: any) {
    handleAiError(e);
  } finally {
    clearAiProcessingState();
  }
}

// =================================================================
// 8. ウィンドウ制御とテーマ管理 (Window & Theme & Settings)
// =================================================================

// ■ 初期化時に呼び出すセットアップ関数
async function setupWindowFeatures(): Promise<boolean> {
  osType = await type();

  // ストアの初期化
  store = await Store.load(".settings.dat");

  // i18n初期化
  const appLang = (await store.get("appLanguage")) ?? "ja";
  await initI18n(appLang === "en" ? "en" : "ja");
  applyTranslationsToDOM();

  // 1. 各種ボタンのイベント登録
  setupUIButtons();
  setupOutlineEvents();
  await initAiSelector();

  // 2. リスナーのセットアップ
  setupThemeListener();
  setupSettingsListener();

  // 3. 初期状態の適用（ストアから読み込んで反映）
  const isLoaded = await applyInitialSettings();
  return isLoaded;
}

// ■ UIボタンのイベント登録
function setupUIButtons() {
  const isEditing = () => isTextEditing || isContentEditing;
  document
    .getElementById("ip-toggle-on-top-btn")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      IPToggleOnTop();
    });
  document.getElementById("ip-close-btn")?.addEventListener("click", () => {
    if (isEditing()) return;
    IPClose();
  });
  document
    .getElementById("ip-fullscreen-btn")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      IPToggleFullscreen();
    });
  document
    .getElementById("ip-theme-toggle-btn")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      IPThemeToggle();
    });
  document
    .getElementById("ip-create-group-button")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      createGroupNodeByButton();
    });
  document
    .getElementById("ip-save-as-button")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      saveByBtn();
    });
  document.getElementById("ip-load-button")?.addEventListener("click", () => {
    if (isEditing()) return;
    loadFromMrsd();
  });
  document
    .getElementById("ip-new-file-button")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      newFile();
    });
  document
    .getElementById("ip-zoom-reset-btn")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      zoomReset();
    });
  document
    .getElementById("ip-reset-window-btn")
    ?.addEventListener("click", () => {
      if (isEditing()) return;
      InitializeStage();
    });
  document.getElementById("ip-ai-btn")?.addEventListener("click", () => {
    if (isContentEditing) {
      triggerTemplateCompletion();
    } else if (selectedShape && selectedShape.name() === "link-group") {
      // リンクが選択されている時は Missing Link
      triggerIpMissingLink();
    } else if (selectedNodes.length > 1 && !isTextEditing) {
      triggerNodeAlchemy();
    } else if (selectedNodes.length === 1 && !isTextEditing) {
      // 単一選択
      triggerFreeAssociation();
    }
  });
  const selector = document.getElementById("ip-ai-selector-container");
  // --- テンプレートメニュー制御 ---
  const templateBtn = document.getElementById("ip-template-button");
  const templateMenu = document.getElementById("ip-template-menu");

  if (templateBtn && templateMenu && selector) {
    // ボタンクリックでメニュー開閉
    templateBtn.addEventListener("click", (e) => {
      if (isEditing()) return;
      e.stopPropagation();
      templateMenu.classList.toggle("hidden");
      selector.classList.toggle("hidden");
    });

    // メニュー項目クリック
    templateMenu.addEventListener("click", (e) => {
      if (isEditing()) return;
      const target = e.target as HTMLElement;
      // closestで親のli要素などを探す
      const item = target.closest("[data-template]") as HTMLElement;

      if (item) {
        const tmplName = item.dataset.template;
        if (tmplName) {
          generateTemplate(tmplName);
        }
        templateMenu.classList.add("hidden");
        selector.classList.remove("hidden");
      }
    });

    // メニュー外クリックで閉じる
    window.addEventListener("click", () => {
      if (!templateMenu.classList.contains("hidden")) {
        templateMenu.classList.add("hidden");
        selector.classList.remove("hidden");
      }
    });
  }

  // エクスポートメニューのクリック処理
  const exportButton = document.getElementById("ip-export-button")!;
  const exportMenu = document.getElementById("ip-export-menu");
  if (exportButton && exportMenu && selector) {
    exportButton.addEventListener("click", (e) => {
      if (isEditing()) return;
      e.stopPropagation();
      exportMenu.classList.toggle("hidden");
      selector.classList.toggle("hidden");
    });
    exportMenu.addEventListener("click", (e) => {
      if (isEditing()) return;
      const target = e.target as HTMLElement;
      if (target.classList.contains("export-item")) {
        const format = target.dataset.format;

        if (format === "html") {
          exportAsHtml();
        } else if (format === "md") {
          exportAsMarkdown();
        } else if (format === "png") {
          exportAsPng();
        } else if (format === "pdf") {
          exportAsPdf();
        } else if (format === "send-to-editor") {
          sendToEditor();
        }

        exportMenu.classList.add("hidden");
        selector.classList.remove("hidden");
      }
    });
    // メニュー外クリックで閉じる
    window.addEventListener("click", () => {
      if (!exportMenu.classList.contains("hidden")) {
        exportMenu.classList.add("hidden");
        selector.classList.remove("hidden");
      }
    });
  }
}

function setupOutlineEvents() {
  // 開閉ボタン
  document
    .getElementById("ip-toggle-outline-btn")
    ?.addEventListener("click", () => {
      if (isTextEditing || isContentEditing) return;
      toggleOutlinePane();
    });

  // 全展開・全折りたたみ
  document
    .getElementById("outline-expand-all")
    ?.addEventListener("click", () => setAllIpOutlineCollapsed(false));
  document
    .getElementById("outline-collapse-all")
    ?.addEventListener("click", () => setAllIpOutlineCollapsed(true));

  // アウトライン内クリックイベント (委譲)
  outlinePaneContent?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // a) グループのトグル（開閉）
    if (target.classList.contains("outline-toggle") && target.dataset.groupId) {
      const groupId = target.dataset.groupId;
      if (groupId) {
        const currentState = outlineCollapsedState.get(groupId) ?? false;
        outlineCollapsedState.set(groupId, !currentState);
        renderIpOutline();
      }
    }
    // b) ノードのトグル
    else if (
      target.classList.contains("node-toggle") &&
      target.dataset.nodeId
    ) {
      const nodeId = target.dataset.nodeId;
      const currentState = nodeCollapsedState.get(nodeId) ?? false;
      nodeCollapsedState.set(nodeId, !currentState);
      renderIpOutline();
    }
    // c) ノードタイトル（ジャンプ）
    else if (target.closest(".outline-node")) {
      const nodeEl = target.closest(".outline-node") as HTMLElement;
      const nodeId = nodeEl.dataset.id;
      if (nodeId) jumpToNode(nodeId);
    }
    // d) サブ見出し（エディタ内ジャンプ）
    else if (target.closest(".outline-sub-node")) {
      const subNodeEl = target.closest(".outline-sub-node") as HTMLElement;
      const parentId = subNodeEl.dataset.parentId;
      const headingText = subNodeEl.dataset.headingText;
      if (parentId && headingText) {
        jumpToNode(parentId, headingText);
      }
    }
  });
}

// ■ 初期設定の適用
async function applyInitialSettings(): Promise<boolean> {
  if (!store) return false;

  // 1.ユーザーフォントの読み込み
  const userFont = await store.get<string>("userFontFamily");
  if (userFont && userFont !== "default") {
    document.documentElement.style.setProperty(
      "--user-font-family",
      `"${userFont}"`,
    );
  }

  // 2. ストアからテーマを読み込んで適用
  const isDark = await store.get<boolean>("isDarkMode");
  if (isDark) document.body.classList.add("dark-mode");
  else document.body.classList.remove("dark-mode");
  // AI演出設定を読み込み
  showAiThinkingOverlay =
    (await store.get<boolean>("showAiThinkingOverlay")) ?? true;

  // 3. カスタムカラーのCSS変数適用
  const root = document.documentElement.style;
  const customWindowBg = await store.get<string>("customWindowBg");
  if (customWindowBg) root.setProperty("--window-bg-color", customWindowBg);
  const customEditorBg = await store.get<string>("customEditorBg");
  if (customEditorBg) root.setProperty("--editor-bg-color", customEditorBg);

  const customTextColor = await store.get<string>("customTextColor");
  if (customTextColor) root.setProperty("--editor-text-color", customTextColor);
  const customSelectionColor = await store.get<string>("customSelectionColor");
  if (customSelectionColor)
    root.setProperty("--editor-selection-color", customSelectionColor);
  const customHeadingColor = await store.get<string>("customHeadingColor");
  if (customHeadingColor)
    root.setProperty("--heading-color", customHeadingColor);
  const customScrollbarColor = await store.get<string>("customScrollbarColor");
  if (customScrollbarColor)
    root.setProperty("--scrollbar-color", customScrollbarColor);

  // 4. グロー（CSS）と Konva の外観更新
  await applyGlowEffect();
  await updateAllNodesAppearance(); // ここでKonvaの初期色を決定

  // 前回開いていたファイルをロード
  const lastFile = await store.get<string>("lastIdeaFilePath");
  if (lastFile) {
    console.log("Loading last opened file:", lastFile);
    // 引数付きで呼び出す（ダイアログを出さずに開く）
    await loadFromMrsd(lastFile);
    return true; // ロード成功を返す
  } else {
    // ファイルがない場合は Untitled 更新だけしておく
    _updateTitle();
    return false; // ロードしなかった
  }
}

// ■ テーマ同期リスナー (app:theme-changed)
function setupThemeListener() {
  listen("app:theme-changed", async (event: any) => {
    const isDark =
      typeof event.payload === "object"
        ? event.payload.isDarkMode
        : event.payload;
    if (isDark) document.body.classList.add("dark-mode");
    else document.body.classList.remove("dark-mode");

    await applyGlowEffect();
    await updateAllNodesAppearance(); // テーマ切り替え時にKonvaを一斉更新
  });
}

// ■ 設定変更リスナー (settings-changed)
function setupSettingsListener() {
  listen("app:language-changed", async (event) => {
    console.log("listen!");
    await initI18n(event.payload === "en" ? "en" : "ja");
    applyTranslationsToDOM();
    const title: string = await invoke<string>("get_window_title", {
      windowKey: "idea_processor",
    }).catch((): string => "");
    if (title) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTitle(title);
    }
  });

  listen("settings-changed", async (event: any) => {
    const p = event.payload;

    // CSS変数の更新 (AIチャットウィンドウの仕様に準拠)
    const root = document.documentElement.style;

    if (p.customWindowBg !== undefined) {
      if (p.customWindowBg)
        root.setProperty("--window-bg-color", p.customWindowBg);
      else root.removeProperty("--window-bg-color");
    }
    if (p.customEditorBg !== undefined) {
      if (p.customEditorBg)
        root.setProperty("--editor-bg-color", p.customEditorBg);
      else root.removeProperty("--editor-bg-color");
    }
    if (p.userFontFamily !== undefined) {
      if (p.userFontFamily && p.userFontFamily !== "default") {
        root.setProperty("--user-font-family", `"${p.userFontFamily}"`);
      } else {
        root.removeProperty("--user-font-family");
      }
    }
    if (p.customTextColor !== undefined) {
      if (p.customTextColor) {
        root.setProperty("--editor-text-color", p.customTextColor);
      } else {
        root.removeProperty("--editor-text-color");
      }
    }
    if (p.customSelectionColor !== undefined) {
      if (p.customSelectionColor) {
        root.setProperty("--editor-selection-color", p.customSelectionColor);
      } else {
        root.removeProperty("--editor-selection-color");
      }
    }
    if (p.customHeadingColor !== undefined) {
      if (p.customHeadingColor) {
        root.setProperty("--heading-color", p.customHeadingColor);
      } else {
        root.removeProperty("--heading-color");
      }
    }
    if (p.customScrollbarColor !== undefined) {
      if (p.customScrollbarColor) {
        root.setProperty("--scrollbar-color", p.customScrollbarColor);
      } else {
        root.removeProperty("--scrollbar-color");
      }
    }

    // 演出設定のリアルタイム反映
    if (p.showAiThinkingOverlay !== undefined) {
      showAiThinkingOverlay = p.showAiThinkingOverlay;
    }

    // グロー効果の更新判定
    if (
      p.enableGlow !== undefined ||
      p.glowColor !== undefined ||
      p.glowRadius !== undefined
    ) {
      // ストアの値はまだ更新されていない可能性があるため、payloadの値も考慮するか、
      // 単に再取得を行う（Tauriのストアはファイル同期されるので、少しラグがあるかも）
      // ここではシンプルに再適用を呼ぶ
      await applyGlowEffect();
    }
    await updateAllNodesAppearance();
  });
}

// ■ グロー適用ロジック
async function applyGlowEffect() {
  if (!store) return;

  const enableGlow = (await store.get<boolean>("enableGlow")) ?? false;
  const glowColor =
    (await store.get<string>("glowColor")) || "rgba(0, 255, 65, 0.5)";
  const glowRadius = (await store.get<number>("glowRadius")) || 5;

  const root = document.documentElement.style;
  const body = document.body;
  const isDark = body.classList.contains("dark-mode");

  // 「ライトモード(カスタムモード)」かつ「グロー有効」のときだけ発動
  if (!isDark && enableGlow) {
    body.classList.add("custom-glow");

    let shadowVal = "";
    const match = glowColor.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/,
    );

    if (match) {
      const r = match[1];
      const g = match[2];
      const b = match[3];
      const a = parseFloat(match[4] || "1");

      const shadow1 = `0 0 ${glowRadius}px rgba(${r}, ${g}, ${b}, ${a})`;
      const shadow2 = `0 0 ${glowRadius * 2}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.1)})`;
      const shadow3 = `0 0 ${glowRadius * 4}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.2)})`;

      shadowVal = `${shadow1}, ${shadow2}, ${shadow3}`;
    } else {
      console.warn("Glow color parse failed, using simple shadow:", glowColor);
      shadowVal = `0 0 ${glowRadius}px ${glowColor}, 0 0 ${glowRadius * 2}px ${glowColor}`;
    }

    root.setProperty("--custom-text-shadow", shadowVal);
  } else {
    body.classList.remove("custom-glow");
    root.removeProperty("--custom-text-shadow");
  }
}

// ■ 閉じる処理
async function IPClose() {
  const window = getCurrentWindow();

  // ズーム状態の保存などが必要ならここで（今回は省略、次回起動時に自動復元されるため）

  // 状態判定
  const isUntitled = !currentFilePath;
  // 空かどうか判定（ノードもグループもリンクもない）
  const isEmpty =
    stage.find(".node-group").length === 0 &&
    stage.find(".container-group").length === 0 &&
    stage.find(".link-group").length === 0;

  // --- ケース1: Untitledで、中身が空ではない -> ユーザーに確認 ---
  if (isUntitled && !isEmpty) {
    // Tauriのダイアログは「はい/いいえ」。
    // Yes -> 保存して閉じる / No -> 破棄して閉じる / (ダイアログ外クリック等 -> キャンセル扱いしたいがTauriでは難しい)
    // ここでは「保存しますか？」と聞き、Yesなら保存フロー、Noなら破棄フローとする
    const doSave = await ask(
      t("ideaProcessor.dialog.unsavedChanges.closeMessage"),
      {
        title: t("ideaProcessor.dialog.unsavedChanges.closeTitle"),
        okLabel: t("ideaProcessor.dialog.unsavedChanges.saveLabel"),
        cancelLabel: t("ideaProcessor.dialog.unsavedChanges.discardLabel"),
      },
    );

    if (doSave) {
      // 保存する
      await saveToMrsd(true); // 名前をつけて保存
      // キャンセルされた場合(currentFilePathがnullのまま)は閉じない
      if (currentFilePath) {
        if (await window.isFullscreen()) {
          await window.setFullscreen(false);
        }
        window.close();
      }
    } else {
      // 保存しない（破棄） -> そのまま閉じる
      if (await window.isFullscreen()) {
        await window.setFullscreen(false);
      }
      window.close();
    }
  }
  // --- ケース2: Untitledで、中身も空 -> 何も聞かずに閉じる ---
  else if (isUntitled && isEmpty) {
    if (await window.isFullscreen()) {
      await window.setFullscreen(false);
    }
    window.close();
  }
  // --- ケース3: 通常ファイルで、変更がある -> 強制保存して閉じる ---
  else if (isDirty) {
    // オートセーブが間に合っていない分をここで確実に保存
    await saveToMrsd(false);
    if (await window.isFullscreen()) {
      await window.setFullscreen(false);
    }
    window.close();
  }
  // --- ケース4: それ以外 (変更がない) -> そのまま閉じる
  else {
    if (await window.isFullscreen()) {
      await window.setFullscreen(false);
    }
    window.close();
  }
}

// ■ 最大化切り替え
async function IPToggleFullscreen() {
  isSimpleFullscreen = !isSimpleFullscreen;
  const wrapper = document.getElementById("ip-wrapper");
  await invoke("set_simple_fullscreen", { enable: isSimpleFullscreen });
  if (osType !== "macos" && wrapper) {
    wrapper.style.borderRadius = isSimpleFullscreen ? "0px" : "6px";
  }
}

// ■ テーマ切り替え
async function IPThemeToggle() {
  await emit("subwindow-toggle-theme");
}

async function IPToggleOnTop() {
  const pinBtn = document.getElementById("ip-toggle-on-top-btn");
  if (!pinBtn) return;
  isPinned = !isPinned;
  await getCurrentWindow().setAlwaysOnTop(isPinned);
  if (isPinned) {
    pinBtn.classList.add("active");
    pinBtn.title = t("ideaProcessor.pinButton.pinned");
  } else {
    pinBtn.classList.remove("active");
    pinBtn.title = t("ideaProcessor.pinButton.unpinned");
  }
}

// ■グループノード作成ボタンの処理
async function createGroupNodeByButton() {
  // 画面中央あたりに生成
  const center = {
    x: window.innerWidth / 2 - 150,
    y: window.innerHeight / 2 - 100,
  };
  createGroupNode(center.x, center.y);
  recordHistory("Group created");
  layer.batchDraw();
  renderIpOutline();
}

// =================================================================
// 9. 起動処理
// =================================================================

document.addEventListener("DOMContentLoaded", async () => {
  const title: string = await invoke<string>("get_window_title", {
    windowKey: "idea_processor",
  }).catch((): string => "");
  if (title) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  }
  // 1. Konva等のセットアップ
  initializeIdeaProcessor();
  // 2. ウィンドウ機能のセットアップと、前回ファイルの自動ロードを完全に待機する
  const isFileLoaded = await setupWindowFeatures();
  // 3. もしファイルがロードされていなかった（完全な新規起動）場合のみ、空の履歴を作る
  if (!isFileLoaded) {
    history = [];
    historyIndex = -1;
    recordHistory("Initial Empty State");
    isDirty = false; // 初期状態はクリーン
  }
  // 4. ウィンドウ表示とシャドウ無効解除 ＆ Niriスタック
  await invoke("ping_window_ready", { label: "Idea Processor" });
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();

  if (osType === "linux") {
    await invoke("trigger_niri_stack");
  }
});

import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { type } from '@tauri-apps/plugin-os';
// import { resolveResource } from '@tauri-apps/api/path';
// import { convertFileSrc } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import Konva from 'konva';
import JSZip from 'jszip';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import { save, open, ask } from '@tauri-apps/plugin-dialog';

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
let osType = 'windows';
let isTextEditing = false;
let currentFilePath: string | null = null; // 現在開いているファイルのパス
let isDirty = false; // 変更があるかどうかのフラグ
let projectMetadata: any = null; // 読み込んだファイルのメタデータ（作成日時など）を保持
let isPanning = false;
let didPan = false;
let lastPointerPosition: { x: number; y: number } = { x: 0, y: 0 };
// let selectionStartPos: { x: number; y: number } | null = null;
// let isDraggingSelection = false;
let selectedShape: Konva.Group | null = null;
let selectedNodes: Konva.Group[] = [];

// テーマカラー定義
const themes = {
  light: {
    text: '#111111',
    link: '#333333',
    selection: 'rgba(203, 7, 7, 0.4)',
    nodeBg: 'transparent',
    labelBackground: '#fafae0',
    heading: '#cb0707ff'
  },
  dark: {
    text: '#cccccc',
    link: '#cccccc',
    selection: 'rgba(211, 16, 16, 0.4)',
    nodeBg: 'transparent',
    labelBackground: '#4f4f4f',
    heading: '#d31010ff'
  }
};

// --- .mrsd (canvas.json) 用の型定義 ---
interface MrsdNode {
  id: string;
  type: string;       // "file"
  file: string;       // "files/xxx.md"
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;      // ノード内のテキスト
  parentId: string | null;
  isTemplateItem: boolean;
}

interface MrsdGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;      // グループ名
  isTemplateRoot: boolean;
}

interface MrsdEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  type?: string;      // "arrow", "double_arrow", "line"
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

enum LinkType { LINE = 'line', ARROW = 'arrow', DOUBLE_ARROW = 'double_arrow' }
type Vector2d = { x: number; y: number; };

// =================================================================
// 2. 履歴管理 (Undo / Redo)
// =================================================================

function recordHistory(message: string = '') {
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
    recreateStage(data);
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
    recreateStage(data);
    console.log(`[History] Redo to index: ${historyIndex}`);
  } catch (e) {
    console.error("[History] Redo failed:", e);
  } finally {
    finalizeHistoryAction();
  }
}

function finalizeHistoryAction() {
  isHistoryEnabled = true;
  transformer.nodes([]);
  selectionRect.visible(false);
  selectedShape = null;
  layer.draw();
}

// =================================================================
// 3. データ抽出とステージ再構築
// =================================================================

function _getCurrentStageData() {
  const nodesData: any[] = [];
  stage.find<Konva.Group>('.node-group').forEach(node => {
    const rect = node.findOne<Konva.Rect>('.background');
    const textNode = node.findOne<Konva.Text>('.text');
    if (!rect || !textNode) return;
    nodesData.push({
      id: node.id(), x: node.x(), y: node.y(), width: rect.width(), height: rect.height(),
      title: textNode.text()
    });
  });

  const linksData: any[] = [];
  stage.find<Konva.Group>('.link-group').forEach(linkGroup => {
    const nodes = linkGroup.getAttr('nodes') as Konva.Group[];
    const type = linkGroup.getAttr('linkType');
    const label = linkGroup.findOne<Konva.Text>('.link-label');
    const sibling = linkGroup.getAttr('sibling');

    if (sibling && sibling.id() < linkGroup.id()) return; // 双方向の重複排除
    if (nodes && nodes.length === 2 && type) {
      linksData.push({
        id: linkGroup.id(),
        from: nodes[0].id(),
        to: nodes[1].id(),
        type: type,
        label: label ? label.text() : ''
      });
    }
  });

  const groupsData: any[] = [];
  stage.find<Konva.Group>('.container-group').forEach(group => {
    const bg = group.findOne('.group-bg') as Konva.Rect;
    const title = group.findOne('.group-title') as Konva.Text;
    if (bg && title) {
      groupsData.push({
        id: group.id(),
        x: group.x(),
        y: group.y(),
        width: bg.width(),
        height: bg.height(),
        title: title.text(),
        childNodeIds: group.getAttr('childNodeIds') || []
      });
    }
  });

  return { nodes: nodesData, links: linksData, groups: groupsData };
}

// =================================================================
// 4. ステージ再構築 (recreateStage) - Undo/Redoの要
// =================================================================

function recreateStage(data: any) {
  // 1. レイヤーをクリア（ステージ自体は破棄しない）
  layer.destroyChildren();
  transformer.nodes([]);
  selectionRect.visible(false);

  // 2. ノードの復元
  if (data.nodes) {
    data.nodes.forEach((nodeData: any) => {
      createNodeFromData(nodeData);
    });
  }

  // 3. リンクの復元
  if (data.links) {
    data.links.forEach((linkData: any) => {
      // IDから実体のノードを探す
      const fromNode = layer.findOne('#' + linkData.from);
      const toNode = layer.findOne('#' + linkData.to);

      if (fromNode && toNode) {
        const linkGroup = createSingleLink(fromNode as Konva.Group, toNode as Konva.Group, linkData.type);
        if (linkGroup) {
          linkGroup.id(linkData.id); // IDを復元
          const labelText = linkGroup.findOne('.link-label') as Konva.Text;
          if (labelText && linkData.label) {
            labelText.text(linkData.label);
            updateLinkPoints(linkGroup); // これで表示状態とサイズが更新される
          }
        }
      }
    });
  }

  // 4. グループノードの復元
  if (data.groups) {
    data.groups.forEach((gData: any) => {
      const groupNode = createGroupNode(gData.x, gData.y, gData.title);
      groupNode.id(gData.id);
      groupNode.setAttr('childNodeIds', gData.childNodeIds || []);

      const bg = groupNode.findOne('.group-bg') as Konva.Rect;
      const handle = groupNode.findOne('.resize-handle') as Konva.Circle;
      if (bg && handle) {
        bg.width(gData.width);
        bg.height(gData.height);
        handle.x(gData.width);
        handle.y(gData.height);
      }
    });
  }

  // 4. 描画更新
  layer.batchDraw();
}

function createNodeFromData(data: any) {
  const colors = getCurrentThemeColors();

  const nodeGroup = new Konva.Group({
    x: data.x,
    y: data.y,
    id: data.id,
    draggable: true,
    name: 'node-group',
  });

  const textNode = new Konva.Text({
    name: 'text',
    text: data.title || 'New Node',
    fontSize: 16,
    fontFamily: "serif-ja, serif",
    fill: colors.text, // テーマに合わせた文字色（ライトなら黒系）
    padding: 8,
    width: data.width || 200,
    lineHeight: 1.2,
  });

  const backgroundRect = new Konva.Rect({
    name: 'background',
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

// --- ノードサイズをテキスト量に合わせて最適化する関数 ---
function adjustNodeSize(nodeGroup: Konva.Group) {
  const textNode = nodeGroup.findOne('.text') as Konva.Text;
  const bg = nodeGroup.findOne('.background') as Konva.Rect;
  if (!textNode || !bg) return;

  const maxWidth = 200; // 折り返しの最大幅
  // KonvaのTextはpaddingを含んだ幅を返すため、追加の計算は本来不要
  // Electron版の挙動（余裕を持たせる）に合わせるなら以下
  // const padding = 16; 

  // 1. 一時的に幅の制限をなくして、テキスト本来の幅を計算
  textNode.width(undefined as any);

  // 2. 幅の判定
  if (textNode.width() > maxWidth) {
    // 最大幅を超える場合は、折り返しを有効にする
    textNode.width(maxWidth);
  }
  // 超えない場合は width(undefined) のまま（自動幅）

  // 3. 背景サイズを同期
  bg.width(textNode.width());
  bg.height(textNode.height());

  // 4. リンクの接続位置を更新
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
    container: 'ip-container',
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // レイヤー作成
  layer = new Konva.Layer();
  stage.add(layer);

  // ツール初期化
  transformer = new Konva.Transformer({
    visible: false,
    resizeEnabled: false,
    rotateEnabled: false,
    borderEnabled: false,
  });
  layer.add(transformer);

  selectionRect = new Konva.Rect({
    fill: 'rgba(0, 123, 255, 0.3)',
    visible: false,
    stroke: 'blue',
    strokeWidth: 1,
  });
  layer.add(selectionRect);

  // イベント登録
  setupWindowFeatures();
  setupEventListeners();
  setupKeyboardEvents();

  // リサイズ追従
  window.addEventListener('resize', () => {
    stage.width(window.innerWidth);
    stage.height(window.innerHeight);
    layer.batchDraw();
  });
  setTimeout(() => {
    recordHistory('Initial Empty State');
    isDirty = false; // 初期化直後はダーティではない
  }, 100);
}

function setupEventListeners() {
  // ステージ上のクリック（ノード作成・選択解除）
  stage.on('click tap', (e) => {
    if (e.target === stage) {
      deselectAll();
      return;
    }

    const group = e.target.getParent() as Konva.Group;
    if (!group) return;

    const isCtrl = e.evt.ctrlKey || e.evt.metaKey;
    const isShift = e.evt.shiftKey;

    if (group.name() === 'node-group') {
      if (isCtrl && isShift) {
        manageLink(group, LinkType.DOUBLE_ARROW);
      } else if (isShift) {
        manageLink(group, LinkType.ARROW);
      } else if (isCtrl) {
        manageLink(group, LinkType.LINE);
      } else {
        selectShape(group);
      }
    } else if (group.name() === 'link-group') {
      selectShape(group);
    } else if (group.name() === 'container-group') {
      // グループノードがクリックされた場合
      if (isCtrl && selectedNodes.length > 0) {
        // 登録: 選択中のノードをグループに追加
        const childIds = group.getAttr('childNodeIds') || [];
        selectedNodes.forEach(node => {
          if (!childIds.includes(node.id())) {
            childIds.push(node.id());
            // 登録された証として色を変える（選択色）
            const bg = node.findOne('.background') as Konva.Rect;
            if (bg) bg.stroke(getCurrentThemeColors().selection);
          }
        });
        group.setAttr('childNodeIds', childIds);
        recordHistory('Nodes added to group');
        deselectAll();

      } else if (isShift && selectedNodes.length > 0) {
        // 解除: 選択中のノードをグループから外す
        let childIds = group.getAttr('childNodeIds') || [];
        selectedNodes.forEach(node => {
          childIds = childIds.filter((id: string) => id !== node.id());
          // 色を元に戻す
          const bg = node.findOne('.background') as Konva.Rect;
          if (bg) bg.strokeEnabled(false);
        });
        group.setAttr('childNodeIds', childIds);
        recordHistory('Nodes removed from group');
        deselectAll();

      } else {
        selectShape(group);
      }
    }
  });

  stage.on('dblclick', (e) => {
    // 1. ノードのダブルクリック（テキスト編集）
    const nodeGroup = e.target.getParent();
    if (nodeGroup && nodeGroup.name() === 'node-group') {
      const textNode = nodeGroup.findOne('.text') as Konva.Text;
      if (textNode) startTextEditing(textNode, nodeGroup as Konva.Group);
      return;
    }

    // 2. グループタイトルのダブルクリック（タイトル編集）
    const groupNode = e.target.getParent();
    if (groupNode && groupNode.name() === 'container-group') {
      const titleText = groupNode.findOne('.group-title') as Konva.Text;
      if (titleText && e.target === titleText) {
        startGroupTitleEditing(titleText);
        return;
      }
      // グループ内（背景）ダブルクリックで新規ノード作成＆登録
      const pos = stage.getPointerPosition();
      if (pos) {
        const newNode = createNewNode(pos.x, pos.y);
        // グループに登録
        const childIds = groupNode.getAttr('childNodeIds') || [];
        childIds.push(newNode.id());
        groupNode.setAttr('childNodeIds', childIds);
        recordHistory('Node created in group');
      }
      return;
    }

    // 3. リンク（またはラベル）のダブルクリック
    let current: Konva.Node | null = e.target;
    let linkGroup: Konva.Group | null = null;
    while (current && !(current instanceof Konva.Stage)) {
      if (current.name() === 'link-group') {
        linkGroup = current as Konva.Group;
        break;
      }
      current = current.getParent();
    }
    if (linkGroup) {
      const labelText = linkGroup.findOne('.link-label') as Konva.Text;
      if (labelText) startLabelEditing(labelText, linkGroup);
      return;
    }

    // 4. 背景のダブルクリック（新規ノード作成）
    if (e.target === stage) {
      const pos = stage.getPointerPosition();
      if (pos) {
        createNewNode(pos.x, pos.y);
        recordHistory('Node created');
      }
    }
  });

  // ノードのドラッグ終了時（履歴記録）
  stage.on('dragend', (e) => {
    if (e.target.name() === 'node-group') {
      recordHistory('Node moved');
      updateConnectedLinks(e.target as Konva.Group);
    }
  });

  // ノードのドラッグ中（リンク追従）
  stage.on('dragmove', (e) => {
    if (e.target.name() === 'node-group') {
      updateConnectedLinks(e.target as Konva.Group);
    }
  });

  // リンク作成モード（Alt + ドラッグ）などの実装
  // ここではシンプルに「Altキーを押しながらドラッグでリンク作成」を実装
  stage.on('mousedown', (e) => {
    const isAlt = e.evt.altKey;
    // --- 右クリック (Pan開始) ---
    if (e.evt.button === 2) {
      const parent = e.target.getParent();
      // ノード上での右クリックは除外（将来のコンテキストメニュー用）
      if (parent && parent.name() === 'node-group') return;

      isPanning = true;
      didPan = false; // パンしたかどうかのフラグをリセット
      const pos = stage.getPointerPosition();
      if (pos) lastPointerPosition = pos;
      return;
    }
    if (isAlt) {
      const group = e.target.getParent();
      if (group && group.name() === 'node-group') {
        // リンク作成開始
        startConnection(group as Konva.Group);
      }
    }
  });

  stage.on('mousemove', (e) => {
    // --- パン処理 ---
    if (isPanning) {
      e.evt.preventDefault();
      const pos = stage.getPointerPosition();
      if (!pos) return;

      const dx = pos.x - lastPointerPosition.x;
      const dy = pos.y - lastPointerPosition.y;

      // 少しでも動いたら「パンした」とみなす
      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        didPan = true;
        stage.x(stage.x() + dx);
        stage.y(stage.y() + dy);

        const newPos = stage.getPointerPosition();
        if (newPos) lastPointerPosition = newPos;

        layer.batchDraw();
      }
      return;
    }
    if (connectionLine) {
      const pos = stage.getRelativePointerPosition();
      if (pos) {
        const points = connectionLine.points();
        points[2] = pos.x;
        points[3] = pos.y;
        connectionLine.points(points);
        layer.batchDraw();
      }
    }
  });

  stage.on('mouseup mouseleave', (e) => {
    // 右クリック離上
    if (e.evt.button === 2) {
      if (isPanning) {
        isPanning = false;
        // もし didPan === false なら、ここで「背景のコンテキストメニュー」を出す処理が入る
      }
    }
    if (connectionLine) {
      const group = e.target.getParent();
      if (group && group.name() === 'node-group' && connectionStartNode && group !== connectionStartNode) {
        // リンク確定
        createSingleLink(connectionStartNode, group as Konva.Group);
        recordHistory('Link created');
      }
      // 掃除
      connectionLine.destroy();
      connectionLine = null;
      connectionStartNode = null;
      layer.draw();
    }
  });

  // --- マウスホイールによるズーム ---
  const scaleBy = 1.1; // 1回のホイールでの拡大率

  stage.on('wheel', (e) => {
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
  const rect = node.findOne('.background') as Konva.Rect;
  const center = { x: pos.x + rect.width() / 2, y: pos.y + rect.height() / 2 };

  connectionLine = new Konva.Line({
    stroke: themes.dark.link,
    strokeWidth: 2,
    points: [center.x, center.y, center.x, center.y],
    dash: [10, 5]
  });
  layer.add(connectionLine);
}

// =================================================================
// 6. ノード・リンク作成ロジック (Core Logic)
// =================================================================

function createNewNode(x: number, y: number, textStr = 'New Node', isInteractive = true) {
  const id = `node_${generateUUID()}`;
  const node = createNodeFromData({
    id, x, y, width: 200, height: 60, title: textStr
  });
  adjustNodeSize(node);
  updateAllNodesAppearance();
  // 手動作成（ダブルクリック等）の時だけ編集モードに入る
  if (isInteractive) {
    const textNode = node.findOne('.text') as Konva.Text;
    if (textNode) {
      setTimeout(() => {
        startTextEditing(textNode, node, true);
      }, 50);
    }
  }
  return node;
}

// --- グループノードの作成 ---
function createGroupNode(x: number, y: number, titleStr = 'グループ名') {
  const id = `group_${generateUUID()}`;
  const colors = getCurrentThemeColors();

  const groupNode = new Konva.Group({
    id: id,
    x: x,
    y: y,
    draggable: true,
    name: 'container-group'
  });

  // 子ノードIDリスト
  groupNode.setAttr('childNodeIds', []);

  // 背景枠 (点線)
  const bgRect = new Konva.Rect({
    name: 'group-bg',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    fill: 'rgba(0,0,0,0)', // 完全透明ではなく、クリック判定用にアルファ0
    stroke: colors.text,
    strokeWidth: 1, // 1px
    dash: [5, 5],
    cornerRadius: 10
  });

  // グループタイトル
  const titleText = new Konva.Text({
    name: 'group-title',
    text: titleStr,
    y: -25, // 枠の上に配置
    fontSize: 14,
    fontFamily: 'var(--user-font-family, serif-ja, serif)',
    fill: colors.text,
  });

  // リサイズハンドル
  const resizeHandle = new Konva.Circle({
    name: 'resize-handle',
    x: 300,
    y: 200,
    radius: 10, // 少し大きくして掴みやすく
    fill: colors.selection,
    stroke: colors.selection,
    strokeWidth: 1,
    draggable: true,
    visible: false, // 初期は非表示
    cursor: 'nwse-resize'
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
  resizeHandle.on('mousedown touchstart', (e) => {
    e.cancelBubble = true; // ★親にイベントを渡さない
    groupNode.draggable(false); // ★親のドラッグを禁止
  });

  resizeHandle.on('dragmove', (e) => {
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

  resizeHandle.on('dragend', (e) => {
    e.cancelBubble = true;
    groupNode.draggable(true); // ★親のドラッグ許可を戻す
    recordHistory('Group resized');
  });


  // --- 2. グループ本体のドラッグロジック ---

  groupNode.on('dragstart', (e) => {
    // 万が一ハンドルがターゲットなら何もしない（念の為のガード）
    if (e.target.name() === 'resize-handle') {
      e.cancelBubble = true;
      return;
    }
    previousPos = groupNode.position();
  });

  groupNode.on('dragmove', (e) => {
    if (e.target.name() === 'resize-handle') return;

    const currentPos = groupNode.position();
    const dx = currentPos.x - previousPos.x;
    const dy = currentPos.y - previousPos.y;

    // 子ノード連動移動
    const childIds = groupNode.getAttr('childNodeIds') || [];
    childIds.forEach((childId: string) => {
      const child = layer.findOne('#' + childId) as Konva.Group;
      if (child) {
        child.x(child.x() + dx);
        child.y(child.y() + dy);
        updateConnectedLinks(child);
      }
    });
    previousPos = currentPos;
  });

  groupNode.on('dragend', (e) => {
    if (e.target.name() === 'resize-handle') return;
    recordHistory('Group moved');
  });

  // タイトル編集
  titleText.on('dblclick', (e) => {
    e.cancelBubble = true; // 親のダブルクリック（新規作成）を防ぐ
    startGroupTitleEditing(titleText);
  });

  return groupNode;
}

function createSingleLink(fromNode: Konva.Group, toNode: Konva.Group, type: LinkType = LinkType.ARROW) {
  const id = `link_${generateUUID()}`;
  const colors = getCurrentThemeColors();
  const linkColor = colors.link;

  const linkGroup = new Konva.Group({
    name: 'link-group',
    id: id,
    fromNodeId: fromNode.id(),
    toNodeId: toNode.id(),
    linkType: type
  });

  linkGroup.setAttr('nodes', [fromNode, toNode]);

  // --- 線の生成 ---
  // hitStrokeWidth (当たり判定の太さ) を追加してクリックしやすくする
  if (type === LinkType.LINE) {
    linkGroup.add(new Konva.Line({
      stroke: linkColor, strokeWidth: 2, name: 'link-shape', hitStrokeWidth: 15
    }));
  } else if (type === LinkType.ARROW) {
    linkGroup.add(new Konva.Arrow({
      points: [0, 0, 10, 10], // 必須なのでとりあえずダミーを入れる
      stroke: linkColor,
      fill: linkColor,
      strokeWidth: 2,
      pointerLength: 10,
      pointerWidth: 10,
      name: 'link-shape',
      hitStrokeWidth: 15
    }));
  } else if (type === LinkType.DOUBLE_ARROW) {
    linkGroup.add(new Konva.Arrow({
      points: [0, 0, 10, 10],
      stroke: linkColor,
      fill: linkColor,
      strokeWidth: 2,
      pointerLength: 10,
      pointerWidth: 10,
      name: 'link-shape-1',
      hitStrokeWidth: 15
    }));
    linkGroup.add(new Konva.Arrow({
      points: [0, 0, 10, 10],
      stroke: linkColor,
      fill: linkColor,
      strokeWidth: 2,
      pointerLength: 10,
      pointerWidth: 10,
      name: 'link-shape-2',
      hitStrokeWidth: 15
    }));
  }

  // ラベルオブジェクトを生成 (Konva.Labelは背景とテキストをまとめるコンテナ)
  const labelGroup = new Konva.Label({
    name: 'link-label-group',
    visible: false // 初期は非表示
  });

  // TagがTextの背景として自動でリサイズされる
  labelGroup.add(new Konva.Tag({
    fill: colors.labelBackground,
    cornerRadius: 3,
    name: 'link-label-bg'
  }));

  labelGroup.add(new Konva.Text({
    text: '',
    fontSize: 14,
    fontFamily: "serif-ja, serif",
    fill: linkColor, // 文字色もリンク色と同じ
    padding: 5,
    name: 'link-label',
  }));

  // メインのlinkGroupに追加
  linkGroup.add(labelGroup);

  layer.add(linkGroup);
  linkGroup.moveToBottom();
  updateLinkPoints(linkGroup);

  // ホバー時に線を太くする
  linkGroup.on('mouseenter', () => {
    document.body.style.cursor = 'pointer'; // カーソルを指マークに
    linkGroup.find('Line, Arrow').forEach((shape: any) => {
      shape.strokeWidth(4); // 線を太くする
    });
    layer.batchDraw();
  });

  linkGroup.on('mouseleave', () => {
    document.body.style.cursor = 'default'; // カーソルを元に
    linkGroup.find('Line, Arrow').forEach((shape: any) => {
      shape.strokeWidth(2); // 線の太さを元に
    });
    layer.batchDraw();
  });

  return linkGroup;
}

function manageLink(clickedNode: Konva.Group, type: LinkType) {
  // すでに選択済みなら解除
  if (selectedNodes.includes(clickedNode)) {
    selectedNodes = selectedNodes.filter(n => n !== clickedNode);
    // 選択解除されたノードの見た目を元に戻す
    const bg = clickedNode.findOne('.background') as Konva.Rect;
    if (bg) {
      bg.fill('transparent');
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
    const isDuplicate = layer.find('.link-group').some((linkGroup: any) => {
      const fromId = linkGroup.getAttr('fromNodeId');
      const toId = linkGroup.getAttr('toNodeId');
      return (fromId === node1.id() && toId === node2.id()) || (fromId === node2.id() && toId === node1.id());
    });

    if (!isDuplicate) {
      createSingleLink(node1, node2, type);
      recordHistory('Link created');
    } else {
      console.log('Link already exists.');
    }

    deselectAll();
  }
}

function updateConnectedLinks(node: Konva.Group) {
  // 全リンクを走査して、このノードに繋がっているものだけ更新
  // (効率化のため。数が多い場合はキャッシュMapを使うのが定石だが今回はシンプルに)
  const links = layer.find('.link-group');
  links.forEach((linkGroup: any) => {
    const nodes = linkGroup.getAttr('nodes');
    if (nodes && (nodes[0] === node || nodes[1] === node)) {
      updateLinkPoints(linkGroup);
    }
  });
  layer.batchDraw();
}

function updateLinkPoints(linkGroup: Konva.Group) {
  let nodes = linkGroup.getAttr('nodes');

  // Undo後の復元ロジック
  if (!nodes || nodes.length < 2) {
    const fromId = linkGroup.getAttr('fromNodeId');
    const toId = linkGroup.getAttr('toNodeId');
    const fromNode = layer.findOne('#' + fromId);
    const toNode = layer.findOne('#' + toId);

    if (fromNode && toNode) {
      nodes = [fromNode, toNode];
      linkGroup.setAttr('nodes', nodes);
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

  const type = linkGroup.getAttr('linkType');
  if (type === LinkType.DOUBLE_ARROW) {
    // 双方向の場合は2本の矢印を逆向きにセット
    const arrow1 = linkGroup.findOne('.link-shape-1') as Konva.Arrow;
    const arrow2 = linkGroup.findOne('.link-shape-2') as Konva.Arrow;
    if (arrow1) arrow1.points([start.x, start.y, end.x, end.y]);
    if (arrow2) arrow2.points([end.x, end.y, start.x, start.y]); // 逆向き！
  } else {
    // 通常の線または片道矢印
    const shape = linkGroup.findOne('.link-shape') as Konva.Line;
    if (shape) shape.points([start.x, start.y, end.x, end.y]);
  }

  // --- ラベルの位置と表示状態の更新 ---
  const labelGroup = linkGroup.findOne('.link-label-group') as Konva.Label;
  const labelText = linkGroup.findOne('.link-label') as Konva.Text;

  if (labelGroup && labelText) {
    const text = labelText.text();

    // 1. 空文字なら隠して終了
    if (!text || text.trim() === '') {
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
        y: midY - height / 2
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
  const stageBox = document.getElementById('ip-container')!.getBoundingClientRect();
  let areaLeft = 0;
  let areaTop = 0;

  // リンクの形状（矢印/線）を取得して端点を再計算
  const arrow = linkGroup.findOne('.link-shape') || linkGroup.findOne('.link-shape-1');
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

  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);

  // 初期値
  textarea.value = labelText.text();

  // スタイル設定（スクロールバーなし、自動サイズ）
  textarea.style.position = 'absolute';
  textarea.style.left = areaLeft + 'px';
  textarea.style.top = areaTop + 'px';

  // フォントスタイル同期
  const color = getCurrentThemeColors();
  textarea.style.fontSize = '12px';
  textarea.style.fontFamily = labelText.fontFamily();
  textarea.style.lineHeight = '1em';
  textarea.style.color = color.text;
  textarea.style.background = color.labelBackground;
  textarea.style.border = '1px solid ' + color.text;
  textarea.style.outline = 'none';
  textarea.style.overflow = 'hidden';
  textarea.style.borderRadius = '3px';
  textarea.style.minWidth = '80px';
  textarea.style.zIndex = '500';

  // サイズ自動調整関数
  const updateSize = () => {
    textarea.style.width = '0px'; // 一旦縮める
    textarea.style.height = '0px';
    textarea.style.width = (Math.max(40, textarea.scrollWidth) + 2) + 'px';
    textarea.style.height = (textarea.scrollHeight + 2) + 'px';
  };
  updateSize(); // 初期サイズ

  textarea.focus();

  const removeTextarea = () => {
    if (!textarea.parentNode) return;
    const newVal = textarea.value;

    // 値を更新
    if (newVal !== labelText.text()) {
      labelText.text(newVal);
      recordHistory('Label edited');
    }

    // ここで updateLinkPoints を呼ぶことで
    // 「空なら非表示」「文字があれば表示＆位置調整」が自動で行われる
    updateLinkPoints(linkGroup);

    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener('input', updateSize);
  // Ctrl+Enter で確定、Esc でキャンセル
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === 'Escape') removeTextarea();
  });

  textarea.addEventListener('blur', removeTextarea);
}

function startGroupTitleEditing(titleText: Konva.Text) {
  if (isTextEditing) return;
  isTextEditing = true;

  // Konva側のテキストを隠す
  titleText.hide();
  layer.batchDraw();

  const areaPosition = titleText.getAbsolutePosition();
  const stageBox = document.getElementById('ip-container')!.getBoundingClientRect();
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);

  const color = getCurrentThemeColors();

  textarea.value = titleText.text();
  textarea.style.position = 'absolute';
  textarea.style.left = (stageBox.left + areaPosition.x) + 'px';
  textarea.style.top = (stageBox.top + areaPosition.y) + 'px';
  textarea.style.background = color.labelBackground;
  textarea.style.color = color.text;
  textarea.style.border = '1px solid ' + color.text;
  textarea.style.outline = 'none';
  textarea.style.fontFamily = titleText.fontFamily();
  textarea.style.zIndex = '500';
  textarea.style.overflow = 'hidden';
  textarea.focus();

  // 初期サイズ計算
  const updateSize = () => {
    textarea.style.width = 'auto';
    textarea.style.height = 'auto';
    textarea.style.width = (textarea.scrollWidth + 10) + 'px';
    textarea.style.height = (textarea.scrollHeight) + 'px';
  };
  updateSize();

  textarea.focus();

  const removeTextarea = () => {
    if (!textarea.parentNode) return;
    const newVal = textarea.value;
    if (newVal !== titleText.text()) {
      titleText.text(newVal);
      recordHistory('Group title edited');
    }
    titleText.show();
    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener('input', updateSize); // 入力時にサイズ更新

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === 'Escape') removeTextarea();
  });
  textarea.addEventListener('blur', removeTextarea);
}

// --- テンプレート用ノード作成ヘルパー ---
function createTemplateNode(options: { x: number, y: number, title: string, placeholder: string }) {
  // 既存の createNewNode を利用
  const node = createNewNode(options.x, options.y, options.title, false);

  // テンプレート属性を追加
  node.setAttr('isTemplateItem', true);
  node.setAttr('placeholder', options.placeholder);

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
  if (templateName === 'greimas') {
    const group = createGroupNode(offsetX + 110, offsetY + 100, '行為者モデル');
    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) { bg.width(650); bg.height(350); }

    // ノード定義 (相対座標を考慮して配置)
    const startX = offsetX;
    const startY = offsetY;
    const sujet = createTemplateNode({ x: startX + 400, y: startY + 320, title: '主体', placeholder: '主人公' });
    const objet = createTemplateNode({ x: startX + 400, y: startY + 170, title: '対象', placeholder: '主人公の目的' });
    const destinateur = createTemplateNode({ x: startX + 170, y: startY + 170, title: '送り手', placeholder: '依頼人など' });
    const destinataire = createTemplateNode({ x: startX + 630, y: startY + 170, title: '受け手', placeholder: '利益を得る存在' });
    const adjuvant = createTemplateNode({ x: startX + 170, y: startY + 320, title: '援助者', placeholder: '仲間や道具' });
    const opposant = createTemplateNode({ x: startX + 630, y: startY + 320, title: '敵対者', placeholder: '妨害する者' });

    // グループへの登録
    const nodes = [sujet, objet, destinateur, destinataire, adjuvant, opposant];
    const childIds = nodes.map(n => n.id());
    group.setAttr('childNodeIds', childIds);
    updateGroupMembersAppearance(group, false); // 念のため色更新

    // リンク作成
    const linkOpts = { type: LinkType.ARROW };
    createSingleLink(sujet, objet, LinkType.ARROW);
    createSingleLink(destinateur, objet, LinkType.ARROW);
    createSingleLink(objet, destinataire, LinkType.ARROW);
    createSingleLink(adjuvant, sujet, LinkType.ARROW);
    createSingleLink(opposant, sujet, LinkType.ARROW);

    recordHistory('Template created: Greimas');
  }

  // --- 2. 英雄の旅 (Hero's Journey) ---
  else if (templateName === 'heros-journey') {
    const group = createGroupNode(offsetX + 50, offsetY + 50, "英雄の旅 (Hero's Journey)");
    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) { bg.width(900); bg.height(700); }

    const steps = 12;
    const cx = offsetX + 450;
    const cy = offsetY + 350;
    const rx = 380;
    const ry = 280;

    const journeyData = [
      { title: '1. 日常の世界', placeholder: '主人公の日常' },
      { title: '2. 冒険への誘い', placeholder: '事件の発生' },
      { title: '3. 冒険の拒絶', placeholder: 'ためらい' },
      { title: '4. 賢者との出会い', placeholder: '導き手' },
      { title: '5. 第一関門突破', placeholder: '決意' },
      { title: '6. 試練、仲間、敵', placeholder: '新しい世界' },
      { title: '7. 最も危険な場所', placeholder: '核心へ' },
      { title: '8. 最大の試練', placeholder: '死と再生' },
      { title: '9. 報酬', placeholder: '手に入れたもの' },
      { title: '10. 帰路', placeholder: '日常への帰還路' },
      { title: '11. 復活', placeholder: '最後の戦い' },
      { title: '12. 帰還', placeholder: '変化した日常' },
    ];

    const createdNodes: Konva.Group[] = [];
    journeyData.forEach((data, i) => {
      const angle = (i / steps) * 2 * Math.PI - (Math.PI / 2);
      const nx = cx + rx * Math.cos(angle);
      const ny = cy + ry * Math.sin(angle);
      createdNodes.push(createTemplateNode({ x: nx, y: ny, title: data.title, placeholder: data.placeholder }));
    });

    group.setAttr('childNodeIds', createdNodes.map(n => n.id()));
    updateGroupMembersAppearance(group, false);

    for (let i = 0; i < createdNodes.length; i++) {
      const from = createdNodes[i];
      const to = createdNodes[(i + 1) % createdNodes.length];
      createSingleLink(from, to, LinkType.ARROW);
    }
    recordHistory("Template created: Hero's Journey");
  }

  // --- 3. ビートシート (Beat Sheet) ---
  else if (templateName === 'beat-sheet') {
    const group = createGroupNode(offsetX + 50, offsetY + 50, "エッセンシャル・ビートシート");
    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) { bg.width(1050); bg.height(550); }

    const beatData = [
      { title: '1. オープニング', placeholder: '' }, { title: '2. 事件の発生', placeholder: '' },
      { title: '3. 決意', placeholder: '' }, { title: '4. 新しい世界', placeholder: '' },
      { title: '5. 挫折', placeholder: '' }, { title: '6. 絶望', placeholder: '' },
      { title: '7. 転機', placeholder: '' }, { title: '8. 反撃', placeholder: '' },
      { title: '9. クライマックス', placeholder: '' }, { title: '10. 最後の障害', placeholder: '' },
      { title: '11. 決着', placeholder: '' }, { title: '12. エンディング', placeholder: '' },
    ];
    // 相対座標定義 (Electron版準拠 + オフセット)
    const positions = [
      { x: 79, y: 103 }, { x: 303, y: 146 }, { x: 510, y: 107 }, { x: 711, y: 68 },
      { x: 902, y: 156 }, { x: 798, y: 338 }, { x: 537, y: 278 }, { x: 284, y: 291 },
      { x: 87, y: 393 }, { x: 237, y: 518 }, { x: 505, y: 472 }, { x: 815, y: 494 },
    ];

    const createdNodes: Konva.Group[] = [];
    beatData.forEach((data, i) => {
      const p = positions[i];
      createdNodes.push(createTemplateNode({
        x: offsetX + p.x, y: offsetY + p.y, title: data.title, placeholder: data.placeholder
      }));
    });

    group.setAttr('childNodeIds', createdNodes.map(n => n.id()));
    updateGroupMembersAppearance(group, false);

    for (let i = 0; i < 11; i++) {
      createSingleLink(createdNodes[i], createdNodes[i + 1], LinkType.ARROW);
    }
    recordHistory("Template created: Beat Sheet");
  }

  // --- 4. 三幕構成 ---
  else if (templateName === 'three-act-structure') {
    const group = createGroupNode(offsetX + 100, offsetY + 100, "三幕構成");
    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) { bg.width(800); bg.height(250); }

    const actData = [
      { title: '第一幕：発端', placeholder: '' },
      { title: '第二幕：葛藤', placeholder: '' },
      { title: '第三幕：結末', placeholder: '' },
    ];

    const createdNodes: Konva.Group[] = [];
    actData.forEach((data, i) => {
      createdNodes.push(createTemplateNode({
        x: offsetX + 150 + i * 250, y: offsetY + 150, title: data.title, placeholder: data.placeholder
      }));
    });

    group.setAttr('childNodeIds', createdNodes.map(n => n.id()));
    updateGroupMembersAppearance(group, false);

    createSingleLink(createdNodes[0], createdNodes[1], LinkType.ARROW);
    createSingleLink(createdNodes[1], createdNodes[2], LinkType.ARROW);
    recordHistory("Template created: Three-Act Structure");
  }

  layer.batchDraw();
}

// =================================================================
// 7. 数学・ヘルパー関数
// =================================================================

function getClientRect(node: Konva.Group) {
  const bg = node.findOne('.background') as Konva.Rect;
  return {
    x: node.x(),
    y: node.y(),
    width: bg ? bg.width() : 150,
    height: bg ? bg.height() : 100
  };
}

function getIntersections(r1: any, r2: any) {
  const c1 = { x: r1.x + r1.width / 2, y: r1.y + r1.height / 2 };
  const c2 = { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };

  const intersect = (w: number, h: number, from: Vector2d, to: Vector2d): Vector2d => {
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
    end: intersect(r2.width, r2.height, c2, c1)
  };
}

function generateUUID() {
  return window.crypto.randomUUID();
}

function setupKeyboardEvents() {
  document.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const isControl = e.ctrlKey;
    const isCmd = e.metaKey;

    if (isCtrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    if ((isCtrl && key === 'y') || (isCtrl && e.shiftKey && key === 'z')) {
      e.preventDefault();
      redo();
    }
    // 閉じる (Ctrl + I)
    if (isCtrl && key === 'i' && !e.shiftKey) {
      e.preventDefault();
      IPClose();
    }
    // テーマ切り替え (Ctrl + T)
    if (isCtrl && key === 't') {
      e.preventDefault();
      IPThemeToggle();
    }
    if (isCtrl && key === 'o') {
      e.preventDefault();
      loadFromMrsd();
    }
    if (isCtrl && key === 'n') {
      e.preventDefault();
      newFile();
    }
    if (isCtrl && key === 'r') {
      e.preventDefault();
      InitializeStage();
    }

    // フルスクリーン切り替え
    // Mac: Cmd + Ctrl + F
    // Win: F11
    if (osType === 'macos') {
      if (isCmd && isControl && key === 'f') {
        e.preventDefault();
        IPToggleFullscreen();
      }
    } else {
      if (key === 'f11') {
        e.preventDefault();
        IPToggleFullscreen();
      }
    }
    // --- 削除機能 ---
    if ((key === 'delete' || key === 'backspace') && !isTextEditing) {
      if (selectedShape) {
        e.preventDefault();

        if (selectedShape.name() === 'node-group') {
          // ノードを消す場合、繋がっているリンクもすべて巻き添えにする
          const links = layer.find('.link-group');
          links.forEach((link: any) => {
            const nodes = link.getAttr('nodes');
            if (nodes && (nodes[0] === selectedShape || nodes[1] === selectedShape)) {
              link.destroy();
            }
          });
        }

        selectedShape.destroy(); // 本体を削除
        deselectAll();           // 選択状態クリア
        recordHistory('Deleted');
      }
    }
  });
}

function startTextEditing(textNode: Konva.Text, group: Konva.Group, isNew = false) {
  if (isTextEditing) return;
  isTextEditing = true;

  textNode.hide();
  layer.batchDraw();

  const isDarkMode = document.body.classList.contains('dark-mode');

  const textPosition = textNode.getAbsolutePosition();
  const stageBox = document.getElementById('ip-container')!.getBoundingClientRect();
  const areaPosition = {
    x: stageBox.left + textPosition.x,
    y: stageBox.top + textPosition.y,
  };

  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);

  textarea.value = textNode.text();
  textarea.style.position = 'absolute';
  textarea.style.top = areaPosition.y + 'px';
  textarea.style.left = areaPosition.x + 'px';

  const padding = textNode.padding();
  textarea.style.width = (textNode.width() - padding * 2) + 'px';
  textarea.style.height = (textNode.height() - padding * 2 + Math.round(textNode.fontSize() * 1.5)) + 'px';

  textarea.style.fontSize = textNode.fontSize() + 'px';
  textarea.style.fontFamily = textNode.fontFamily();
  textarea.style.lineHeight = textNode.lineHeight().toString();
  textarea.style.textAlign = textNode.align();

  // テーマの文字色を適用
  textarea.style.color = isDarkMode ? themes.dark.text : 'var(--editor-text-color, #111111)';
  // グロー効果（CSSのtext-shadow）を適用
  if (document.body.classList.contains('custom-glow')) {
    textarea.style.textShadow = 'var(--custom-text-shadow)';
  } else {
    textarea.style.textShadow = 'none';
  }
  textarea.style.background = 'none'; // 背景透明
  textarea.style.border = 'none';     // 枠線なし
  textarea.style.outline = 'none';
  textarea.style.resize = 'none';
  textarea.style.padding = padding + 'px';
  textarea.style.margin = '0px';
  textarea.style.overflow = 'hidden';
  textarea.style.zIndex = '500';

  textarea.focus();

  // 新規なら全選択、既存なら末尾へ
  if (isNew) {
    textarea.select();
  } else {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  const removeTextarea = () => {
    if (!textarea.parentNode) return;

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
      recordHistory('Node created');
    } else if (newVal !== oldText) {
      // 既存編集は変更があった場合のみ
      recordHistory('Node text changed');
    }

    textNode.show();
    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  // --- 入力中の処理 ---
  // ここでは textarea の見た目だけを広げる (Konvaノードはいじらない)
  textarea.addEventListener('input', () => {
    textarea.style.width = '0px'; // Shrink to fit
    textarea.style.height = '0px';
    textarea.style.width = (textarea.scrollWidth) + 'px';
    textarea.style.height = (textarea.scrollHeight) + 'px';
    textarea.style.minWidth = '150px';
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === 'Escape') removeTextarea();
  });

  textarea.addEventListener('blur', removeTextarea);
}

// --- 現在のテーマカラーを動的に取得するヘルパー ---
function getCurrentThemeColors() {
  const isDark = document.body.classList.contains('dark-mode');
  // ダークモードならカスタム設定を無視して固定値を返す
  if (isDark) {
    return themes.dark;
  }

  // :root (documentElement) のインラインスタイルから直接読み取る
  const inlineStyle = document.documentElement.style;
  const customText = inlineStyle.getPropertyValue('--editor-text-color').trim();
  const customSelection = inlineStyle.getPropertyValue('--editor-selection-color').trim();
  const customHeading = inlineStyle.getPropertyValue('--heading-color').trim();
  const customBg = inlineStyle.getPropertyValue('--window-bg-color').trim();
  const customEdBg = inlineStyle.getPropertyValue('--editor-bg-color').trim();

  return {
    text: customText || themes.light.text,
    link: customText || themes.light.text, // リンクはテキストに合わせる
    selection: customSelection || themes.light.selection,
    nodeBg: customEdBg || themes.light.nodeBg,
    labelBackground: customBg || themes.light.labelBackground,
    heading: customHeading || themes.light.heading
  };
}

// --- 選択状態のリセット ---
function deselectAll() {
  const colors = getCurrentThemeColors();

  // ハイライト解除
  stage.find('.node-group').forEach((node: any) => {
    const bg = node.findOne('.background');
    if (bg) {
      bg.fill(colors.nodeBg);
      bg.strokeEnabled(false);
    }
  });

  // リンクと矢印を正しい色に戻す
  stage.find('.link-group').forEach((link: any) => {
    link.find('Line, Arrow').forEach((shape: any) => {
      shape.stroke(colors.link);
      shape.fill(colors.link);
    });
  });

  stage.find('.container-group').forEach((group: any) => {
    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) {
      bg.stroke(colors.text);
      bg.fill(colors.nodeBg);
      bg.dash([5, 5]);
    }
    // ハンドルを隠す
    const handle = group.findOne('.resize-handle') as Konva.Circle;
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

  if (shape.name() === 'node-group') {
    // ノードの場合：背景を塗る
    const bg = shape.findOne('.background') as Konva.Rect;
    if (bg) {
      bg.strokeEnabled(false);
      bg.fill(colors.selection);
    }
  } else if (shape.name() === 'container-group') {
    const bg = shape.findOne('.group-bg') as Konva.Rect;
    if (bg) {
      bg.stroke(colors.selection);
      bg.fill(colors.selection);
      bg.dash([]);
      const handle = shape.findOne('.resize-handle') as Konva.Circle;
      if (handle) {
        handle.fill(colors.selection);
        handle.visible(true); // 選択時は必ず表示
      }
    }
  } else if (shape.name() === 'link-group') {
    // リンクの場合：線とアローヘッドを塗る
    shape.find('Line, Arrow').forEach((s: any) => {
      s.stroke(colors.heading); // 線の色
      s.fill(colors.heading);   // アローヘッドの中身
    });
  }
}

function updateGroupMembersAppearance(groupNode: Konva.Group, isSelected: boolean) {
  const colors = getCurrentThemeColors();
  const childIds = groupNode.getAttr('childNodeIds') || [];

  childIds.forEach((id: string) => {
    const node = layer.findOne('#' + id) as Konva.Group;
    if (node) {
      const bg = node.findOne('.background') as Konva.Rect;
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

  if (shape.name() === 'node-group') {
    transformer.nodes([shape]);
    selectedNodes = [shape];

  } else if (shape.name() === 'container-group') {
    // グループノードの選択処理
    transformer.nodes([]); // グループにはTransformerをつけない
    selectedNodes = []; // グループ自体は複数選択の対象にしない（単独扱い）

    // ハンドルを表示
    const handle = shape.findOne('.resize-handle') as Konva.Circle;
    if (handle) handle.visible(true);

    // 登録済みノードの色を更新（メンバーであることを示す）
    updateGroupMembersAppearance(shape, true);

  } else if (shape.name() === 'link-group') {
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
  const isDark = document.body.classList.contains('dark-mode');
  const colors = getCurrentThemeColors();

  // グロー設定の取得
  const enableGlow = (!isDark && (await store.get<boolean>('enableGlow')) === true);
  const gColor = await store.get<string>('glowColor') || 'rgba(0, 255, 65, 0.5)';
  const gRadius = await store.get<number>('glowRadius') || 5;

  // --- ノードの更新 ---
  stage.find('.node-group').forEach((group: any) => {
    const textNode = group.findOne('.text') as Konva.Text;
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
  stage.find('.link-group').forEach((group: any) => {
    // 線の色
    group.find('Line, Arrow').forEach((shape: any) => {
      shape.stroke(colors.link);
      shape.fill(colors.link);
    });

    // ラベルのテキスト色と影
    const labelText = group.findOne('.link-label') as Konva.Text;
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
    const labelBg = group.findOne('.link-label-bg') as Konva.Rect;
    if (labelBg) {
      labelBg.fill(colors.labelBackground);
    }
  });

  stage.find('.container-group').forEach((group: any) => {
    // もしこのグループが「選択中」なら、テーマ色で上書きせず選択色を維持する
    const isSelected = (selectedShape === group);

    const bg = group.findOne('.group-bg') as Konva.Rect;
    if (bg) {
      // 選択中なら selection、そうでなければ text 色
      bg.stroke(isSelected ? colors.selection : colors.text);
    }

    const title = group.findOne('.group-title') as Konva.Text;
    if (title) {
      title.fill(colors.text);
    }
  });

  layer.batchDraw();
}

// --- セーブ処理 (saveToMrsd) ---
async function saveToMrsd(forceSaveAs = false) {
  let savePath = currentFilePath;

  if (!savePath || forceSaveAs) {
    const selected = await save({
      filters: [{ name: 'MirrorShard Data', extensions: ['mrsd'] }]
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
    const groupPosMap = new Map<string, { x: number, y: number }>();
    const nodeParentMap = new Map<string, string>();

    stage.find<Konva.Group>('.container-group').forEach(group => {
      const bg = group.findOne('.group-bg') as Konva.Rect;
      const title = group.findOne('.group-title') as Konva.Text;
      const childIds = group.getAttr('childNodeIds') || [];

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
          isTemplateRoot: false
        });
      }
    });

    // 2. ノード情報の抽出 (相対座標変換)
    const nodes: MrsdNode[] = [];

    stage.find<Konva.Group>('.node-group').forEach(node => {
      const bg = node.findOne('.background') as Konva.Rect;
      const textNode = node.findOne('.text') as Konva.Text;
      if (!bg || !textNode) return;

      const content = textNode.text();
      const safeTitle = content.split('\n')[0].substring(0, 15).replace(/[\\/:*?"<>|]/g, "_") || "Untitled";
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
        type: 'file',
        file: `files/${fileName}`,
        x: saveX, // 相対座標または絶対座標
        y: saveY,
        width: bg.width(),
        height: bg.height(),
        title: content,
        parentId: parentId,
        isTemplateItem: false
      });

      if (filesFolder) {
        filesFolder.file(fileName, content);
      }
    });

    // 3. リンク情報の抽出 (変更なし)
    const edges: MrsdEdge[] = [];
    stage.find<Konva.Group>('.link-group').forEach(link => {
      const label = link.findOne('.link-label') as Konva.Text;
      edges.push({
        id: link.id(),
        fromNode: link.getAttr('fromNodeId'),
        toNode: link.getAttr('toNodeId'),
        label: label ? label.text() : '',
        type: link.getAttr('linkType')
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
        updatedAt: now
      }
    };

    zip.file("canvas.json", JSON.stringify(canvasData, null, 2));

    const content = await zip.generateAsync({ type: "uint8array" });
    await writeFile(savePath, content);

    currentFilePath = savePath;
    isDirty = false;
    projectMetadata = canvasData.metadata;

    console.log('Saved successfully to:', savePath);

  } catch (e) {
    console.error('Save failed:', e);
    alert('保存に失敗しました: ' + e);
  }
}

async function saveByBtn() { await saveToMrsd(true) }

// --- ロード処理 (loadFromMrsd) ---
async function loadFromMrsd() {
  if (isDirty) {
    const yes = await ask('変更が保存されていません。破棄して開きますか？', { title: '確認', kind: 'warning' });
    if (!yes) return;
  }

  const selected = await open({
    multiple: false,
    filters: [{ name: 'MirrorShard Data', extensions: ['mrsd'] }]
  });
  if (!selected) return;
  const path = selected as string;

  try {
    const binaryData = await readFile(path);
    const zip = await JSZip.loadAsync(binaryData);

    const canvasFile = zip.file("canvas.json");
    if (!canvasFile) throw new Error("Invalid format: canvas.json not found");
    const jsonStr = await canvasFile.async("string");
    const data: MrsdJson = JSON.parse(jsonStr);

    // 1. ステージ初期化
    if (transformer) transformer.destroy();
    layer.destroyChildren();
    transformer = new Konva.Transformer({
      visible: false, resizeEnabled: false, rotateEnabled: false, borderEnabled: false,
    });
    layer.add(transformer);
    selectedNodes = [];
    selectedShape = null;

    projectMetadata = data.metadata || { createdAt: new Date().toISOString() };

    // 2. グループ復元 & 座標マップ作成
    const groupIdMap = new Map<string, string[]>(); // GroupID -> ChildIDs
    const groupPosMap = new Map<string, { x: number, y: number }>(); // GroupID -> {x, y}

    if (data.groups) {
      data.groups.forEach((g) => {
        const groupNode = createGroupNode(g.x, g.y, g.label);
        groupNode.id(g.id);

        // サイズ復元
        const bg = groupNode.findOne('.group-bg') as Konva.Rect;
        const handle = groupNode.findOne('.resize-handle') as Konva.Circle;
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
      let content = n.title || "";
      if (n.file) {
        const mdFile = zip.file(n.file);
        if (mdFile) {
          const mdText = await mdFile.async("string");
          if (mdText) content = mdText;
        }
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

      const nodeGroup = createNewNode(finalX, finalY, content, false);
      nodeGroup.id(n.id);

      // サイズ自動調整
      adjustNodeSize(nodeGroup);

      // 所属マップへの登録
      if (n.parentId && groupIdMap.has(n.parentId)) {
        groupIdMap.get(n.parentId)?.push(n.id);
      }
    }

    // 4. グループ所属情報の適用 (childNodeIds)
    groupIdMap.forEach((childIds, groupId) => {
      const groupNode = layer.findOne('#' + groupId) as Konva.Group;
      if (groupNode) {
        groupNode.setAttr('childNodeIds', childIds);
      }
    });

    // 5. リンク復元
    if (data.edges) {
      data.edges.forEach((e) => {
        const fromNode = layer.findOne('#' + e.fromNode) as Konva.Group;
        const toNode = layer.findOne('#' + e.toNode) as Konva.Group;

        let linkType = LinkType.ARROW;
        if (e.type === 'double_arrow') linkType = LinkType.DOUBLE_ARROW;
        else if (e.type === 'line') linkType = LinkType.LINE;

        if (fromNode && toNode) {
          const linkGroup = createSingleLink(fromNode, toNode, linkType);
          if (linkGroup) {
            linkGroup.id(e.id);
            if (e.label) {
              const labelText = linkGroup.findOne('.link-label') as Konva.Text;
              if (labelText) labelText.text(e.label);
            }
          }
        }
      });
    }

    // 6. 仕上げ: リンク端点計算 & 空ラベル非表示
    stage.find('.link-group').forEach((linkGroup: any) => {
      updateLinkPoints(linkGroup);
    });

    await updateAllNodesAppearance();

    layer.batchDraw();
    currentFilePath = path;
    isDirty = false;
    history = [];
    recordHistory('Loaded .mrsd');

    console.log(`Loaded from: ${path}`);

  } catch (e) {
    console.error('Load failed:', e);
    alert('読み込みに失敗しました: ' + e);
  }
}

async function newFile() {
  if (isDirty) {
    const yes = await ask('変更が保存されていません。破棄して新規作成しますか？', { title: '確認', kind: 'warning' });
    if (!yes) return;
  }

  // 全クリア
  layer.destroyChildren();
  if (transformer) transformer.destroy();
  transformer = new Konva.Transformer({ visible: false, resizeEnabled: false, rotateEnabled: false, borderEnabled: false });
  layer.add(transformer);

  // ステージ位置とズームをリセット
  stage.position({ x: 0, y: 0 });
  stage.scale({ x: 1, y: 1 });

  layer.batchDraw();

  currentFilePath = null;
  isDirty = false;
  history = [];
  recordHistory('Initial Empty State');
  console.log('New file created');
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

// --- 変更通知関数 ---
function markAsDirty() {
  if (!isDirty) {
    isDirty = true;
    // 必要ならタイトルバーに「*」をつけるなどの処理をここに追加
    // updateTitle(); 
  }
}

// =================================================================
// 8. ウィンドウ制御とテーマ管理 (Window & Theme & Settings)
// =================================================================

// ■ 初期化時に呼び出すセットアップ関数
async function setupWindowFeatures() {
  osType = await type();

  // ストアの初期化
  store = await Store.load('.settings.dat');

  // 1. 各種ボタンのイベント登録
  setupUIButtons();

  // 2. リスナーのセットアップ
  setupThemeListener();
  setupSettingsListener();

  // 3. 初期状態の適用（ストアから読み込んで反映）
  await applyInitialSettings();
}

// ■ UIボタンのイベント登録
function setupUIButtons() {
  document.getElementById('ip-toggle-on-top-btn')?.addEventListener('click', IPToggleOnTop);
  document.getElementById('ip-close-btn')?.addEventListener('click', IPClose);
  document.getElementById('ip-fullscreen-btn')?.addEventListener('click', IPToggleFullscreen);
  document.getElementById('ip-theme-toggle-btn')?.addEventListener('click', IPThemeToggle);
  document.getElementById('ip-create-group-button')?.addEventListener('click', createGroupNodeByButton);
  document.getElementById('ip-save-as-button')?.addEventListener('click', saveByBtn);
  document.getElementById('ip-load-button')?.addEventListener('click', loadFromMrsd);
  document.getElementById('ip-new-file-button')?.addEventListener('click', newFile);
  document.getElementById('ip-zoom-reset-btn')?.addEventListener('click', zoomReset);
  document.getElementById('ip-reset-window-btn')?.addEventListener('click', InitializeStage);
  // --- テンプレートメニュー制御 ---
  const templateBtn = document.getElementById('ip-template-button');
  const templateMenu = document.getElementById('ip-template-menu');

  if (templateBtn && templateMenu) {
    // ボタンクリックでメニュー開閉
    templateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log("jsidjfsdifjsd");
      templateMenu.classList.toggle('hidden');
    });

    // メニュー項目クリック
    templateMenu.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // closestで親のli要素などを探す
      const item = target.closest('[data-template]') as HTMLElement;

      if (item) {
        const tmplName = item.dataset.template;
        if (tmplName) {
          generateTemplate(tmplName);
        }
        templateMenu.classList.add('hidden');
      }
    });

    // メニュー外クリックで閉じる
    window.addEventListener('click', () => {
      if (!templateMenu.classList.contains('hidden')) {
        templateMenu.classList.add('hidden');
      }
    });
  }
}

// ■ 初期設定の適用
async function applyInitialSettings() {
  if (!store) return;

  // 1. ストアからテーマを読み込んで適用
  const isDark = await store.get<boolean>('isDarkMode');
  if (isDark) document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');

  // 2. カスタムカラーのCSS変数適用
  const root = document.documentElement.style;
  const customWindowBg = await store.get<string>('customWindowBg');
  if (customWindowBg) root.setProperty('--window-bg-color', customWindowBg);
  const customEditorBg = await store.get<string>('customEditorBg');
  if (customEditorBg) root.setProperty('--editor-bg-color', customEditorBg);

  const customTextColor = await store.get<string>('customTextColor');
  if (customTextColor) root.setProperty('--editor-text-color', customTextColor);
  const customSelectionColor = await store.get<string>('customSelectionColor');
  if (customSelectionColor) root.setProperty('--editor-selection-color', customSelectionColor);
  const customHeadingColor = await store.get<string>('customHeadingColor');
  if (customHeadingColor) root.setProperty('--heading-color', customHeadingColor);

  // 3. グロー（CSS）と Konva の外観更新
  await applyGlowEffect();
  await updateAllNodesAppearance(); // ここでKonvaの初期色を決定
}

// ■ テーマ同期リスナー (app:theme-changed)
function setupThemeListener() {
  listen('app:theme-changed', async (event: any) => {
    const isDark = (typeof event.payload === 'object') ? event.payload.isDarkMode : event.payload;
    if (isDark) document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');

    await applyGlowEffect();
    await updateAllNodesAppearance(); // テーマ切り替え時にKonvaを一斉更新
  });
}

// ■ 設定変更リスナー (settings-changed)
function setupSettingsListener() {
  listen('settings-changed', async (event: any) => {
    const p = event.payload;

    // CSS変数の更新 (AIチャットウィンドウの仕様に準拠)
    const root = document.documentElement.style;

    if (p.customWindowBg !== undefined) {
      if (p.customWindowBg) root.setProperty('--window-bg-color', p.customWindowBg);
      else root.removeProperty('--window-bg-color');
    }
    if (p.customEditorBg !== undefined) {
      if (p.customEditorBg) root.setProperty('--editor-bg-color', p.customEditorBg);
      else root.removeProperty('--editor-bg-color');
    }
    if (p.userFontFamily !== undefined) {
      if (p.userFontFamily && p.userFontFamily !== 'default') {
        root.setProperty('--user-font-family', `"${p.userFontFamily}"`);
      } else {
        root.removeProperty('--user-font-family');
      }
    }
    if (p.customTextColor !== undefined) {
      if (p.customTextColor) {
        root.setProperty('--editor-text-color', p.customTextColor);
      } else {
        root.removeProperty('--editor-text-color');
      }
    }
    if (p.customSelectionColor !== undefined) {
      if (p.customSelectionColor) {
        root.setProperty('--editor-selection-color', p.customSelectionColor);
      } else {
        root.removeProperty('--editor-selection-color');
      }
    }
    if (p.customHeadingColor !== undefined) {
      if (p.customHeadingColor) {
        root.setProperty('--heading-color', p.customHeadingColor);
      } else {
        root.removeProperty('--heading-color');
      }
    }

    // グロー効果の更新判定
    if (p.enableGlow !== undefined || p.glowColor !== undefined || p.glowRadius !== undefined) {
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

  const enableGlow = await store.get<boolean>('enableGlow') ?? false;
  const glowColor = await store.get<string>('glowColor') || 'rgba(0, 255, 65, 0.5)';
  const glowRadius = await store.get<number>('glowRadius') || 5;

  const root = document.documentElement.style;
  const body = document.body;
  const isDark = body.classList.contains('dark-mode');

  // 「ライトモード(カスタムモード)」かつ「グロー有効」のときだけ発動
  if (!isDark && enableGlow) {
    body.classList.add('custom-glow');

    let shadowVal = "";
    const match = glowColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);

    if (match) {
      const r = match[1];
      const g = match[2];
      const b = match[3];
      const a = parseFloat(match[4] || '1');

      const shadow1 = `0 0 ${glowRadius}px rgba(${r}, ${g}, ${b}, ${a})`;
      const shadow2 = `0 0 ${glowRadius * 2}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.1)})`;
      const shadow3 = `0 0 ${glowRadius * 4}px rgba(${r}, ${g}, ${b}, ${Math.max(0, a - 0.2)})`;

      shadowVal = `${shadow1}, ${shadow2}, ${shadow3}`;
    } else {
      console.warn("Glow color parse failed, using simple shadow:", glowColor);
      shadowVal = `0 0 ${glowRadius}px ${glowColor}, 0 0 ${glowRadius * 2}px ${glowColor}`;
    }

    root.setProperty('--custom-text-shadow', shadowVal);
  } else {
    body.classList.remove('custom-glow');
    root.removeProperty('--custom-text-shadow');
  }
}

// ■ 閉じる処理
async function IPClose() {
  const window = getCurrentWindow();
  if (await window.isFullscreen()) {
    await window.setFullscreen(false);
  }
  window.close();
}

// ■ 最大化切り替え
async function IPToggleFullscreen() {
  isSimpleFullscreen = !isSimpleFullscreen;
  const wrapper = document.getElementById('ip-wrapper');
  await invoke('set_simple_fullscreen', { enable: isSimpleFullscreen });
  if (osType !== 'macos' && wrapper) {
    wrapper.style.borderRadius = isSimpleFullscreen ? '0px' : '6px';
  }
}

// ■ テーマ切り替え
async function IPThemeToggle() {
  await emit('subwindow-toggle-theme');
}

async function IPToggleOnTop() {
  const pinBtn = document.getElementById('ip-toggle-on-top-btn');
  if (!pinBtn) return;
  isPinned = !isPinned;
  await getCurrentWindow().setAlwaysOnTop(isPinned);
  if (isPinned) {
    pinBtn.classList.add('active');
    pinBtn.title = "固定を解除";
  } else {
    pinBtn.classList.remove('active');
    pinBtn.title = "最前面に固定";
  }
}

// ■グループノード作成ボタンの処理
async function createGroupNodeByButton() {
  // 画面中央あたりに生成
  const center = { x: window.innerWidth / 2 - 150, y: window.innerHeight / 2 - 100 };
  createGroupNode(center.x, center.y);
  recordHistory('Group created');
  layer.batchDraw();
}

// =================================================================
// 9. 起動処理
// =================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Konvaなどの初期化
  initializeIdeaProcessor();



  // 3. レンダリング安定待ち（履歴初期化）
  setTimeout(() => {
    if (history.length === 0) {
      recordHistory('Initial Empty State');
    }
  }, 100);

  // 4. リスナー準備完了後に、メインへ合図を送る
  console.log('[Tauri] Sending idea-processor-ready...');
  await emit('idea-processor-ready');
});
// @ts-nocheck
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { type } from '@tauri-apps/plugin-os';
import { resolveResource } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import Konva from 'konva';

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
let isPanning = false;
let didPan = false;
let lastPointerPosition: { x: number; y: number } = { x: 0, y: 0 };
let selectionStartPos: { x: number; y: number } | null = null;
let isDraggingSelection = false;
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

  // グループ機能は一旦空で返す（必要なら後で拡張）
  return { nodes: nodesData, links: linksData, groups: [] };
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

  // 4. 描画更新
  layer.batchDraw();
}

function createNodeFromData(data: any) {
  const isDarkMode = document.body.classList.contains('dark-mode');
  const colors = isDarkMode ? themes.dark : themes.light;

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
    fontFamily: "'Klee Custom', serif-ja, serif",
    fill: colors.text, // テーマに合わせた文字色（ライトなら黒系）
    padding: 8,
    width: data.width || 150,
    lineHeight: 1.2,
  });

  const backgroundRect = new Konva.Rect({
    name: 'background',
    x: 0,
    y: 0,
    width: data.width || 150,
    height: textNode.height(),
    fill: colors.nodeBg, // transparent（透明）
    cornerRadius: 10,
    // 枠線 (stroke) は描画しない
  });

  // 背面にRect、前面にTextを追加
  nodeGroup.add(backgroundRect);
  nodeGroup.add(textNode);
  layer.add(nodeGroup);

  return nodeGroup;
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
    }
  });

  stage.on('dblclick', (e) => {
    if (e.target === stage) {
      const pos = stage.getPointerPosition();
      if (pos) {
        createNewNode(pos.x, pos.y);
        recordHistory('Node created');
      }
      return;
    }

    // ノードのダブルクリック検知
    const nodeGroup = e.target.getParent();
    if (nodeGroup && nodeGroup.name() === 'node-group') {
      const textNode = nodeGroup.findOne('.text') as Konva.Text;
      if (textNode) startTextEditing(textNode, nodeGroup as Konva.Group);
      return;
    }

    // リンク（またはラベル）のダブルクリック検知を堅牢に
    let current = e.target;
    let linkGroup = null;
    while (current) {
      if (current.name() === 'link-group') {
        linkGroup = current;
        break;
      }
      current = current.getParent(); // 親を辿る
    }

    if (linkGroup) {
      const labelText = linkGroup.findOne('.link-label') as Konva.Text;
      if (labelText) {
        startLabelEditing(labelText, linkGroup as Konva.Group);
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

  // テキスト編集（ダブルクリック）
  stage.on('dblclick', (e) => {
    const group = e.target.getParent();
    if (group && group.name() === 'node-group') {
      const textNode = group.findOne('.text') as Konva.Text;
      if (textNode) {
        startTextEditing(textNode, group as Konva.Group);
      }
    }
  });

  // リンク作成モード（Alt + ドラッグ）などの実装
  // ここではシンプルに「Altキーを押しながらドラッグでリンク作成」を実装
  stage.on('mousedown', (e) => {
    const isAlt = e.evt.altKey;
    if (isAlt) {
      const group = e.target.getParent();
      if (group && group.name() === 'node-group') {
        // リンク作成開始
        startConnection(group as Konva.Group);
      }
    }
  });

  stage.on('mousemove', (e) => {
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

  stage.on('mouseup', (e) => {
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

function createNewNode(x: number, y: number, textStr = 'New Node') {
  const id = `node_${generateUUID()}`;
  const node = createNodeFromData({
    id, x, y, width: 120, height: 60, title: textStr
  });
  updateAllNodesAppearance();
  return node;
}

function createSingleLink(fromNode: Konva.Group, toNode: Konva.Group, type: LinkType = LinkType.ARROW) {
  const id = `link_${generateUUID()}`;
  const isDark = document.body.classList.contains('dark-mode');
  const colors = getCurrentThemeColors();
  const customTextColor = colors.text;
  const theme = isDark ? themes.dark : themes.light;
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
      stroke: linkColor, fill: linkColor, strokeWidth: 2, pointerLength: 10, pointerWidth: 10, name: 'link-shape', hitStrokeWidth: 15
    }));
  } else if (type === LinkType.DOUBLE_ARROW) {
    linkGroup.add(new Konva.Arrow({
      stroke: linkColor, fill: linkColor, strokeWidth: 2, pointerLength: 10, pointerWidth: 10, name: 'link-shape-1', hitStrokeWidth: 15
    }));
    linkGroup.add(new Konva.Arrow({
      stroke: linkColor, fill: linkColor, strokeWidth: 2, pointerLength: 10, pointerWidth: 10, name: 'link-shape-2', hitStrokeWidth: 15
    }));
  }

  // ★ ラベルオブジェクトを生成 (Konva.Labelは背景とテキストをまとめるコンテナ)
  const labelGroup = new Konva.Label({
    name: 'link-label-group',
    visible: false // 初期は非表示
  });

  // TagがTextの背景として自動でリサイズされる
  labelGroup.add(new Konva.Tag({
    fill: theme.labelBackground,
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
    const bg = clickedNode.findOne('.background');
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
    const shape = linkGroup.findOne('.link-shape') as Konva.Shape;
    if (shape) shape.points([start.x, start.y, end.x, end.y]);
  }

  // ラベル位置
  const labelGroup = linkGroup.findOne('.link-label-group') as Konva.Label;
  if (labelGroup) {
    const labelText = labelGroup.findOne('.link-label') as Konva.Text;
    const labelRect = labelGroup.findOne('.link-label-bg') as Konva.Rect;

    if (labelText && labelRect) {
      // テキストのサイズに合わせて背景のサイズを更新
      labelRect.width(labelText.width());
      labelRect.height(labelText.height());

      // ラベル全体の位置を線の中央に
      labelGroup.position({
        x: (start.x + end.x) / 2 - labelText.width() / 2,
        y: (start.y + end.y) / 2 - labelText.height() / 2
      });

      // テキストが空ならラベル自体を非表示にする
      labelGroup.visible(labelText.text().length > 0);
    }
  }
}

// --- ノードの枠サイズをテキストに合わせる機能 ---
function updateNodeSize(group: Konva.Group) {
  const textNode = group.findOne('.text') as Konva.Text;
  const bgRect = group.findOne('.background') as Konva.Rect;
  if (textNode && bgRect) {
    bgRect.width(textNode.width());
    bgRect.height(textNode.height());
    // 枠のサイズが変わるので、繋がっているリンクも再計算
    updateConnectedLinks(group);
  }
}

function startLabelEditing(labelText: Konva.Text, linkGroup: Konva.Group) {
  if (isTextEditing) return;
  isTextEditing = true;

  const labelGroup = labelText.getParent() as Konva.Label;

  // 編集中はラベルを隠す
  labelGroup.hide();
  layer.draw();

  const absPos = labelText.getAbsolutePosition();
  const stageBox = document.getElementById('ip-container')!.getBoundingClientRect();
  const areaPosition = {
    x: stageBox.left + absPos.x,
    y: stageBox.top + absPos.y,
  };

  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);

  // ... (textarea のスタイル設定は startTextEditing とほぼ同じ) ...
  const color = getCurrentThemeColors();
  textarea.value = labelText.text();
  textarea.style.position = 'absolute';
  textarea.style.top = areaPosition.y + 'px';
  textarea.style.left = areaPosition.x + 'px';
  textarea.style.minWidth = '50px';
  textarea.style.background = color.labelBackground; // 背景色を合わせる
  textarea.style.color = color.text;
  textarea.style.border = '1px solid color.text';
  textarea.style.outline = 'none';
  textarea.style.fontFamily = labelText.fontFamily();
  textarea.style.zIndex = 500;

  textarea.focus();

  const removeTextarea = () => {
    if (!textarea.parentNode) return;
    const newVal = textarea.value;
    if (newVal !== labelText.text()) {
      labelText.text(newVal);
      recordHistory('Label edited');
    }

    // 確定時にラベルの表示/非表示とサイズを更新
    updateLinkPoints(linkGroup);
    layer.batchDraw();

    document.body.removeChild(textarea);
    isTextEditing = false;
  };

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

function startTextEditing(textNode: Konva.Text, group: Konva.Group) {
  if (isTextEditing) return;
  isTextEditing = true;

  textNode.hide();
  layer.batchDraw();

  const isDarkMode = document.body.classList.contains('dark-mode');
  const colors = isDarkMode ? themes.dark : themes.light;

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
  textarea.style.padding = '5px';
  textarea.style.margin = '0px';
  textarea.style.overflow = 'hidden';

  textarea.focus();

  const removeTextarea = () => {
    if (!textarea.parentNode) return;
    const newVal = textarea.value;
    if (newVal !== textNode.text()) {
      textNode.text(newVal);
      // 枠のサイズを自動調整
      const bgRect = group.findOne('.background') as Konva.Rect;
      if (bgRect) {
        bgRect.width(textNode.width());
        bgRect.height(textNode.height());
      }
      updateConnectedLinks(group);
      recordHistory('Text edited');
    }
    textNode.show();
    layer.batchDraw();
    document.body.removeChild(textarea);
    isTextEditing = false;
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeTextarea();
    }
    if (e.key === 'Escape') removeTextarea();

    setTimeout(() => {
      textNode.text(textarea.value);
      const bgRect = group.findOne('.background') as Konva.Rect;
      if (bgRect) {
        bgRect.width(textNode.width());
        bgRect.height(textNode.height());
      }
      updateConnectedLinks(group);
      layer.batchDraw();
      textarea.style.width = (textNode.width() - padding * 2) + 'px';
      textarea.style.height = (textNode.height() - padding * 2 + Math.round(textNode.fontSize() * 1.5)) + 'px';
    }, 0);
  });

  textarea.addEventListener('blur', removeTextarea);
}

// --- 現在のテーマを取得するヘルパー ---
function getCurrentTheme() {
  const isDark = document.body.classList.contains('dark-mode');
  return themes[isDark ? 'dark' : 'light'];
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
      bg.fill(null);
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
    const bg = shape.findOne('.background');
    if (bg) {
      bg.strokeEnabled(false);
      bg.fill(colors.selection);
    }
  } else if (shape.name() === 'link-group') {
    // リンクの場合：線とアローヘッドを塗る
    shape.find('Line, Arrow').forEach((s: any) => {
      s.stroke(colors.heading); // 線の色
      s.fill(colors.heading);   // アローヘッドの中身
    });
  }
}

// --- 形状（ノードまたはリンク）の選択 ---
function selectShape(shape: Konva.Group) {
  deselectAll();
  selectedShape = shape;

  if (shape.name() === 'node-group') {
    transformer.nodes([shape]);
    selectedNodes = [shape];
  } else if (shape.name() === 'link-group') {
    // リンクはTransformerを付けず、色だけ変える
    transformer.nodes([]);
    selectedNodes = [];
  }

  // ハイライト適用
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

  layer.batchDraw();
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
  if (customHeadingColor) root.setProperty('--heading-color', customSelectionColor);

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

// =================================================================
// 9. 起動処理
// =================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Konvaなどの初期化
  initializeIdeaProcessor();

  // 2. ウィンドウ機能・リスナーのセットアップを待機
  //    (内部で await setupTauriListeners() しているので、これで受信準備完了)
  await setupWindowFeatures();

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
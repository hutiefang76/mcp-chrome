<template>
  <!-- rr-theme container provides CSS variables; data-theme for light/dark -->
  <div class="builder-page rr-theme" :data-theme="theme">
    <div v-if="fallbackNotice" class="notice-top">
      <span>已应用回退建议：提升 {{ fallbackNotice.type }} 优先级</span>
      <button class="mini" @click="undoFallbackPromotion">撤销</button>
    </div>

    <div class="main">
      <Canvas
        :nodes="store.nodes"
        :edges="store.edges"
        :node-errors="validation.nodeErrors"
        :focus-node-id="focusNodeId"
        :fit-seq="fitSeq"
        @select-node="store.selectNode"
        @select-edge="store.selectEdge"
        @duplicate-node="store.duplicateNode"
        @remove-node="store.removeNode"
        @connect-from="store.connectFrom"
        @connect="store.onConnect"
        @node-dragged="store.setNodePosition"
        @add-node-at="onAddNodeAt"
      />

      <div class="topbar rr-topbar backdrop-blur">
        <div class="left">
          <strong class="text-[var(--rr-text)]">{{ title }}</strong>
          <span class="tip">工作流可视化编排</span>
        </div>
        <div class="right">
          <button class="top-btn" @click="exportFlow" title="导出 JSON">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            导出
          </button>
          <label class="top-btn import" title="导入 JSON">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            导入
            <input type="file" accept="application/json" @change="onImport" />
          </label>
          <button class="top-btn" @click="openRename" title="重命名工作流">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Rename
          </button>
          <span class="divider-vert" />
          <button
            class="top-btn"
            :disabled="!selectedId"
            @click="runFromSelected"
            title="从选中节点回放"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            从选中运行
          </button>
          <button class="top-btn primary" @click="runAll" title="从头回放整流">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            运行
          </button>
          <span class="divider-vert" />
          <span class="status" :data-state="saveState">{{ saveLabel }}</span>

          <button class="top-btn success" @click="save">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            保存
          </button>
        </div>
      </div>

      <Sidebar
        class="floating-sidebar"
        :flow="store.flowLocal"
        :palette-types="store.paletteTypes"
        :subflow-ids="store.listSubflowIds()"
        :current-subflow-id="currentSubflowIdVal"
        @add-node="store.addNode"
        @switch-main="store.switchToMain"
        @switch-subflow="store.switchToSubflow"
        @add-subflow="store.addSubflow"
        @remove-subflow="store.removeSubflow"
      />

      <PropertyPanel
        v-if="activeNode"
        class="floating-property"
        :node="activeNode"
        :variables="availableVars"
        :highlight-field="highlightField"
        :subflow-ids="store.listSubflowIds()"
        @remove-node="store.removeNode"
        @create-subflow="store.addSubflow"
        @switch-to-subflow="store.switchToSubflow"
      />
      <EdgePropertyPanel
        v-else-if="activeEdge"
        class="floating-property"
        :edge="activeEdge"
        :nodes="store.nodes"
        @remove-edge="store.removeEdge"
      />

      <div class="bottom-toolbar">
        <button class="toolbar-btn" @click="store.undo" title="撤销 (⌘/Ctrl+Z)">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M3 7v6h6M21 17a9 9 0 00-9-9 9 9 0 00-9 9" />
          </svg>
        </button>
        <button class="toolbar-btn" @click="store.redo" title="重做 (⌘/Ctrl+Shift+Z)">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M21 7v6h-6M3 17a9 9 0 019-9 9 9 0 019 9" />
          </svg>
        </button>
        <span class="toolbar-divider" />
        <button class="toolbar-btn" @click="store.layoutAuto" title="自动排版">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        </button>
        <button class="toolbar-btn" @click="fitAll" title="自适应视图">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"
            />
          </svg>
        </button>
      </div>
    </div>
    <!-- simple toast container -->
    <div class="rr-toast-container">
      <div v-for="t in toasts" :key="t.id" class="rr-toast" :data-level="t.level">
        {{ t.message }}
      </div>
    </div>
  </div>
  <!-- Rename dialog -->
  <div v-if="renameVisible" class="rr-modal">
    <div class="rr-dialog small">
      <div class="rr-header">
        <div class="title">重命名工作流</div>
        <button class="close" @click="renameVisible = false">✕</button>
      </div>
      <div class="rr-body">
        <div class="row">
          <label>名称</label>
          <input v-model="renameName" placeholder="工作流名称" />
        </div>
        <div class="row">
          <label>描述</label>
          <textarea v-model="renameDesc" placeholder="可选描述"></textarea>
        </div>
      </div>
      <div class="rr-footer">
        <button class="primary" @click="applyRename">保存</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
// Dedicated full-page builder using the same inner components as popup modal
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { Flow as FlowV2 } from '@/entrypoints/background/record-replay/types';

import { useBuilderStore } from '@/entrypoints/popup/components/builder/store/useBuilderStore';
import { validateFlow } from '@/entrypoints/popup/components/builder/model/validation';
import Canvas from '@/entrypoints/popup/components/builder/components/Canvas.vue';
import Sidebar from '@/entrypoints/popup/components/builder/components/Sidebar.vue';
import PropertyPanel from '@/entrypoints/popup/components/builder/components/PropertyPanel.vue';
import EdgePropertyPanel from '@/entrypoints/popup/components/builder/components/EdgePropertyPanel.vue';

const title = ref('工作流编辑器');
// theme state: persisted in localStorage and default to system preference
const theme = ref<'light' | 'dark'>(
  (localStorage.getItem('rr-theme') as 'light' | 'dark' | null) ||
    (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
);
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('rr-theme', theme.value);
  } catch {}
}
const store = useBuilderStore();

// toast event bus (listen to rr_toast)
type ToastItem = { id: string; message: string; level: 'info' | 'warn' | 'error' };
const toasts = ref<ToastItem[]>([]);
function pushToast(message: string, level: 'info' | 'warn' | 'error' = 'warn') {
  const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item: ToastItem = { id, message, level };
  toasts.value.push(item);
  setTimeout(() => {
    const idx = toasts.value.findIndex((x) => x.id === id);
    if (idx >= 0) toasts.value.splice(idx, 1);
  }, 2500);
}
function onToast(ev: any) {
  try {
    const msg = String(ev?.detail?.message || '');
    const level = (ev?.detail?.level || 'warn') as any;
    if (msg) pushToast(msg, level);
  } catch {}
}
onMounted(() => window.addEventListener('rr_toast', onToast as any));
onUnmounted(() => window.removeEventListener('rr_toast', onToast as any));

// Parse query string
function getQuery(): Record<string, string> {
  const q: Record<string, string> = {};
  const url = new URL(location.href);
  url.searchParams.forEach((v, k) => (q[k] = v));
  return q;
}

async function bootstrap() {
  const q = getQuery();
  if (q.flowId) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW,
        flowId: q.flowId,
      });
      if (res && res.success && res.flow) {
        store.initFromFlow(res.flow);
        title.value = `编辑：${res.flow.name || res.flow.id}`;
        if (q.focus) {
          setTimeout(() => {
            try {
              store.selectNode(q.focus!);
              (focusNodeId as any).value = q.focus!;
              setTimeout(() => ((focusNodeId as any).value = null), 300);
            } catch {}
          }, 0);
        }
      }
    } catch {}
  } else if (q.new === '1') {
    // Initialize an empty flow
    const now = Date.now();
    const empty: FlowV2 = {
      id: `flow_${now}`,
      name: '新建工作流',
      version: 1,
      steps: [],
      variables: [],
      meta: {
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      } as any,
    } as any;
    store.initFromFlow(empty);
  }
}

// Builder helpers mostly ported from modal component
const selectedId = computed<string | null>(() => (store.activeNodeId as any)?.value ?? null);
const selectedEdgeId = computed<string | null>(() => (store.activeEdgeId as any)?.value ?? null);
const activeNode = computed(() => store.nodes.find((n) => n.id === selectedId.value) || null);
const activeEdge = computed(() => store.edges.find((e) => e.id === selectedEdgeId.value) || null);
const validation = computed(() => validateFlow(store.nodes));

// Available variables for the currently selected node (global + previous node outputs)
const availableVars = computed(() => store.listAvailableVariables(selectedId.value || undefined));

const search = ref('');
const focusNodeId = ref<string | null>(null);
const currentSubflowIdVal = computed<string | null>(
  () => (store.currentSubflowId as any)?.value ?? null,
);
const highlightField = ref<string | null>(null);
const fitSeq = ref(0);
function focusSearch() {
  const q = search.value.trim().toLowerCase();
  if (!q) return;
  const matches = (n: any): boolean => {
    if ((n.name || '').toLowerCase().includes(q)) return true;
    if ((n.type || '').toLowerCase().includes(q)) return true;
    try {
      const walk = (v: any): boolean => {
        if (v == null) return false;
        if (typeof v === 'string')
          return v.toLowerCase().includes(q) || v.toLowerCase().includes(`{${q}}`);
        if (Array.isArray(v)) return v.some(walk);
        if (typeof v === 'object') return Object.values(v).some(walk);
        return false;
      };
      return walk(n.config);
    } catch {
      return false;
    }
  };
  const hit = store.nodes.find((n) => matches(n));
  if (hit) {
    store.selectNode(hit.id);
    focusNodeId.value = hit.id;
    setTimeout(() => (focusNodeId.value = null), 300);
  }
}
function onAddNodeAt(type: string, x: number, y: number) {
  try {
    store.addNodeAt(type as any, x, y);
  } catch {}
}
function fitAll() {
  fitSeq.value++;
}

// rename dialog
const renameVisible = ref(false);
const renameName = ref('');
const renameDesc = ref('');
function openRename() {
  renameName.value = store.flowLocal.name || '';
  renameDesc.value = (store.flowLocal as any).description || '';
  renameVisible.value = true;
}
function applyRename() {
  store.flowLocal.name = renameName.value.trim();
  (store.flowLocal as any).description = renameDesc.value;
  renameVisible.value = false;
}

async function save() {
  // Use exportFlowForSave to properly handle subflow editing:
  // - Flushes current canvas state back to flowLocal (including subflow edits)
  // - Generates steps from main flow nodes/edges
  // - Returns deep copy with correct nodes/edges from flowLocal
  const result = store.exportFlowForSave();
  await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW, flow: result });
  try {
    // Use main flow nodes for trigger sync (not current canvas which may be subflow)
    await syncTriggersAndSchedules(result.id, result.nodes || []);
  } catch {}
}

function trigId(flowId: string, nodeId: string, kind: string) {
  return `trg_${flowId}_${nodeId}_${kind}`;
}

function schId(flowId: string, nodeId: string, idx: number) {
  return `sch_${flowId}_${nodeId}_${idx}`;
}

async function syncTriggersAndSchedules(flowId: string, nodes: any[]) {
  const triggersNeeded: any[] = [];
  const schedulesNeeded: any[] = [];
  const tnodes = (nodes || []).filter((n: any) => n && n.type === 'trigger');
  for (const n of tnodes) {
    const cfg = n.config || {};
    const enabled = cfg.enabled !== false;
    if (cfg.modes?.url && Array.isArray(cfg.url?.rules) && cfg.url.rules.length) {
      triggersNeeded.push({
        id: trigId(flowId, n.id, 'url'),
        type: 'url',
        enabled,
        flowId,
        match: cfg.url.rules,
      });
    }
    if (cfg.modes?.contextMenu && cfg.contextMenu?.title) {
      triggersNeeded.push({
        id: trigId(flowId, n.id, 'menu'),
        type: 'contextMenu',
        enabled,
        flowId,
        title: cfg.contextMenu.title,
        contexts: cfg.contextMenu.contexts || ['all'],
      });
    }
    if (cfg.modes?.command && cfg.command?.commandKey) {
      triggersNeeded.push({
        id: trigId(flowId, n.id, 'cmd'),
        type: 'command',
        enabled,
        flowId,
        commandKey: String(cfg.command.commandKey),
      });
    }
    if (cfg.modes?.dom && cfg.dom?.selector) {
      triggersNeeded.push({
        id: trigId(flowId, n.id, 'dom'),
        type: 'dom',
        enabled,
        flowId,
        selector: cfg.dom.selector,
        appear: cfg.dom.appear !== false,
        once: cfg.dom.once !== false,
        debounceMs: Number(cfg.dom.debounceMs ?? 800),
      });
    }
    if (cfg.modes?.schedule && Array.isArray(cfg.schedules)) {
      cfg.schedules.forEach((s: any, i: number) => {
        const id = schId(flowId, n.id, i);
        schedulesNeeded.push({
          id,
          flowId,
          type: s.type || 'interval',
          when: String(s.when || ''),
          enabled: s.enabled !== false,
        });
      });
    }
  }
  // sync triggers
  try {
    const list =
      (await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_TRIGGERS })) || {};
    const existing: any[] = list.triggers || [];
    const mine = existing.filter((x) => String(x.flowId) === String(flowId));
    const needIds = new Set(triggersNeeded.map((t) => t.id));
    // save or update
    for (const t of triggersNeeded) {
      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER,
        trigger: t,
      });
    }
    // delete stale
    for (const t of mine) {
      if (!needIds.has(t.id)) {
        await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER,
          id: t.id,
        });
      }
    }
    await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS });
  } catch {}
  // sync schedules
  try {
    const list =
      (await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_SCHEDULES })) ||
      {};
    const existing: any[] = list.schedules || [];
    const mine = existing.filter((x) => String(x.flowId) === String(flowId));
    const needIds = new Set(schedulesNeeded.map((s) => s.id));
    for (const s of schedulesNeeded) {
      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_SCHEDULE_FLOW,
        schedule: s,
      });
    }
    for (const s of mine) {
      if (!needIds.has(s.id)) {
        await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.RR_UNSCHEDULE_FLOW,
          scheduleId: s.id,
        });
      }
    }
  } catch {}
}

async function exportFlow() {
  try {
    await save();
    const res = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW,
      flowId: store.flowLocal.id,
    });
    if (res && res.success) {
      const blob = new Blob([res.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `${store.flowLocal.name || 'flow'}.json`,
        saveAs: true,
      } as any);
      URL.revokeObjectURL(url);
    }
  } catch {}
}

async function onImport(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const txt = await file.text();
    const res = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW,
      json: txt,
    });
    if (res && res.success && Array.isArray(res.flows) && res.flows.length) {
      store.initFromFlow(res.flows[0]);
    }
  } catch {
  } finally {
    input.value = '';
  }
}

async function runFromSelected() {
  if (!selectedId.value || !store.flowLocal?.id) return;
  try {
    await save();
    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW,
      flowId: store.flowLocal.id,
      options: { returnLogs: false, startNodeId: selectedId.value },
    });
  } catch {}
}
async function runAll() {
  if (!store.flowLocal?.id) return;
  try {
    await save();
    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW,
      flowId: store.flowLocal.id,
      options: { returnLogs: false },
    });
  } catch {}
}

function importFromSteps() {
  store.importFromSteps();
}
function exportToSteps() {
  // Use exportFlowForSave to properly handle subflow editing
  const flow = store.exportFlowForSave();
  store.flowLocal.steps = flow.steps;
}

// Hotkeys
function onKey(e: KeyboardEvent) {
  const id = selectedId.value;
  const isMeta = e.metaKey || e.ctrlKey;
  // Do not trigger global hotkeys when user is typing in an input control
  // or editing inside contenteditable, especially within the property panel.
  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = (t.tagName || '').toLowerCase();
    const inEditable =
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      (t as HTMLElement).isContentEditable ||
      !!t.closest('.floating-property');
    if (inEditable) return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && id) {
    e.preventDefault();
    store.removeNode(id);
  } else if (isMeta && e.key.toLowerCase?.() === 'd') {
    if (id) {
      e.preventDefault();
      store.duplicateNode(id);
    }
  } else if (isMeta && e.key.toLowerCase?.() === 'z') {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (isMeta && e.key.toLowerCase?.() === 's') {
    e.preventDefault();
    save();
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKey);
  bootstrap();
});
onUnmounted(() => document.removeEventListener('keydown', onKey));

// Auto save debounced
const saveState = ref<'idle' | 'saving' | 'saved'>('idle');
const saveLabel = computed(() =>
  saveState.value === 'saving' ? '保存中…' : saveState.value === 'saved' ? '已保存' : '',
);
let saveTimer: any = null;
let statusTimer: any = null;
function scheduleAutoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      saveState.value = 'saving';
      await new Promise((r) => setTimeout(r, 0));
      save();
      saveState.value = 'saved';
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => (saveState.value = 'idle'), 1200);
    } catch {
      saveState.value = 'idle';
    }
  }, 800);
}
watch(
  () => [store.nodes, store.edges, store.flowLocal.name, (store.flowLocal as any).description],
  scheduleAutoSave,
  { deep: true },
);

// Fallback suggestion from run logs
const fallbackNotice = ref<{ nodeId: string; type: string; prevIndex: number } | null>(null);
function applyFallbackPromotion(nodeId: string, toType: string) {
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node || (node.type !== 'click' && node.type !== 'fill')) return;
  const cands = (node as any).config?.target?.candidates as Array<{ type: string; value: string }>;
  if (!Array.isArray(cands) || !cands.length) return;
  const idx = cands.findIndex((c) => c.type === String(toType));
  if (idx > 0) {
    const cand = cands.splice(idx, 1)[0];
    cands.unshift(cand);
    fallbackNotice.value = { nodeId, type: String(toType), prevIndex: idx };
    focusNode(nodeId);
    highlightField.value = 'target.candidates';
    setTimeout(() => (highlightField.value = null), 1500);
  }
}
function undoFallbackPromotion() {
  const n = fallbackNotice.value;
  if (!n) return;
  const node = store.nodes.find((x) => x.id === n.nodeId);
  if (!node || (node.type !== 'click' && node.type !== 'fill')) {
    fallbackNotice.value = null;
    return;
  }
  const cands = (node as any).config?.target?.candidates as Array<{ type: string; value: string }>;
  if (!Array.isArray(cands) || cands.length === 0) {
    fallbackNotice.value = null;
    return;
  }
  const currentIdx = cands.findIndex((c) => c.type === n.type);
  if (currentIdx >= 0 && n.prevIndex >= 0 && n.prevIndex < cands.length) {
    const cand = cands.splice(currentIdx, 1)[0];
    cands.splice(n.prevIndex, 0, cand);
  }
  fallbackNotice.value = null;
}

function focusNode(id: string) {
  store.selectNode(id);
  focusNodeId.value = id;
  setTimeout(() => (focusNodeId.value = null), 300);
}
// per-node error indicators replace global error panel
</script>

<style scoped>
.builder-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  background: var(--rr-bg);
  display: flex;
  flex-direction: column;
  color: var(--rr-text);
}
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border: none;
  background: #ededed;
  z-index: 20;
  pointer-events: none;
}
.topbar > * {
  pointer-events: auto;
}

.rr-toast-container {
  position: fixed;
  top: 60px;
  right: 16px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rr-toast {
  min-width: 180px;
  max-width: 360px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  color: #111;
  background: #fff8e1;
  border: 1px solid #facc15;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.rr-toast[data-level='info'] {
  background: #e0f2fe;
  border-color: #38bdf8;
}
.rr-toast[data-level='error'] {
  background: #fee2e2;
  border-color: #ef4444;
}
.topbar .left {
  display: flex;
  gap: 8px;
  align-items: center;
}
.topbar .tip {
  color: var(--rr-muted);
  font-size: 12px;
}
.topbar .right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.main {
  flex: 1;
  position: relative;
  background: var(--rr-bg);
  overflow: hidden;
  width: 100%;
  height: 100%;
}
.floating-sidebar {
  position: absolute;
  left: 0;
  top: 36px;
  z-index: 10;
  pointer-events: auto;
}
.floating-property {
  position: absolute;
  right: 0;
  /* keep below topbar and pinned above bottom */
  top: 52px;
  z-index: 10;
  pointer-events: auto;
}
.bottom-toolbar {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 20px;
  display: flex;
  gap: 4px;
  align-items: center;
  background: var(--rr-card);
  border: 1px solid var(--rr-border);
  border-radius: 12px;
  padding: 8px 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(8px);
}
.toolbar-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--rr-text-secondary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.toolbar-btn:hover {
  background: var(--rr-hover);
  color: var(--rr-text);
}
.toolbar-btn:active {
  transform: scale(0.95);
}
.toolbar-divider {
  width: 1px;
  height: 24px;
  background: var(--rr-border);
  margin: 0 4px;
}
.top-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.top-btn:hover:not(:disabled) {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}
.top-btn:active:not(:disabled) {
  transform: translateY(0);
}
.top-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.top-btn.primary {
  background: var(--rr-accent);
  color: #fff;
  border-color: var(--rr-accent);
}
.top-btn.primary:hover {
  background: #2563eb;
  border-color: #2563eb;
}
.top-btn.success {
  background: #10b981;
  color: #fff;
  border-color: #10b981;
}
.top-btn.success:hover {
  background: #059669;
  border-color: #059669;
}
.top-btn.danger {
  background: rgba(239, 68, 68, 0.1);
  color: var(--rr-danger);
  border-color: rgba(239, 68, 68, 0.3);
}
.top-btn.danger:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: var(--rr-danger);
}
.top-btn.ghost {
  border: none;
  background: transparent;
}
.top-btn.ghost:hover {
  background: var(--rr-hover);
}
.top-btn.import {
  position: relative;
  overflow: hidden;
}
.top-btn.import input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.divider-vert {
  width: 1px;
  height: 24px;
  background: var(--rr-border);
  margin: 0 8px;
}
.topbar .status {
  color: var(--rr-muted);
  font-size: 12px;
  margin-right: 8px;
  min-width: 48px;
  display: inline-block;
}
.btn.import {
  position: relative;
  overflow: hidden;
}
.btn.import input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.notice-top {
  background: var(--rr-brand-strong);
  color: #fff;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.notice-top .mini {
  background: var(--rr-card);
  border: 1px solid var(--rr-border);
  color: var(--rr-text);
}
/* removed legacy error-panel styles */

/* dialog styles (aligned with popup ScheduleDialog) */
.rr-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rr-dialog {
  background: #fff;
  border-radius: 8px;
  width: 520px;
  max-width: 96vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.rr-dialog.small {
  width: 520px;
}
.rr-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.rr-header .title {
  font-weight: 600;
}
.rr-header .close {
  border: none;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
}
.rr-body {
  padding: 12px 16px;
  overflow: auto;
}
.rr-footer {
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.rr-footer .primary {
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 6px 0;
}
.row > label {
  width: 88px;
  color: #374151;
}
.row > input,
.row > textarea {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px 8px;
}
.row > textarea {
  min-height: 64px;
}
</style>

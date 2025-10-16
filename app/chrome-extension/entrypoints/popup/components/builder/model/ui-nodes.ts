// ui-nodes.ts — UI registry for builder nodes (sidebar, canvas, properties)
// Comments in English to explain intent.

import type { Component } from 'vue';
import type { NodeBase, NodeType } from '@/entrypoints/background/record-replay/types';
import { defaultConfigFor as fallbackDefaultConfig } from '@/entrypoints/popup/components/builder/model/transforms';
import { validateNode as fallbackValidateNode } from '@/entrypoints/popup/components/builder/model/validation';

// Canvas renderer components
import NodeCard from '@/entrypoints/popup/components/builder/components/nodes/NodeCard.vue';
import NodeIf from '@/entrypoints/popup/components/builder/components/nodes/NodeIf.vue';

// Property components (per-node or shared)
import PropClick from '@/entrypoints/popup/components/builder/components/properties/PropertyClick.vue';
import PropFill from '@/entrypoints/popup/components/builder/components/properties/PropertyFill.vue';
import PropTriggerEvent from '@/entrypoints/popup/components/builder/components/properties/PropertyTriggerEvent.vue';
import PropSetAttribute from '@/entrypoints/popup/components/builder/components/properties/PropertySetAttribute.vue';
import PropDrag from '@/entrypoints/popup/components/builder/components/properties/PropertyDrag.vue';
import PropScroll from '@/entrypoints/popup/components/builder/components/properties/PropertyScroll.vue';
import PropNavigate from '@/entrypoints/popup/components/builder/components/properties/PropertyNavigate.vue';
import PropWait from '@/entrypoints/popup/components/builder/components/properties/PropertyWait.vue';
import PropAssert from '@/entrypoints/popup/components/builder/components/properties/PropertyAssert.vue';
import PropDelay from '@/entrypoints/popup/components/builder/components/properties/PropertyDelay.vue';
import PropHttp from '@/entrypoints/popup/components/builder/components/properties/PropertyHttp.vue';
import PropExtract from '@/entrypoints/popup/components/builder/components/properties/PropertyExtract.vue';
import PropScreenshot from '@/entrypoints/popup/components/builder/components/properties/PropertyScreenshot.vue';
import PropLoopElements from '@/entrypoints/popup/components/builder/components/properties/PropertyLoopElements.vue';
import PropSwitchFrame from '@/entrypoints/popup/components/builder/components/properties/PropertySwitchFrame.vue';
import PropHandleDownload from '@/entrypoints/popup/components/builder/components/properties/PropertyHandleDownload.vue';
import PropExecuteFlow from '@/entrypoints/popup/components/builder/components/properties/PropertyExecuteFlow.vue';
import PropOpenTab from '@/entrypoints/popup/components/builder/components/properties/PropertyOpenTab.vue';
import PropSwitchTab from '@/entrypoints/popup/components/builder/components/properties/PropertySwitchTab.vue';
import PropCloseTab from '@/entrypoints/popup/components/builder/components/properties/PropertyCloseTab.vue';
import PropKey from '@/entrypoints/popup/components/builder/components/properties/PropertyKey.vue';
import PropIf from '@/entrypoints/popup/components/builder/components/properties/PropertyIf.vue';
import PropForeach from '@/entrypoints/popup/components/builder/components/properties/PropertyForeach.vue';
import PropWhile from '@/entrypoints/popup/components/builder/components/properties/PropertyWhile.vue';
import PropScript from '@/entrypoints/popup/components/builder/components/properties/PropertyScript.vue';
import PropTrigger from '@/entrypoints/popup/components/builder/components/properties/PropertyTrigger.vue';

export type NodeCategory = 'Flow' | 'Actions' | 'Logic' | 'Tools' | 'Tabs' | 'Page';

export interface NodeUIConfig {
  type: NodeType;
  label: string;
  category: NodeCategory;
  iconClass: string; // reuse existing Sidebar.css color classes
  canvas: Component; // canvas renderer
  property: Component; // property renderer
  docUrl?: string;
  io?: { inputs?: number | 'any'; outputs?: number | 'any' };
  defaultConfig?: () => any;
  validate?: (node: NodeBase) => string[];
}

// Registry contents; use existing color/icon CSS classes from Sidebar.vue
const baseCard = NodeCard as Component;

export const NODE_UI_LIST: NodeUIConfig[] = [
  {
    type: 'trigger' as any,
    label: '触发器',
    category: 'Actions',
    iconClass: 'icon-trigger',
    canvas: baseCard,
    property: PropTrigger,
    io: { inputs: 0, outputs: 1 },
    defaultConfig: () => ({
      enabled: true,
      description: '',
      modes: {
        manual: true,
        url: false,
        contextMenu: false,
        command: false,
        dom: false,
        schedule: false,
      },
      url: { rules: [] as Array<{ kind: 'url' | 'domain' | 'path'; value: string }> },
      contextMenu: { title: '运行工作流', contexts: ['all'] as string[], enabled: false },
      command: { commandKey: '', enabled: false },
      dom: { selector: '', appear: true, once: true, debounceMs: 800, enabled: false },
      schedules: [] as Array<{
        id?: string;
        type: 'once' | 'interval' | 'daily';
        when: string;
        enabled: boolean;
      }>,
    }),
  },
  {
    type: 'navigate',
    label: '导航',
    category: 'Actions',
    iconClass: 'icon-navigate',
    canvas: baseCard,
    property: PropNavigate,
  },
  {
    type: 'click',
    label: '点击',
    category: 'Actions',
    iconClass: 'icon-click',
    canvas: baseCard,
    property: PropClick,
  },
  {
    type: 'drag',
    label: '拖拽',
    category: 'Actions',
    iconClass: 'icon-drag',
    canvas: baseCard,
    property: PropDrag,
  },
  {
    type: 'scroll',
    label: '滚动',
    category: 'Actions',
    iconClass: 'icon-scroll',
    canvas: baseCard,
    property: PropScroll,
  },
  {
    type: 'dblclick',
    label: '双击',
    category: 'Actions',
    iconClass: 'icon-click',
    canvas: baseCard,
    property: PropClick,
  },
  {
    type: 'fill',
    label: '填充',
    category: 'Actions',
    iconClass: 'icon-fill',
    canvas: baseCard,
    property: PropFill,
  },
  {
    type: 'key',
    label: '键盘',
    category: 'Actions',
    iconClass: 'icon-key',
    canvas: baseCard,
    property: PropKey,
  },
  {
    type: 'wait',
    label: '等待',
    category: 'Actions',
    iconClass: 'icon-wait',
    canvas: baseCard,
    property: PropWait,
  },
  {
    type: 'assert',
    label: '断言',
    category: 'Actions',
    iconClass: 'icon-assert',
    canvas: baseCard,
    property: PropAssert,
  },
  {
    type: 'delay',
    label: '延迟',
    category: 'Actions',
    iconClass: 'icon-delay',
    canvas: baseCard,
    property: PropDelay,
  },

  {
    type: 'if',
    label: '条件',
    category: 'Logic',
    iconClass: 'icon-if',
    canvas: NodeIf as Component,
    property: PropIf,
  },
  {
    type: 'foreach',
    label: '循环',
    category: 'Logic',
    iconClass: 'icon-foreach',
    canvas: baseCard,
    property: PropForeach,
  },
  {
    type: 'while',
    label: '循环',
    category: 'Logic',
    iconClass: 'icon-while',
    canvas: baseCard,
    property: PropWhile,
  },

  {
    type: 'http',
    label: 'HTTP',
    category: 'Tools',
    iconClass: 'icon-http',
    canvas: baseCard,
    property: PropHttp,
  },
  {
    type: 'extract',
    label: '提取',
    category: 'Tools',
    iconClass: 'icon-extract',
    canvas: baseCard,
    property: PropExtract,
  },
  {
    type: 'screenshot',
    label: '截图',
    category: 'Tools',
    iconClass: 'icon-screenshot',
    canvas: baseCard,
    property: PropScreenshot,
  },
  {
    type: 'triggerEvent',
    label: '触发事件',
    category: 'Tools',
    iconClass: 'icon-trigger',
    canvas: baseCard,
    property: PropTriggerEvent,
  },
  {
    type: 'setAttribute',
    label: '设置属性',
    category: 'Tools',
    iconClass: 'icon-attr',
    canvas: baseCard,
    property: PropSetAttribute,
  },
  {
    type: 'loopElements',
    label: '循环元素',
    category: 'Tools',
    iconClass: 'icon-loop',
    canvas: baseCard,
    property: PropLoopElements,
  },
  {
    type: 'switchFrame',
    label: '切换Frame',
    category: 'Tools',
    iconClass: 'icon-frame',
    canvas: baseCard,
    property: PropSwitchFrame,
  },
  {
    type: 'handleDownload',
    label: '下载处理',
    category: 'Tools',
    iconClass: 'icon-download',
    canvas: baseCard,
    property: PropHandleDownload,
  },
  {
    type: 'script',
    label: '脚本',
    category: 'Tools',
    iconClass: 'icon-script',
    canvas: baseCard,
    property: PropScript,
  },

  {
    type: 'openTab',
    label: '打开标签',
    category: 'Tabs',
    iconClass: 'icon-openTab',
    canvas: baseCard,
    property: PropOpenTab,
  },
  {
    type: 'switchTab',
    label: '切换标签',
    category: 'Tabs',
    iconClass: 'icon-switchTab',
    canvas: baseCard,
    property: PropSwitchTab,
  },
  {
    type: 'closeTab',
    label: '关闭标签',
    category: 'Tabs',
    iconClass: 'icon-closeTab',
    canvas: baseCard,
    property: PropCloseTab,
  },
];

const REGISTRY_MAP: Record<string, NodeUIConfig> = Object.fromEntries(
  NODE_UI_LIST.map((n) => [n.type, n]),
);
export const NODE_UI_REGISTRY = REGISTRY_MAP as Record<NodeType, NodeUIConfig>;

export const NODE_CATEGORIES: NodeCategory[] = [
  'Flow',
  'Actions',
  'Logic',
  'Tools',
  'Tabs',
  'Page',
];

export function listByCategory(): Record<NodeCategory, NodeUIConfig[]> {
  const out: Record<NodeCategory, NodeUIConfig[]> = {
    Flow: [],
    Actions: [],
    Logic: [],
    Tools: [],
    Tabs: [],
    Page: [],
  };
  for (const n of NODE_UI_LIST) out[n.category].push(n);
  return out;
}

export function canvasTypeKey(t: NodeType): string {
  // Map to VueFlow node-types key, unique per node type
  return `rr-${t}`;
}

// Default config resolver with registry override
export function defaultConfigOf(t: NodeType): any {
  const item = (NODE_UI_REGISTRY as any)[t] as NodeUIConfig | undefined;
  if (item?.defaultConfig) return item.defaultConfig();
  return fallbackDefaultConfig(t as any);
}

// Validation via registry where present
export function validateNodeWithRegistry(n: NodeBase): string[] {
  const item = (NODE_UI_REGISTRY as any)[n.type] as NodeUIConfig | undefined;
  if (item?.validate) {
    try {
      return item.validate(n) || [];
    } catch {
      return [];
    }
  }
  return fallbackValidateNode(n);
}

// Allow external modules to register extra UI nodes
export function registerExtraUiNodes(list: NodeUIConfig[]) {
  for (const n of list) {
    (NODE_UI_LIST as any).push(n);
    (REGISTRY_MAP as any)[n.type] = n;
  }
}

// IO constraints helper with sensible defaults for our graph
export function getIoConstraint(t: NodeType): { inputs: number | 'any'; outputs: number | 'any' } {
  const item = (NODE_UI_REGISTRY as any)[t] as NodeUIConfig | undefined;
  const io = item?.io || {};
  // Defaults: most nodes have single input; outputs unlimited unless otherwise defined
  let inputs: number | 'any' = (io.inputs as any) ?? 1;
  let outputs: number | 'any' = (io.outputs as any) ?? 'any';
  if ((t as any) === 'trigger') inputs = 0;
  if ((t as any) === 'if') outputs = 'any';
  return { inputs, outputs };
}

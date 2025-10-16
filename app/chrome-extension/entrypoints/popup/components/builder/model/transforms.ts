import type {
  Flow as FlowV2,
  NodeBase,
  Edge as EdgeV2,
} from '@/entrypoints/background/record-replay/types';
import {
  nodesToSteps as sharedNodesToSteps,
  stepsToNodes as sharedStepsToNodes,
  topoOrder as sharedTopoOrder,
} from 'chrome-mcp-shared';

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export type NodeType = NodeBase['type'];

export function defaultConfigFor(t: NodeType): any {
  if ((t as any) === 'trigger') return { type: 'manual', description: '' };
  if (t === 'click' || t === 'fill')
    return { target: { candidates: [] }, value: t === 'fill' ? '' : undefined };
  if (t === 'if') return { branches: [{ id: newId('case'), name: '', expr: '' }], else: true };
  if (t === 'navigate') return { url: '' };
  if (t === 'wait') return { condition: { text: '', appear: true } };
  if (t === 'assert') return { assert: { exists: '' } };
  if (t === 'key') return { keys: '' };
  if (t === 'delay') return { ms: 1000 };
  if (t === 'http') return { method: 'GET', url: '', headers: {}, body: null, saveAs: '' };
  if (t === 'extract') return { selector: '', attr: 'text', js: '', saveAs: '' };
  if (t === 'screenshot') return { selector: '', fullPage: false, saveAs: 'shot' };
  if (t === 'drag') return { start: { candidates: [] }, end: { candidates: [] }, path: [] };
  if (t === 'scroll')
    return { mode: 'offset', offset: { x: 0, y: 300 }, target: { candidates: [] } };
  if (t === 'triggerEvent')
    return { target: { candidates: [] }, event: 'input', bubbles: true, cancelable: false };
  if (t === 'setAttribute') return { target: { candidates: [] }, name: '', value: '' };
  if (t === 'loopElements')
    return { selector: '', saveAs: 'elements', itemVar: 'item', subflowId: '' };
  if (t === 'switchFrame') return { frame: { index: 0, urlContains: '' } };
  if (t === 'handleDownload')
    return { filenameContains: '', waitForComplete: true, timeoutMs: 60000, saveAs: 'download' };
  if (t === 'executeFlow') return { flowId: '', inline: true, args: {} };
  if (t === 'openTab') return { url: '', newWindow: false };
  if (t === 'switchTab') return { tabId: null, urlContains: '', titleContains: '' };
  if (t === 'closeTab') return { tabIds: [], url: '' };
  if (t === 'script') return { world: 'ISOLATED', code: '', saveAs: '', assign: {} };
  return {};
}

export function stepsToNodes(steps: any[]): NodeBase[] {
  const base = sharedStepsToNodes(steps) as unknown as NodeBase[];
  // add simple UI positions
  base.forEach((n, i) => {
    (n as any).ui = (n as any).ui || { x: 200, y: 120 + i * 120 };
  });
  return base;
}

export function topoOrder(nodes: NodeBase[], edges: EdgeV2[]): NodeBase[] {
  const filtered = (edges || []).filter((e) => !e.label || e.label === 'default');
  return sharedTopoOrder(nodes as any, filtered as any) as any;
}

export function nodesToSteps(nodes: NodeBase[], edges: EdgeV2[]): any[] {
  // Exclude non-executable nodes like 'trigger' and cut edges from them
  const execNodes = (nodes || []).filter((n) => n.type !== ('trigger' as any));
  const filtered = (edges || []).filter(
    (e) => (!e.label || e.label === 'default') && !execNodes.every((n) => n.id !== e.from),
  );
  return sharedNodesToSteps(execNodes as any, filtered as any);
}

export function autoChainEdges(nodes: NodeBase[]): EdgeV2[] {
  const arr: EdgeV2[] = [];
  for (let i = 0; i < nodes.length - 1; i++)
    arr.push({ id: newId('e'), from: nodes[i].id, to: nodes[i + 1].id, label: 'default' });
  return arr;
}

export function summarizeNode(n?: NodeBase | null): string {
  if (!n) return '';
  if (n.type === 'click' || n.type === 'fill')
    return n.config?.target?.candidates?.[0]?.value || '未配置选择器';
  if (n.type === 'navigate') return n.config?.url || '';
  if (n.type === 'key') return n.config?.keys || '';
  if (n.type === 'delay') return `${Number(n.config?.ms || 0)}ms`;
  if (n.type === 'http') return `${n.config?.method || 'GET'} ${n.config?.url || ''}`;
  if (n.type === 'extract') return `${n.config?.selector || ''} -> ${n.config?.saveAs || ''}`;
  if (n.type === 'screenshot')
    return n.config?.selector
      ? `el(${n.config.selector}) -> ${n.config?.saveAs || ''}`
      : `fullPage -> ${n.config?.saveAs || ''}`;
  if (n.type === 'triggerEvent')
    return `${n.config?.event || ''} ${n.config?.target?.candidates?.[0]?.value || ''}`;
  if (n.type === 'setAttribute') return `${n.config?.name || ''}=${n.config?.value ?? ''}`;
  if (n.type === 'loopElements')
    return `${n.config?.selector || ''} as ${n.config?.itemVar || 'item'} -> ${n.config?.subflowId || ''}`;
  if (n.type === 'switchFrame')
    return n.config?.frame?.urlContains
      ? `url~${n.config.frame.urlContains}`
      : `index=${Number(n.config?.frame?.index ?? 0)}`;
  if (n.type === 'openTab') return `open ${n.config?.url || ''}`;
  if (n.type === 'switchTab')
    return `switch ${n.config?.tabId || n.config?.urlContains || n.config?.titleContains || ''}`;
  if (n.type === 'closeTab') return `close ${n.config?.url || ''}`;
  if (n.type === 'handleDownload') return `download ${n.config?.filenameContains || ''}`;
  if (n.type === 'wait') return JSON.stringify(n.config?.condition || {});
  if (n.type === 'assert') return JSON.stringify(n.config?.assert || {});
  if (n.type === 'if') {
    const cnt = Array.isArray(n.config?.branches) ? n.config.branches.length : 0;
    return `if/else 分支数 ${cnt}${n.config?.else === false ? '' : ' + else'}`;
  }
  if (n.type === 'script') return (n.config?.code || '').slice(0, 30);
  if (n.type === 'drag') {
    const a = n.config?.start?.candidates?.[0]?.value || '';
    const b = n.config?.end?.candidates?.[0]?.value || '';
    return a || b ? `${a} -> ${b}` : '拖拽';
  }
  if (n.type === 'scroll') {
    const mode = n.config?.mode || 'offset';
    if (mode === 'offset' || mode === 'container') {
      const x = Number(n.config?.offset?.x ?? 0);
      const y = Number(n.config?.offset?.y ?? 0);
      return `${mode} (${x}, ${y})`;
    }
    const sel = n.config?.target?.candidates?.[0]?.value || '';
    return sel ? `element ${sel}` : 'element';
  }
  if (n.type === 'executeFlow') return `exec ${n.config?.flowId || ''}`;
  return '';
}

export function cloneFlow(flow: FlowV2): FlowV2 {
  return JSON.parse(JSON.stringify(flow));
}

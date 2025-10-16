// rr-graph.ts — shared DAG helpers for Record & Replay
// Note: keep types lightweight to avoid cross-package coupling

export interface RRNode {
  id: string;
  type: string;
  config?: any;
}
export interface RREdge {
  id: string;
  from: string;
  to: string;
  label?: 'default' | 'true' | 'false' | 'onError';
}

// Topological order using Kahn's algorithm; edges considered as-is (caller may pre-filter labels)
export function topoOrder<T extends RRNode>(nodes: T[], edges: RREdge[]): T[] {
  const id2n = new Map(nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const nexts = new Map<string, string[]>(nodes.map((n) => [n.id, [] as string[]] as const));
  for (const e of edges) nexts.get(e.from)!.push(e.to);
  const q: string[] = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  const out: T[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = id2n.get(id);
    if (!n) continue;
    out.push(n as T);
    for (const v of nexts.get(id)!) {
      indeg.set(v, (indeg.get(v) || 0) - 1);
      if ((indeg.get(v) || 0) === 0) q.push(v);
    }
  }
  return out.length === nodes.length ? out : nodes.slice();
}

// Map a Node (Flow V2) to a linear Step (Flow V1)
export function mapNodeToStep(node: RRNode): any {
  const c: any = node.config || {};
  const base = { id: node.id } as any;
  switch (node.type) {
    case 'click':
    case 'dblclick':
      return {
        ...base,
        type: node.type,
        target: c.target || { candidates: [] },
        before: c.before,
        after: c.after,
      };
    case 'fill':
      return {
        ...base,
        type: 'fill',
        target: c.target || { candidates: [] },
        value: c.value || '',
      };
    case 'drag':
      return {
        ...base,
        type: 'drag',
        start: c.start || { candidates: [] },
        end: c.end || { candidates: [] },
        path: Array.isArray(c.path) ? c.path : undefined,
      };
    case 'key':
      return { ...base, type: 'key', keys: c.keys || '' };
    case 'wait':
      return { ...base, type: 'wait', condition: c.condition || { text: '', appear: true } };
    case 'assert':
      return {
        ...base,
        type: 'assert',
        assert: c.assert || { exists: '' },
        failStrategy: c.failStrategy,
      };
    case 'if':
      return { ...base, type: 'if', condition: c.condition || {} };
    case 'foreach':
      return {
        ...base,
        type: 'foreach',
        listVar: c.listVar || '',
        itemVar: c.itemVar || 'item',
        subflowId: c.subflowId || '',
      };
    case 'while':
      return {
        ...base,
        type: 'while',
        condition: c.condition || {},
        subflowId: c.subflowId || '',
        maxIterations: Math.max(0, Number(c.maxIterations ?? 100)),
      };
    case 'navigate':
      return { ...base, type: 'navigate', url: c.url || '' };
    case 'script':
      return {
        ...base,
        type: 'script',
        world: c.world || 'ISOLATED',
        code: c.code || '',
        when: c.when,
      };
    case 'delay': // map to wait.sleep to avoid navigation confusion
      return { ...base, type: 'wait', condition: { sleep: Math.max(0, Number(c.ms ?? 1000)) } };
    case 'http':
      return {
        ...base,
        type: 'http',
        method: c.method || 'GET',
        url: c.url || '',
        headers: c.headers || {},
        body: c.body,
        formData: c.formData,
        saveAs: c.saveAs || '',
      };
    case 'extract':
      return {
        ...base,
        type: 'extract',
        selector: c.selector || '',
        attr: c.attr || 'text',
        js: c.js || '',
        saveAs: c.saveAs || '',
      };
    case 'screenshot':
      return {
        ...base,
        type: 'screenshot',
        selector: c.selector || '',
        fullPage: !!c.fullPage,
        saveAs: c.saveAs || '',
      };
    case 'scroll':
      return {
        ...base,
        type: 'scroll',
        mode: c.mode || 'offset',
        target: c.target || { candidates: [] },
        offset: c.offset || { x: 0, y: 300 },
      };
    case 'triggerEvent':
      return {
        ...base,
        type: 'triggerEvent',
        target: c.target || { candidates: [] },
        event: c.event || 'input',
        bubbles: c.bubbles !== false,
        cancelable: !!c.cancelable,
      };
    case 'setAttribute':
      return {
        ...base,
        type: 'setAttribute',
        target: c.target || { candidates: [] },
        name: c.name || '',
        value: c.value,
        remove: !!c.remove,
      };
    case 'loopElements':
      return {
        ...base,
        type: 'loopElements',
        selector: c.selector || '',
        saveAs: c.saveAs || 'elements',
        itemVar: c.itemVar || 'item',
        subflowId: c.subflowId || '',
      };
    case 'switchFrame':
      return {
        ...base,
        type: 'switchFrame',
        frame: {
          index: c.frame && c.frame.index != null ? Number(c.frame.index) : undefined,
          urlContains: c.frame?.urlContains || '',
        },
      };
    case 'openTab':
      return { ...base, type: 'openTab', url: c.url || '', newWindow: !!c.newWindow };
    case 'switchTab':
      return {
        ...base,
        type: 'switchTab',
        tabId: c.tabId || undefined,
        urlContains: c.urlContains || '',
        titleContains: c.titleContains || '',
      };
    case 'closeTab':
      return {
        ...base,
        type: 'closeTab',
        tabIds: Array.isArray(c.tabIds) ? c.tabIds : undefined,
        url: c.url || '',
      };
    case 'executeFlow':
      return {
        ...base,
        type: 'executeFlow',
        flowId: c.flowId || '',
        inline: c.inline !== false,
        args: c.args || {},
      };
    case 'handleDownload':
      return {
        ...base,
        type: 'handleDownload',
        filenameContains: c.filenameContains || '',
        waitForComplete: c.waitForComplete !== false,
        timeoutMs: Math.max(0, Number(c.timeoutMs ?? 60000)),
        saveAs: c.saveAs || '',
      };
    default:
      return { ...base, type: 'script', world: 'ISOLATED', code: '' };
  }
}

export function nodesToSteps(nodes: RRNode[], edges: RREdge[]): any[] {
  const order = edges && edges.length ? topoOrder(nodes, edges) : nodes.slice();
  return order.map((n) => mapNodeToStep(n));
}

// Reverse mapping (Step -> Node config)
export function mapStepToNodeConfig(s: any): any {
  const t = s?.type;
  const base: any = {
    ...(typeof s?.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
    ...(s?.retry ? { retry: s.retry } : {}),
    ...(typeof s?.screenshotOnFail === 'boolean' ? { screenshotOnFail: s.screenshotOnFail } : {}),
  };
  if (t === 'click' || t === 'dblclick')
    return { ...base, target: s.target || { candidates: [] }, after: s.after, before: s.before };
  if (t === 'fill')
    return { ...base, target: s.target || { candidates: [] }, value: s.value || '' };
  if (t === 'wait') return { ...base, condition: s.condition || { text: '', appear: true } };
  if (t === 'assert')
    return { ...base, assert: s.assert || { exists: '' }, failStrategy: s.failStrategy };
  if (t === 'navigate') return { ...base, url: s.url || '' };
  if (t === 'script')
    return { ...base, world: s.world || 'ISOLATED', code: s.code || '', when: s.when };
  if (t === 'executeFlow')
    return { ...base, flowId: s.flowId || '', inline: s.inline !== false, args: s.args || {} };
  if (t === 'if') return { ...base, condition: s.condition || {} };
  if (t === 'key') return { ...base, keys: s.keys || '' };
  if (t === 'http')
    return {
      ...base,
      method: s.method || 'GET',
      url: s.url || '',
      headers: s.headers || {},
      body: s.body,
      formData: s.formData,
      saveAs: s.saveAs || '',
    };
  if (t === 'extract')
    return {
      ...base,
      selector: s.selector || '',
      attr: s.attr || 'text',
      js: s.js || '',
      saveAs: s.saveAs || '',
    };
  if (t === 'openTab') return { ...base, url: s.url || '', newWindow: !!s.newWindow };
  if (t === 'switchTab')
    return {
      ...base,
      tabId: s.tabId || undefined,
      urlContains: s.urlContains || '',
      titleContains: s.titleContains || '',
    };
  if (t === 'closeTab')
    return { ...base, tabIds: Array.isArray(s.tabIds) ? s.tabIds : undefined, url: s.url || '' };
  if (t === 'executeFlow')
    return { ...base, flowId: s.flowId || '', inline: s.inline !== false, args: s.args || {} };
  if (t === 'handleDownload')
    return {
      ...base,
      filenameContains: s.filenameContains || '',
      waitForComplete: s.waitForComplete !== false,
      timeoutMs: Math.max(0, Number(s.timeoutMs ?? 60000)),
      saveAs: s.saveAs || '',
    };
  if (t === 'screenshot')
    return { ...base, selector: s.selector || '', fullPage: !!s.fullPage, saveAs: s.saveAs || '' };
  if (t === 'scroll')
    return {
      ...base,
      mode: s.mode || 'offset',
      target: s.target || { candidates: [] },
      offset: s.offset || { x: 0, y: 300 },
    };
  if (t === 'drag')
    return {
      ...base,
      start: s.start || { candidates: [] },
      end: s.end || { candidates: [] },
      path: Array.isArray(s.path) ? s.path : [],
    };
  if (t === 'triggerEvent')
    return {
      ...base,
      target: s.target || { candidates: [] },
      event: s.event || 'input',
      bubbles: s.bubbles !== false,
      cancelable: !!s.cancelable,
    };
  if (t === 'setAttribute')
    return {
      ...base,
      target: s.target || { candidates: [] },
      name: s.name || '',
      value: s.value,
      remove: !!s.remove,
    };
  if (t === 'loopElements')
    return {
      ...base,
      selector: s.selector || '',
      saveAs: s.saveAs || 'elements',
      itemVar: s.itemVar || 'item',
      subflowId: s.subflowId || '',
    };
  if (t === 'switchFrame')
    return {
      ...base,
      frame: {
        index: s.frame && s.frame.index != null ? Number(s.frame.index) : undefined,
        urlContains: s.frame?.urlContains || '',
      },
    };
  return { ...base };
}

export function stepsToNodes(steps: any[]): RRNode[] {
  const arr: RRNode[] = [];
  steps.forEach((s, i) => {
    const id = s.id || `n_${i}`;
    arr.push({ id, type: String(s.type || 'script'), config: mapStepToNodeConfig(s) });
  });
  return arr;
}

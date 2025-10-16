// runner.ts — orchestrates record-replay flow execution using registry + utils
// Note: comments in English

import { TOOL_NAMES } from 'chrome-mcp-shared';
import { handleCallTool } from '../tools';
import type { Flow, RunLogEntry, RunRecord, RunResult, Step, StepScript } from './types';
import { appendRun } from './flow-store';
import {
  mapDagNodeToStep,
  topoOrder,
  ensureTab,
  expandTemplatesDeep,
  waitForNetworkIdle,
  applyAssign,
  defaultEdgesOnly,
  waitForNavigation,
} from './rr-utils';
import { executeStep } from './node-registry';

export interface RunOptions {
  tabTarget?: 'current' | 'new';
  refresh?: boolean;
  captureNetwork?: boolean;
  returnLogs?: boolean;
  timeoutMs?: number;
  startUrl?: string;
  args?: Record<string, any>;
  startNodeId?: string;
}

export async function runFlow(flow: Flow, options: RunOptions = {}): Promise<RunResult> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startAt = Date.now();
  const logs: RunLogEntry[] = [];
  // Global deadline for run (optional)
  const globalTimeout = Math.max(0, Number(options.timeoutMs || 0));
  const deadline = globalTimeout > 0 ? startAt + globalTimeout : 0;
  const ensureWithinDeadline = () => {
    if (deadline > 0 && Date.now() > deadline) {
      const err = new Error('Global timeout reached');
      // mark a synthetic log entry for visibility
      logs.push({ stepId: 'global-timeout', status: 'failed', message: 'Global timeout reached' });
      throw err;
    }
  };

  // prepare variables
  const vars: Record<string, any> = Object.create(null);
  for (const v of flow.variables || []) if (v.default !== undefined) vars[v.key] = v.default;
  if (options.args) Object.assign(vars, options.args);

  // Derive a default startUrl when not provided: prefer first navigate step
  let derivedStartUrl: string | undefined = undefined;
  try {
    // We haven't computed stepsToRun yet; compute minimal set from flow for derive
    const hasDag0 = Array.isArray((flow as any).nodes) && (flow as any).nodes.length > 0;
    const nodes0 = hasDag0 ? (((flow as any).nodes || []) as any[]) : [];
    const edges0 = hasDag0 ? (((flow as any).edges || []) as any[]) : [];
    const defaultEdges0 = hasDag0 ? defaultEdgesOnly(edges0 as any) : [];
    const order0 = hasDag0 ? topoOrder(nodes0 as any, defaultEdges0 as any) : [];
    const steps0: Step[] = hasDag0
      ? order0.map((n) => mapDagNodeToStep(n as any))
      : ((flow.steps || []) as Step[]);
    const nav = steps0.find((s: any) => s && (s as any).type === 'navigate') as any;
    if (nav && typeof nav.url === 'string') derivedStartUrl = expandTemplatesDeep(nav.url, {});
  } catch {}
  const ensured = await ensureTab({
    tabTarget: options.tabTarget,
    startUrl: options.startUrl || derivedStartUrl,
    refresh: options.refresh,
  });

  // pre-load read_page to init bridges only when on a web page (avoid builder.html)
  try {
    const u = ensured?.url || '';
    if (/^(https?:|file:)/i.test(u)) {
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    }
  } catch {}

  // collect required variables via overlay prompt
  try {
    const needed = (flow.variables || []).filter(
      (v) =>
        (options.args?.[v.key] == null || options.args?.[v.key] === '') &&
        (v.rules?.required || (v.default ?? '') === ''),
    );
    if (needed.length) {
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
        args: {
          eventName: 'collectVariables',
          payload: JSON.stringify({ variables: needed, useOverlay: true }),
        },
      });
      let values: Record<string, any> | null = null;
      try {
        const t = (res?.content || []).find((c: any) => c.type === 'text')?.text;
        const j = t ? JSON.parse(t) : null;
        if (j && j.success && j.values) values = j.values;
      } catch {}
      if (!values) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs?.[0]?.id;
        if (typeof tabId === 'number') {
          const res2 = await chrome.tabs.sendMessage(tabId, {
            action: 'collectVariables',
            variables: needed,
            useOverlay: true,
          } as any);
          if (res2 && res2.success && res2.values) values = res2.values;
        }
      }
      if (values) Object.assign(vars, values);
    }
  } catch {}

  // init overlay for on-screen log
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id)
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'rr_overlay', cmd: 'init' } as any);
  } catch {}

  // binding enforcement
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs?.[0]?.url || '';
    const bindings = flow.meta?.bindings || [];
    if (!options.startUrl && bindings.length > 0) {
      const ok = bindings.some((b) => {
        try {
          if (b.type === 'domain') return new URL(currentUrl).hostname.includes(b.value);
          if (b.type === 'path') return new URL(currentUrl).pathname.startsWith(b.value);
          if (b.type === 'url') return currentUrl.startsWith(b.value);
        } catch {}
        return false;
      });
      if (!ok) {
        return {
          runId,
          success: false,
          summary: { total: 0, success: 0, failed: 0, tookMs: 0 },
          url: currentUrl,
          outputs: null,
          logs: [
            {
              stepId: 'binding-check',
              status: 'failed',
              message:
                'Flow binding mismatch. Provide startUrl or open a page matching flow.meta.bindings.',
            },
          ],
          screenshots: { onFailure: null },
        } as RunResult;
      }
    }
  } catch {}

  // long-running network capture (debugger) if requested
  let networkCaptureStarted = false;
  const stopAndSummarizeNetwork = async () => {
    try {
      const stopRes = await handleCallTool({
        name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
        args: {},
      });
      const text = (stopRes?.content || []).find((c: any) => c.type === 'text')?.text;
      if (!text) return;
      const data = JSON.parse(text);
      const requests: any[] = Array.isArray(data?.requests) ? data.requests : [];
      const snippets = requests
        .filter((r) => ['XHR', 'Fetch'].includes(String(r.type)))
        .slice(0, 10)
        .map((r) => ({
          method: String(r.method || 'GET'),
          url: String(r.url || ''),
          status: r.statusCode || r.status,
          ms: Math.max(0, (r.responseTime || 0) - (r.requestTime || 0)),
        }));
      logs.push({
        stepId: 'network-capture',
        status: 'success',
        message: `Captured ${Number(data?.requestCount || 0)} requests` as any,
        networkSnippets: snippets,
      } as any);
    } catch {}
  };
  if (options.captureNetwork) {
    try {
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
        args: { includeStatic: false, maxCaptureTime: 3 * 60_000, inactivityTimeout: 0 },
      });
      if (!(res as any)?.isError) networkCaptureStarted = true;
    } catch {}
  }

  const hasDag = Array.isArray((flow as any).nodes) && (flow as any).nodes.length > 0;
  const nodes = hasDag ? (((flow as any).nodes || []) as any[]) : [];
  const edges = hasDag ? (((flow as any).edges || []) as any[]) : [];
  const defaultEdges = hasDag ? defaultEdgesOnly(edges as any) : [];
  const order = hasDag ? topoOrder(nodes as any, defaultEdges as any) : [];
  const stepsToRun: Step[] = hasDag
    ? order.map((n) => mapDagNodeToStep(n as any))
    : ((flow.steps || []) as Step[]);
  const startIdx =
    !hasDag && options.startNodeId
      ? stepsToRun.findIndex((s) => s?.id === options.startNodeId)
      : -1;
  const steps = !hasDag
    ? startIdx >= 0
      ? stepsToRun.slice(startIdx)
      : stepsToRun.slice()
    : stepsToRun;

  let failed = 0;
  const logger = (e: RunLogEntry) => logs.push(e);
  const ctx = { vars, logger };

  // deferred after-scripts
  const pendingAfterScripts: StepScript[] = [];

  // small helpers
  const appendOverlay = async (text: string) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id)
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: 'rr_overlay',
          cmd: 'append',
          text,
        } as any);
    } catch {}
  };
  const evalCondition = (cond: any): boolean => {
    try {
      if (cond && typeof cond.expression === 'string' && cond.expression.trim()) {
        const fn = new Function(
          'vars',
          `try { return !!(${cond.expression}); } catch (e) { return false; }`,
        );
        return !!fn(vars);
      }
      if (cond && typeof cond.var === 'string') {
        const v = vars[cond.var];
        if ('equals' in cond) return String(v) === String(cond.equals);
        return !!v;
      }
    } catch {}
    return false;
  };

  // execute a subflow by id (default edges only)
  const runSubflowById = async (subflowId: string) => {
    const sub = (flow.subflows || {})[subflowId];
    if (!sub || !Array.isArray(sub.nodes) || sub.nodes.length === 0) return;
    const sNodes: any[] = sub.nodes;
    const sEdges: any[] = defaultEdgesOnly((sub.edges || []) as any) as any[];
    const sOrder = topoOrder(sNodes as any, sEdges as any);
    const sSteps: Step[] = sOrder.map((n) => mapDagNodeToStep(n as any)) as any;
    for (const step of sSteps) {
      const t0 = Date.now();
      const maxRetries = Math.max(0, (step as any).retry?.count ?? 0);
      const baseInterval = Math.max(0, (step as any).retry?.intervalMs ?? 0);
      let attempt = 0;
      const doDelay = async (i: number) => {
        const delay =
          baseInterval > 0
            ? (step as any).retry?.backoff === 'exp'
              ? baseInterval * Math.pow(2, i)
              : baseInterval
            : 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      };
      while (true) {
        try {
          const beforeInfo = await getActiveTabInfo();
          const result = await executeStep(ctx, step);
          if ((step.type === 'click' || step.type === 'dblclick') && (step as any).after) {
            const after = (step as any).after as any;
            if (after.waitForNavigation)
              await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            else if (after.waitForNetworkIdle)
              await waitForNetworkIdle(Math.min((step as any).timeoutMs || 5000, 120000), 1200);
          }
          if (step.type === 'navigate' || step.type === 'openTab') {
            await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            await ensureReadPageIfWeb();
          } else if (step.type === 'switchTab') {
            await ensureReadPageIfWeb();
          }
          if (!result?.alreadyLogged)
            logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          await appendOverlay(`✔ ${step.type} (${step.id})`);
          break;
        } catch (e: any) {
          if (attempt < maxRetries) {
            logs.push({ stepId: step.id, status: 'retrying', message: e?.message || String(e) });
            await doDelay(attempt);
            attempt += 1;
            continue;
          }
          logs.push({
            stepId: step.id,
            status: 'failed',
            message: e?.message || String(e),
            tookMs: Date.now() - t0,
          });
          await appendOverlay(`✘ ${step.type} (${step.id}) -> ${e?.message || String(e)}`);
          if ((step as any).screenshotOnFail !== false) {
            try {
              const shot = await handleCallTool({
                name: TOOL_NAMES.BROWSER.COMPUTER,
                args: { action: 'screenshot' },
              });
              const img = (shot?.content?.find((c: any) => c.type === 'image') as any)
                ?.data as string;
              if (img) logs[logs.length - 1].screenshotBase64 = img;
            } catch {}
          }
          throw e;
        }
      }
    }
  };
  const getActiveTabInfo = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return { url: tab?.url || '', status: (tab as any)?.status || '' };
  };
  const waitForNavigationDone = async (prevUrl: string, timeoutMs?: number) => {
    await waitForNavigation(timeoutMs, prevUrl);
  };
  const isWebUrl = (u?: string | null) => !!u && /^(https?:|file:)/i.test(String(u || ''));
  const ensureReadPageIfWeb = async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs?.[0]?.url || '';
      if (isWebUrl(url)) {
        await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
      }
    } catch {}
  };

  try {
    if (!hasDag) {
      // Linear execution (legacy steps)
      for (const step of steps) {
        const t0 = Date.now();
        ensureWithinDeadline();
        const maxRetries = Math.max(0, (step as any).retry?.count ?? 0);
        const baseInterval = Math.max(0, (step as any).retry?.intervalMs ?? 0);
        let attempt = 0;
        const doDelay = async (i: number) => {
          const delay =
            baseInterval > 0
              ? (step as any).retry?.backoff === 'exp'
                ? baseInterval * Math.pow(2, i)
                : baseInterval
              : 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        };
        while (true) {
          try {
            const beforeInfo = await getActiveTabInfo();
            // special handling for script when=after: defer
            if (step.type === 'script' && (step as any).when === 'after') {
              pendingAfterScripts.push(step as any);
              logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
              break;
            }
            const result = await executeStep(ctx, step);
            // handle click/dblclick after.waitForNavigation / waitForNetworkIdle
            if ((step.type === 'click' || step.type === 'dblclick') && (step as any).after) {
              const after = (step as any).after as any;
              if (after.waitForNavigation)
                await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
              else if (after.waitForNetworkIdle)
                await waitForNetworkIdle(Math.min((step as any).timeoutMs || 5000, 120000), 1200);
            }
            if (step.type === 'navigate' || step.type === 'openTab') {
              await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
              await ensureReadPageIfWeb();
            } else if (step.type === 'switchTab') {
              await ensureReadPageIfWeb();
            }
            if (!result?.alreadyLogged) {
              logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
            }
            await appendOverlay(`✔ ${step.type} (${step.id})`);
            // control flows
            if (result?.control) {
              if (result.control.kind === 'foreach') {
                const list = Array.isArray(vars[result.control.listVar])
                  ? (vars[result.control.listVar] as any[])
                  : [];
                for (const it of list) {
                  vars[result.control.itemVar] = it;
                  await runSubflowById(result.control.subflowId);
                }
              } else if (result.control.kind === 'while') {
                let i = 0;
                while (
                  i < result.control.maxIterations &&
                  evalCondition(result.control.condition)
                ) {
                  await runSubflowById(result.control.subflowId);
                  i++;
                }
              }
            }
            if (result?.deferAfterScript) pendingAfterScripts.push(result.deferAfterScript);
            // run any deferred after-scripts
            if (pendingAfterScripts.length > 0) {
              while (pendingAfterScripts.length) {
                const s = pendingAfterScripts.shift()!;
                const tScript = Date.now();
                const world = (s as any).world || 'ISOLATED';
                const code = String((s as any).code || '');
                if (code.trim()) {
                  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                  const tabId = tabs?.[0]?.id;
                  if (typeof tabId !== 'number') throw new Error('Active tab not found');
                  const [{ result }] = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (userCode: string) => {
                      try {
                        return (0, eval)(userCode);
                      } catch {
                        return null;
                      }
                    },
                    args: [code],
                    world: world as any,
                  } as any);
                  if ((s as any).saveAs) vars[(s as any).saveAs] = result;
                  if ((s as any).assign && typeof (s as any).assign === 'object')
                    applyAssign(vars, result, (s as any).assign);
                }
                logs.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
              }
            }
            break; // success
          } catch (e: any) {
            if (attempt < maxRetries) {
              logs.push({ stepId: step.id, status: 'retrying', message: e?.message || String(e) });
              await doDelay(attempt);
              attempt += 1;
              continue;
            }
            failed++;
            logs.push({
              stepId: step.id,
              status: 'failed',
              message: e?.message || String(e),
              tookMs: Date.now() - t0,
            });
            await appendOverlay(`✘ ${step.type} (${step.id}) -> ${e?.message || String(e)}`);
            if ((step as any).screenshotOnFail !== false) {
              try {
                const shot = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.COMPUTER,
                  args: { action: 'screenshot' },
                });
                const img = (shot?.content?.find((c: any) => c.type === 'image') as any)
                  ?.data as string;
                if (img) logs[logs.length - 1].screenshotBase64 = img;
              } catch {}
            }
            throw e;
          }
        }
      }
    } else {
      // Graph traversal execution (DAG)
      const id2node = new Map(nodes.map((n: any) => [n.id, n] as const));
      const outEdges = new Map<string, Array<any>>();
      for (const e of edges) {
        if (!outEdges.has(e.from)) outEdges.set(e.from, []);
        outEdges.get(e.from)!.push(e);
      }
      const indeg = new Map<string, number>(nodes.map((n: any) => [n.id, 0] as const));
      for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
      let currentId =
        options.startNodeId && id2node.has(options.startNodeId)
          ? options.startNodeId
          : nodes.find((n: any) => (indeg.get(n.id) || 0) === 0)?.id || nodes[0]?.id;
      let guard = 0;
      while (currentId && guard++ < 10000) {
        ensureWithinDeadline();
        const node = id2node.get(currentId);
        if (!node) break;
        const step: any = mapDagNodeToStep(node as any);
        const t0 = Date.now();
        const maxRetries = Math.max(0, (step as any).retry?.count ?? 0);
        const baseInterval = Math.max(0, (step as any).retry?.intervalMs ?? 0);
        let attempt = 0;
        const doDelay = async (i: number) => {
          const delay =
            baseInterval > 0
              ? (step as any).retry?.backoff === 'exp'
                ? baseInterval * Math.pow(2, i)
                : baseInterval
              : 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        };
        const beforeInfo = await getActiveTabInfo();
        let jumpedOnError = false;
        try {
          const result = await executeStep(ctx, step);
          if ((step.type === 'click' || step.type === 'dblclick') && (step as any).after) {
            const after = (step as any).after as any;
            if (after.waitForNavigation)
              await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            else if (after.waitForNetworkIdle)
              await waitForNetworkIdle(Math.min((step as any).timeoutMs || 5000, 120000), 1200);
          }
          if (step.type === 'navigate' || step.type === 'openTab') {
            await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            await ensureReadPageIfWeb();
          } else if (step.type === 'switchTab') {
            await ensureReadPageIfWeb();
          }
          if (!result?.alreadyLogged)
            logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          await appendOverlay(`✔ ${step.type} (${step.id})`);
          // choose next by label
          let nextLabel: string = 'default';
          if (result?.nextLabel) nextLabel = String(result.nextLabel);
          const oes = (outEdges.get(currentId) || []) as any[];
          const edge =
            oes.find((e) => String(e.label || 'default') === nextLabel) ||
            oes.find((e) => !e.label || e.label === 'default');
          currentId = edge ? edge.to : undefined;
        } catch (e: any) {
          if (attempt < maxRetries) {
            logs.push({ stepId: step.id, status: 'retrying', message: e?.message || String(e) });
            await doDelay(attempt);
            attempt += 1;
            continue;
          }
          logs.push({
            stepId: step.id,
            status: 'failed',
            message: e?.message || String(e),
            tookMs: Date.now() - t0,
          });
          await appendOverlay(`✘ ${step.type} (${step.id}) -> ${e?.message || String(e)}`);
          if ((step as any).screenshotOnFail !== false) {
            try {
              const shot = await handleCallTool({
                name: TOOL_NAMES.BROWSER.COMPUTER,
                args: { action: 'screenshot' },
              });
              const img = (shot?.content?.find((c: any) => c.type === 'image') as any)
                ?.data as string;
              if (img) logs[logs.length - 1].screenshotBase64 = img;
            } catch {}
          }
          // onError jump
          const oes = (outEdges.get(currentId) || []) as any[];
          const errEdge = oes.find((e) => e.label === 'onError');
          if (errEdge) {
            currentId = errEdge.to;
            jumpedOnError = true;
          } else {
            throw e;
          }
        }
        if (!jumpedOnError) {
          // flush deferred after-scripts
          if (pendingAfterScripts.length > 0) {
            while (pendingAfterScripts.length) {
              const s = pendingAfterScripts.shift()!;
              const tScript = Date.now();
              const world = (s as any).world || 'ISOLATED';
              const code = String((s as any).code || '');
              if (code.trim()) {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabId = tabs?.[0]?.id;
                if (typeof tabId !== 'number') throw new Error('Active tab not found');
                const [{ result }] = await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (userCode: string) => {
                    try {
                      return (0, eval)(userCode);
                    } catch {
                      return null;
                    }
                  },
                  args: [code],
                  world: world as any,
                } as any);
                if ((s as any).saveAs) vars[(s as any).saveAs] = result;
                if ((s as any).assign && typeof (s as any).assign === 'object')
                  applyAssign(vars, result, (s as any).assign);
              }
              logs.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
            }
          }
        }
      }
    }
  } finally {
    if (networkCaptureStarted) await stopAndSummarizeNetwork();
  }

  const tookMs = Date.now() - startAt;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id)
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'rr_overlay', cmd: 'done' } as any);
  } catch {}

  const record: RunRecord = {
    id: runId,
    flowId: flow.id,
    startedAt: new Date(startAt).toISOString(),
    finishedAt: new Date().toISOString(),
    success: failed === 0,
    entries: logs,
  };
  await appendRun(record);

  // outputs: filter sensitive variables
  const sensitiveKeys = new Set(
    (flow.variables || []).filter((v) => v.sensitive).map((v) => v.key),
  );
  const outputs: Record<string, any> = {};
  for (const [k, v] of Object.entries(vars)) if (!sensitiveKeys.has(k)) outputs[k] = v;

  return {
    runId,
    success: failed === 0,
    summary: { total: steps.length, success: steps.length - failed, failed, tookMs },
    url: null,
    outputs,
    logs: options.returnLogs ? logs : undefined,
    screenshots: { onFailure: logs.find((l) => l.status === 'failed')?.screenshotBase64 },
  };
}

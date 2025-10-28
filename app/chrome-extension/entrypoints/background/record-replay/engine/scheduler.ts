// engine/scheduler.ts — DAG-only orchestrator for record-replay
// Core responsibilities are split across: Orchestrator (prepare → traverse → cleanup),
// policies (wait/retry), nodes registry (executeStep), logger (overlay/persist), plugins (hooks).

import { TOOL_NAMES } from 'chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { Flow, RunLogEntry, RunResult, Step, StepScript } from '../types';
import {
  mapDagNodeToStep,
  topoOrder,
  ensureTab,
  expandTemplatesDeep,
  waitForNetworkIdle,
  applyAssign,
  defaultEdgesOnly,
} from '../rr-utils';
import { executeStep, type ExecCtx } from '../nodes';
import { RunLogger } from './logging/run-logger';
import { PluginManager } from './plugins/manager';
import type { RunPlugin } from './plugins/types';
import { breakpointPlugin } from './plugins/breakpoint';
import { waitForNavigationDone, maybeQuickWaitForNav, ensureReadPageIfWeb } from './policies/wait';
import { withRetry } from './policies/retry';
import { runState } from './state-manager';

export interface RunOptions {
  tabTarget?: 'current' | 'new';
  refresh?: boolean;
  captureNetwork?: boolean;
  returnLogs?: boolean;
  timeoutMs?: number;
  startUrl?: string;
  args?: Record<string, any>;
  startNodeId?: string;
  plugins?: RunPlugin[];
}

class ExecutionOrchestrator {
  private runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private startAt = Date.now();
  private logger = new RunLogger(this.runId);
  private pluginManager = new PluginManager(
    this.options.plugins && this.options.plugins.length
      ? this.options.plugins
      : [breakpointPlugin()],
  );
  private vars: Record<string, any> = Object.create(null);
  private deadline = 0;
  private networkCaptureStarted = false;
  private paused = false;
  private failed = 0;
  private pendingAfterScripts: StepScript[] = [];
  private steps: Step[] = [];
  private prepareError: RunResult | null = null;

  constructor(
    private flow: Flow,
    private options: RunOptions = {},
  ) {
    for (const v of flow.variables || []) if (v.default !== undefined) this.vars[v.key] = v.default;
    if (options.args) Object.assign(this.vars, options.args);
    const globalTimeout = Math.max(0, Number(options.timeoutMs || 0));
    this.deadline = globalTimeout > 0 ? this.startAt + globalTimeout : 0;
  }

  private ensureWithinDeadline() {
    if (this.deadline > 0 && Date.now() > this.deadline) {
      const err = new Error('Global timeout reached');
      this.logger.push({
        stepId: 'global-timeout',
        status: 'failed',
        message: 'Global timeout reached',
      });
      throw err;
    }
  }

  async run(): Promise<RunResult> {
    try {
      await this.prepareExecution();
      if (this.prepareError) return this.prepareError;
      return await this.traverseDag();
    } finally {
      await this.cleanup();
    }
  }

  private async prepareExecution() {
    // Derive default startUrl
    let derivedStartUrl: string | undefined;
    try {
      const hasDag0 = Array.isArray(this.flow.nodes) && this.flow.nodes.length > 0;
      const nodes0 = hasDag0 ? this.flow.nodes || [] : [];
      const edges0 = hasDag0 ? this.flow.edges || [] : [];
      const defaultEdges0 = hasDag0 ? defaultEdgesOnly(edges0) : [];
      const order0 = hasDag0 ? topoOrder(nodes0, defaultEdges0) : [];
      const steps0: Step[] = hasDag0 ? order0.map((n) => mapDagNodeToStep(n)) : [];
      const nav = steps0.find((s) => s && s.type === 'navigate');
      if (nav && typeof (nav as any).url === 'string')
        derivedStartUrl = expandTemplatesDeep((nav as any).url, {});
    } catch {}

    const ensured = await ensureTab({
      tabTarget: this.options.tabTarget,
      startUrl: this.options.startUrl || derivedStartUrl,
      refresh: this.options.refresh,
    });

    // register run state
    await runState.restore();
    await runState.add(this.runId, {
      id: this.runId,
      flowId: this.flow.id,
      name: this.flow.name,
      status: 'running',
      startedAt: this.startAt,
      updatedAt: this.startAt,
    });

    await this.pluginManager.runStart({ runId: this.runId, flow: this.flow, vars: this.vars });

    // pre-load read_page when on web
    try {
      const u = ensured?.url || '';
      if (/^(https?:|file:)/i.test(u))
        await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    } catch {}

    // overlay variable collection
    try {
      const needed = (this.flow.variables || []).filter(
        (v) =>
          (this.options.args?.[v.key] == null || this.options.args?.[v.key] === '') &&
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
        if (values) Object.assign(this.vars, values);
      }
    } catch {}

    await this.logger.overlayInit();

    // binding enforcement
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentUrl = tabs?.[0]?.url || '';
      const bindings = this.flow.meta?.bindings || [];
      if (!this.options.startUrl && bindings.length > 0) {
        const ok = bindings.some((b) => {
          try {
            if (b.type === 'domain') return new URL(currentUrl).hostname.includes(b.value);
            if (b.type === 'path') return new URL(currentUrl).pathname.startsWith(b.value);
            if (b.type === 'url') return currentUrl.startsWith(b.value);
          } catch {}
          return false;
        });
        if (!ok) {
          this.prepareError = {
            runId: this.runId,
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
            paused: false,
          };
          return;
        }
      }
    } catch {}

    // network capture start
    if (this.options.captureNetwork) {
      try {
        const res = await handleCallTool({
          name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
          args: { includeStatic: false, maxCaptureTime: 3 * 60_000, inactivityTimeout: 0 },
        });
        if (!(res as any)?.isError) this.networkCaptureStarted = true;
      } catch {}
    }

    // build DAG steps
    const hasDag = Array.isArray((this.flow as any).nodes) && (this.flow as any).nodes.length > 0;
    if (!hasDag) {
      this.prepareError = {
        runId: this.runId,
        success: false,
        summary: { total: 0, success: 0, failed: 0, tookMs: 0 },
        url: null,
        outputs: null,
        logs: [
          {
            stepId: 'dag-required',
            status: 'failed',
            message:
              'Flow has no DAG nodes. Linear steps are no longer supported. Please migrate this flow to nodes/edges.',
          },
        ],
        screenshots: { onFailure: null },
        paused: false,
      };
      return;
    }
    const nodes = ((this.flow as any).nodes || []) as any[];
    const edges = ((this.flow as any).edges || []) as any[];
    const defaultEdges = defaultEdgesOnly(edges as any);
    const order = topoOrder(nodes as any, defaultEdges as any);
    this.steps = order.map((n) => mapDagNodeToStep(n as any));
  }

  private async executeSingleStep(
    step: Step,
    ctx: ExecCtx,
    appendOverlayOk: (s: Step) => Promise<void> | void,
    appendOverlayFail: (s: Step, e: any) => Promise<void> | void,
  ): Promise<{ status: 'success' | 'failed' | 'paused'; nextLabel?: string; control?: any }> {
    const t0 = Date.now();
    this.ensureWithinDeadline();
    const ctrlStart = await this.pluginManager.beforeStep({
      runId: this.runId,
      flow: this.flow,
      vars: this.vars,
      step,
    });
    if (ctrlStart?.pause) return { status: 'paused' };
    let stepNextLabel: string | undefined;
    let controlOut: any = undefined;
    const beforeInfo = await getActiveTabInfo();
    try {
      await withRetry(
        async () => {
          const result: any = await executeStep(ctx, step);
          if (step.type === 'click' || step.type === 'dblclick') {
            const after = ((step as any).after || {}) as any;
            if (after.waitForNavigation)
              await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            else if (after.waitForNetworkIdle)
              await waitForNetworkIdle(Math.min((step as any).timeoutMs || 5000, 120000), 1200);
            else await maybeQuickWaitForNav(beforeInfo.url, (step as any).timeoutMs);
          }
          if (step.type === 'navigate' || step.type === 'openTab') {
            await waitForNavigationDone(beforeInfo.url, (step as any).timeoutMs);
            await ensureReadPageIfWeb();
          } else if (step.type === 'switchTab') {
            await ensureReadPageIfWeb();
          }
          if (!result?.alreadyLogged)
            this.logger.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          await this.pluginManager.afterStep({
            runId: this.runId,
            flow: this.flow,
            vars: this.vars,
            step,
            result,
          });
          await appendOverlayOk(step);
          if (result?.nextLabel) stepNextLabel = String(result.nextLabel);
          if (result?.control) controlOut = result.control;
          if (result?.deferAfterScript) this.pendingAfterScripts.push(result.deferAfterScript);
          await flushAfterScripts(ctx, this.pendingAfterScripts, this.vars, this.logger);
        },
        async (attempt, e) => {
          this.logger.push({
            stepId: step.id,
            status: 'retrying',
            message: e?.message || String(e),
          });
          await this.pluginManager.onRetry({
            runId: this.runId,
            flow: this.flow,
            vars: this.vars,
            step,
            error: e,
            attempt,
          });
        },
        {
          count: Math.max(0, (step as any).retry?.count ?? 0),
          intervalMs: Math.max(0, (step as any).retry?.intervalMs ?? 0),
          backoff: (step as any).retry?.backoff || 'none',
        },
      );
    } catch (e: any) {
      this.failed++;
      this.logger.push({
        stepId: step.id,
        status: 'failed',
        message: e?.message || String(e),
        tookMs: Date.now() - t0,
      });
      await appendOverlayFail(step, e);
      if ((step as any).screenshotOnFail !== false) await this.logger.screenshotOnFailure();
      const hook = await this.pluginManager.onError({
        runId: this.runId,
        flow: this.flow,
        vars: this.vars,
        step,
        error: e,
      });
      if (hook?.pause) return { status: 'paused' };
      return { status: 'failed' };
    }
    // Propagate control (foreach/while) to caller
    return { status: 'success', nextLabel: stepNextLabel, control: controlOut };
  }

  private async runSubflowById(subflowId: string, ctx: ExecCtx) {
    const sub = (this.flow.subflows || {})[subflowId];
    if (!sub || !Array.isArray(sub.nodes) || sub.nodes.length === 0) return;
    await this.pluginManager.subflowStart({
      runId: this.runId,
      flow: this.flow,
      vars: this.vars,
      subflowId,
    });
    const sNodes: any[] = sub.nodes;
    const sEdges: any[] = defaultEdgesOnly((sub.edges || []) as any) as any[];
    const sOrder = topoOrder(sNodes as any, sEdges as any);
    const sSteps: Step[] = sOrder.map((n) => mapDagNodeToStep(n as any)) as any;
    const ok = (s: Step) => this.logger.overlayAppend(`✔ ${s.type} (${s.id})`);
    const fail = (s: Step, e: any) =>
      this.logger.overlayAppend(`✘ ${s.type} (${s.id}) -> ${e?.message || String(e)}`);
    for (const step of sSteps) {
      this.ensureWithinDeadline();
      const r = await this.executeSingleStep(step, ctx, ok, fail);
      if (r.status === 'paused') {
        this.paused = true;
        break;
      }
      if (this.paused) break;
    }
    await this.pluginManager.subflowEnd({
      runId: this.runId,
      flow: this.flow,
      vars: this.vars,
      subflowId,
    });
  }

  private async traverseDag(): Promise<RunResult> {
    if (!this.steps.length) {
      await this.logger.overlayDone();
      return this.prepareError!;
    }
    const nodes = ((this.flow as any).nodes || []) as any[];
    const edges = ((this.flow as any).edges || []) as any[];
    const id2node = new Map(nodes.map((n: any) => [n.id, n] as const));
    const outEdges = new Map<string, Array<any>>();
    for (const e of edges) {
      if (!outEdges.has(e.from)) outEdges.set(e.from, []);
      outEdges.get(e.from)!.push(e);
    }
    const indeg = new Map<string, number>(nodes.map((n: any) => [n.id, 0] as const));
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    let currentId =
      this.options.startNodeId && id2node.has(this.options.startNodeId)
        ? this.options.startNodeId
        : nodes.find((n: any) => (indeg.get(n.id) || 0) === 0)?.id || nodes[0]?.id;
    let guard = 0;
    const ctx: ExecCtx = { vars: this.vars, logger: (e: RunLogEntry) => this.logger.push(e) };
    while (currentId && guard++ < 10000) {
      this.ensureWithinDeadline();
      const node = id2node.get(currentId);
      if (!node) break;
      const step: any = mapDagNodeToStep(node as any);
      const r = await this.executeSingleStep(
        step,
        ctx,
        (s) => this.logger.overlayAppend(`✔ ${s.type} (${s.id})`),
        (s, e) => this.logger.overlayAppend(`✘ ${s.type} (${s.id}) -> ${e?.message || String(e)}`),
      );
      if (r.status === 'paused') {
        this.paused = true;
        break;
      }
      if (r.status === 'failed') {
        const oes = (outEdges.get(currentId) || []) as any[];
        const errEdge = oes.find((edg) => edg.label === 'onError');
        if (errEdge) {
          currentId = errEdge.to;
          continue;
        } else {
          break;
        }
      }
      if ((r as any).control) {
        const control = (r as any).control;
        if (control?.kind === 'foreach') {
          const list = Array.isArray(this.vars[control.listVar])
            ? (this.vars[control.listVar] as any[])
            : [];
          for (const it of list) {
            this.vars[control.itemVar] = it;
            await this.runSubflowById(control.subflowId, ctx);
            if (this.paused) break;
          }
        } else if (control?.kind === 'while') {
          let i = 0;
          while (i < control.maxIterations && this.evalCondition(control.condition)) {
            await this.runSubflowById(control.subflowId, ctx);
            if (this.paused) break;
            i++;
          }
        }
        if (this.paused) break;
      }
      // choose next by label
      let nextLabel: string = r.nextLabel ? String(r.nextLabel) : 'default';
      const override = await this.pluginManager.onChooseNextLabel({
        runId: this.runId,
        flow: this.flow,
        vars: this.vars,
        step,
        suggested: nextLabel,
      });
      if (override) nextLabel = String(override);
      const oes = (outEdges.get(currentId) || []) as any[];
      const edge =
        oes.find((e) => String(e.label || 'default') === nextLabel) ||
        oes.find((e) => !e.label || e.label === 'default');
      currentId = edge ? edge.to : undefined;
    }
    const tookMs = Date.now() - this.startAt;
    const sensitiveKeys = new Set(
      (this.flow.variables || []).filter((v) => v.sensitive).map((v) => v.key),
    );
    const outputs: Record<string, any> = {};
    for (const [k, v] of Object.entries(this.vars)) if (!sensitiveKeys.has(k)) outputs[k] = v;
    return {
      runId: this.runId,
      success: !this.paused && this.failed === 0,
      summary: {
        total: this.steps.length,
        success: this.steps.length - this.failed,
        failed: this.failed,
        tookMs,
      },
      url: null,
      outputs,
      logs: this.options.returnLogs ? this.logger.getLogs() : undefined,
      screenshots: {
        onFailure: this.logger.getLogs().find((l) => l.status === 'failed')?.screenshotBase64,
      },
      paused: this.paused,
    };
  }

  private evalCondition(cond: any): boolean {
    try {
      if (cond && typeof cond.expression === 'string' && cond.expression.trim()) {
        const fn = new Function(
          'vars',
          `try { return !!(${cond.expression}); } catch (e) { return false; }`,
        );
        return !!fn(this.vars);
      }
      if (cond && typeof cond.var === 'string') {
        const v = this.vars[cond.var];
        if ('equals' in cond) return String(v) === String(cond.equals);
        return !!v;
      }
    } catch {}
    return false;
  }

  private async cleanup() {
    if (this.networkCaptureStarted) {
      try {
        const stopRes = await handleCallTool({
          name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
          args: {},
        });
        const text = (stopRes?.content || []).find((c: any) => c.type === 'text')?.text;
        if (text) {
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
          this.logger.push({
            stepId: 'network-capture',
            status: 'success',
            message: `Captured ${Number(data?.requestCount || 0)} requests` as any,
            networkSnippets: snippets,
          } as any);
        }
      } catch {}
    }
    await this.logger.overlayDone();
    try {
      await this.pluginManager.runEnd({
        runId: this.runId,
        flow: this.flow,
        vars: this.vars,
        success: this.failed === 0 && !this.paused,
        failed: this.failed,
      });
      if (!this.paused) await this.logger.persist(this.flow, this.startAt, this.failed === 0);
      await runState.update(this.runId, {
        status: this.paused ? 'stopped' : this.failed === 0 ? 'completed' : 'failed',
        updatedAt: Date.now(),
      } as any);
      if (!this.paused) await runState.delete(this.runId);
    } catch {}
  }
}

export async function runFlow(flow: Flow, options: RunOptions = {}): Promise<RunResult> {
  const orchestrator = new ExecutionOrchestrator(flow, options);
  return await orchestrator.run();
}

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  return { url: tab?.url || '', status: (tab as any)?.status || '' };
}

async function flushAfterScripts(
  ctx: ExecCtx,
  pendingAfterScripts: StepScript[],
  vars: Record<string, any>,
  logger: RunLogger,
) {
  if (pendingAfterScripts.length === 0) return;
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
      if ((s as any).saveAs) (vars as any)[(s as any).saveAs] = result;
      if ((s as any).assign && typeof (s as any).assign === 'object')
        applyAssign(vars, result, (s as any).assign);
    }
    logger.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
  }
}

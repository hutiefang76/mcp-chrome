import { TOOL_NAMES } from 'chrome-mcp-shared';
import { handleCallTool } from '../tools';
import {
  Flow,
  RunLogEntry,
  RunRecord,
  RunResult,
  Step,
  StepAssert,
  StepFill,
  StepKey,
  StepScroll,
  StepDrag,
  StepWait,
  StepScript,
} from './types';
import { appendRun } from './flow-store';
import { locateElement } from './selector-engine';

// design note: linear flow executor using existing tools; keeps logs and failure screenshot

export interface RunOptions {
  tabTarget?: 'current' | 'new';
  refresh?: boolean;
  captureNetwork?: boolean;
  returnLogs?: boolean;
  timeoutMs?: number;
  startUrl?: string;
  args?: Record<string, any>;
}

export async function runFlow(flow: Flow, options: RunOptions = {}): Promise<RunResult> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startAt = Date.now();
  const logs: RunLogEntry[] = [];
  const vars: Record<string, any> = Object.create(null);
  for (const v of flow.variables || []) {
    if (v.default !== undefined) vars[v.key] = v.default;
  }
  if (options.args) Object.assign(vars, options.args);

  // prepare tab & binding check
  if (options.startUrl) {
    await handleCallTool({ name: TOOL_NAMES.BROWSER.NAVIGATE, args: { url: options.startUrl } });
  }
  if (options.refresh) {
    await handleCallTool({ name: TOOL_NAMES.BROWSER.NAVIGATE, args: { refresh: true } });
  }

  // Ensure helper scripts are present for overlay/collectVariables
  try {
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
  } catch {
    /* ignore */
  }

  // Collect missing variables via lightweight prompt overlay
  try {
    const needed = (flow.variables || []).filter(
      (v) =>
        (options.args?.[v.key] == null || options.args?.[v.key] === '') &&
        (v.rules?.required || (v.default ?? '') === ''),
    );
    if (needed.length > 0) {
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
        args: { eventName: 'collectVariables', payload: undefined },
      });
      // Fallback: if direct collectVariables without payload not supported, call with explicit variables
      let values: Record<string, any> | null = null;
      try {
        const t = (res?.content || []).find((c: any) => c.type === 'text')?.text;
        const j = t ? JSON.parse(t) : null;
        if (j && j.success && j.values) values = j.values;
      } catch {
        /* ignore */
      }
      if (!values) {
        const res2 = await chrome.tabs
          .query({ active: true, currentWindow: true })
          .then(async (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (typeof tabId !== 'number') return null;
            return await chrome.tabs.sendMessage(tabId, {
              action: 'collectVariables',
              variables: needed,
            } as any);
          });
        if (res2 && res2.success && res2.values) values = res2.values;
      }
      if (values) Object.assign(vars, values);
    }
  } catch {
    // ignore prompt failures
  }

  // Init simple overlay for real-time logs
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'rr_overlay', cmd: 'init' } as any);
    }
  } catch {
    /* ignore */
  }

  // Binding enforcement: if bindings exist and no startUrl, verify current tab URL matches
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
        } catch {
          // ignore
        }
        return false;
      });
      if (!ok) {
        return {
          runId: `run_${Date.now()}`,
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
        };
      }
    }
  } catch {
    // ignore binding errors and continue
  }

  // Optional: capture network for the whole run using Debugger-based tool (independent of webRequest)
  let failed = 0;
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
      // Summarize top XHR/Fetch calls (method, url, status, duration)
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
    } catch {
      // ignore
    }
  };

  // Helper: wait for network idle using webRequest-based capture loop
  const waitForNetworkIdle = async (totalTimeoutMs: number, idleThresholdMs: number) => {
    const deadline = Date.now() + Math.max(500, totalTimeoutMs);
    const threshold = Math.max(200, idleThresholdMs);
    while (Date.now() < deadline) {
      // Start ephemeral capture with inactivity window
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
        args: {
          includeStatic: false,
          maxCaptureTime: Math.min(60_000, Math.max(threshold + 500, 2_000)),
          inactivityTimeout: threshold,
        },
      });
      // Give time for inactivity window to elapse if present
      await new Promise((r) => setTimeout(r, threshold + 200));
      const stopRes = await handleCallTool({
        name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
        args: {},
      });
      const text = (stopRes?.content || []).find((c: any) => c.type === 'text')?.text;
      try {
        const json = text ? JSON.parse(text) : null;
        const captureEnd = Number(json?.captureEndTime) || Date.now();
        const reqs: any[] = Array.isArray(json?.requests) ? json.requests : [];
        const lastActivity = reqs.reduce(
          (acc, r) => {
            const t = Number(r.responseTime || r.requestTime || 0);
            return t > acc ? t : acc;
          },
          Number(json?.captureStartTime || 0),
        );
        if (captureEnd - lastActivity >= threshold) {
          return; // idle window achieved
        }
      } catch {
        // ignore parse errors, try again until deadline
      }
      // Small backoff before next attempt
      await new Promise((r) => setTimeout(r, Math.min(500, threshold)));
    }
    throw new Error('wait for network idle timed out');
  };

  // Start long-running network capture if requested
  if (options.captureNetwork) {
    try {
      const res = await handleCallTool({
        name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
        args: { includeStatic: false, maxCaptureTime: 3 * 60_000, inactivityTimeout: 0 },
      });
      if (!(res as any)?.isError) networkCaptureStarted = true;
    } catch {
      // ignore capture start failure
    }
  }

  try {
    const pendingAfterScripts: StepScript[] = [];
    for (const step of flow.steps) {
      const t0 = Date.now();
      const maxRetries = Math.max(0, step.retry?.count ?? 0);
      const baseInterval = Math.max(0, step.retry?.intervalMs ?? 0);
      let attempt = 0;
      const doDelay = async (i: number) => {
        const delay =
          baseInterval > 0
            ? step.retry?.backoff === 'exp'
              ? baseInterval * Math.pow(2, i)
              : baseInterval
            : 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      };
      // Execution with retry
      while (true) {
        try {
          // resolve string templates {var}
          const resolveTemplate = (val?: string): string | undefined =>
            (val || '').replace(/\{([^}]+)\}/g, (_m, k) => (vars[k] ?? '').toString());

          // Defer 'script' steps marked as after to run after next non-script step
          if (step.type === 'script' && (step as any).when === 'after') {
            pendingAfterScripts.push(step as any);
            // Do not execute now; will run after the next non-script step (or at the end)
            logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
            break;
          }

          switch (step.type) {
            case 'scroll': {
              const s = step as StepScroll;
              const top = s.offset?.y ?? undefined;
              const left = s.offset?.x ?? undefined;
              const selectorFromTarget = (s.target?.candidates || []).find(
                (c) => c.type === 'css' || c.type === 'attr',
              )?.value;

              let code = '';
              if (s.mode === 'offset' && !s.target) {
                const t = top != null ? Number(top) : 'undefined';
                const l = left != null ? Number(left) : 'undefined';
                code = `try { window.scrollTo({ top: ${t}, left: ${l}, behavior: 'instant' }); } catch (e) {}`;
              } else if (s.mode === 'element' && selectorFromTarget) {
                code = `(() => { try { const el = document.querySelector(${JSON.stringify(
                  selectorFromTarget,
                )}); if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); } catch (e) {} })();`;
              } else if (s.mode === 'container' && selectorFromTarget) {
                const t = top != null ? Number(top) : 'undefined';
                const l = left != null ? Number(left) : 'undefined';
                code = `(() => { try { const el = document.querySelector(${JSON.stringify(
                  selectorFromTarget,
                )}); if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: ${t}, left: ${l}, behavior: 'instant' }); } catch (e) {} })();`;
              } else {
                const direction = top != null && Number(top) < 0 ? 'up' : 'down';
                const amount = 3;
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.COMPUTER,
                  args: { action: 'scroll', scrollDirection: direction, scrollAmount: amount },
                });
                if ((res as any).isError) throw new Error('scroll failed');
              }

              if (code) {
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
                  args: { type: 'MAIN', jsScript: code },
                });
                if ((res as any).isError) throw new Error('scroll failed');
              }
              break;
            }
            case 'drag': {
              const s = step as StepDrag;
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              const tabId = tabs?.[0]?.id;
              let startRef: string | undefined;
              let endRef: string | undefined;
              try {
                if (typeof tabId === 'number') {
                  const locatedStart = await locateElement(tabId, s.start);
                  const locatedEnd = await locateElement(tabId, s.end);
                  startRef = locatedStart?.ref || s.start.ref;
                  endRef = locatedEnd?.ref || s.end.ref;
                }
              } catch {
                // ignore
              }

              let startCoordinates: { x: number; y: number } | undefined;
              let endCoordinates: { x: number; y: number } | undefined;
              if ((!startRef || !endRef) && Array.isArray(s.path) && s.path.length >= 2) {
                startCoordinates = { x: Number(s.path[0].x), y: Number(s.path[0].y) };
                const last = s.path[s.path.length - 1];
                endCoordinates = { x: Number(last.x), y: Number(last.y) };
              }

              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.COMPUTER,
                args: {
                  action: 'left_click_drag',
                  startRef,
                  ref: endRef,
                  startCoordinates,
                  coordinates: endCoordinates,
                },
              });
              if ((res as any).isError) throw new Error('drag failed');
              break;
            }
            case 'click':
            case 'dblclick': {
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              const firstTab = tabs && tabs[0];
              const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
              if (!tabId) throw new Error('Active tab not found');
              // Ensure helper script is loaded by leveraging existing read_page tooling
              await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
              const located = await locateElement(tabId, (step as any).target);
              const first = (step as any).target?.candidates?.[0]?.type;
              const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
              const fallbackUsed =
                resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
              // minimal visibility check via resolveRef rect
              if (located?.ref) {
                const resolved = await chrome.tabs.sendMessage(tabId, {
                  action: 'resolveRef',
                  ref: located.ref,
                } as any);
                const rect = resolved?.rect;
                if (!rect || rect.width <= 0 || rect.height <= 0) {
                  throw new Error('element not visible');
                }
              }
              // auto scroll into view if possible (unified)
              try {
                const sel = !located?.ref
                  ? (step as any).target?.candidates?.find(
                      (c: any) => c.type === 'css' || c.type === 'attr',
                    )?.value
                  : undefined;
                if (sel) {
                  await handleCallTool({
                    name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
                    args: {
                      type: 'MAIN',
                      jsScript: `try{var el=document.querySelector(${JSON.stringify(sel)});if(el){el.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});} }catch(e){}`,
                    },
                  });
                }
              } catch {
                /* ignore */
              }
              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.CLICK,
                args: {
                  ref: located?.ref || (step as any).target?.ref,
                  selector: !located?.ref
                    ? (step as any).target?.candidates?.find(
                        (c: any) => c.type === 'css' || c.type === 'attr',
                      )?.value
                    : undefined,
                  waitForNavigation: (step as any).after?.waitForNavigation || false,
                  timeout: Math.max(1000, Math.min(step.timeoutMs || 10000, 30000)),
                },
              });
              if ((res as any).isError) throw new Error('click failed');
              if (fallbackUsed) {
                logs.push({
                  stepId: step.id,
                  status: 'success',
                  message: `Selector fallback used (${first} -> ${resolvedBy})`,
                  fallbackUsed: true,
                  fallbackFrom: String(first),
                  fallbackTo: String(resolvedBy),
                  tookMs: Date.now() - t0,
                } as any);
                continue;
              }
              break;
            }
            case 'fill': {
              const s = step as StepFill;
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              const firstTab = tabs && tabs[0];
              const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
              if (!tabId) throw new Error('Active tab not found');
              await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
              const located = await locateElement(tabId, s.target);
              const first = s.target?.candidates?.[0]?.type;
              const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
              const fallbackUsed =
                resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
              const value = resolveTemplate(s.value) ?? '';
              // minimal visibility check via resolveRef rect
              if (located?.ref) {
                const resolved = await chrome.tabs.sendMessage(tabId, {
                  action: 'resolveRef',
                  ref: located.ref,
                } as any);
                const rect = resolved?.rect;
                if (!rect || rect.width <= 0 || rect.height <= 0) {
                  throw new Error('element not visible');
                }
              }
              // auto scroll into view if possible before fill
              try {
                const sel = !located?.ref
                  ? s.target.candidates?.find((c) => c.type === 'css' || c.type === 'attr')?.value
                  : undefined;
                if (sel) {
                  await handleCallTool({
                    name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
                    args: {
                      type: 'MAIN',
                      jsScript: `try{var el=document.querySelector(${JSON.stringify(sel)});if(el){el.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});} }catch(e){}`,
                    },
                  });
                }
              } catch {
                /* ignore */
              }
              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.FILL,
                args: {
                  ref: located?.ref || s.target.ref,
                  selector: !located?.ref
                    ? s.target.candidates?.find((c) => c.type === 'css' || c.type === 'attr')?.value
                    : undefined,
                  value,
                },
              });
              if ((res as any).isError) throw new Error('fill failed');
              if (fallbackUsed) {
                logs.push({
                  stepId: step.id,
                  status: 'success',
                  message: `Selector fallback used (${first} -> ${resolvedBy})`,
                  fallbackUsed: true,
                  fallbackFrom: String(first),
                  fallbackTo: String(resolvedBy),
                  tookMs: Date.now() - t0,
                } as any);
                continue;
              }
              break;
            }
            case 'key': {
              const s = step as StepKey;
              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.KEYBOARD,
                args: { keys: s.keys },
              });
              if ((res as any).isError) throw new Error('key failed');
              break;
            }
            case 'wait': {
              const s = step as StepWait;
              if ('text' in s.condition) {
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.COMPUTER,
                  args: {
                    action: 'wait',
                    text: s.condition.text,
                    appear: s.condition.appear !== false,
                    timeout: Math.max(0, Math.min(step.timeoutMs || 10000, 120000)),
                  },
                });
                if ((res as any).isError) throw new Error('wait text failed');
              } else if ('networkIdle' in s.condition) {
                const total = Math.min(Math.max(1000, step.timeoutMs || 5000), 120000);
                const idle = Math.min(1500, Math.max(500, Math.floor(total / 3)));
                await waitForNetworkIdle(total, idle);
              } else if ('navigation' in s.condition) {
                // best-effort: wait a fixed time
                const delay = Math.min(step.timeoutMs || 5000, 20000);
                await new Promise((r) => setTimeout(r, delay));
              } else if ('selector' in s.condition) {
                // best-effort: simple text wait with selector string as text
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.COMPUTER,
                  args: {
                    action: 'wait',
                    text: s.condition.selector,
                    appear: s.condition.visible !== false,
                    timeout: Math.max(0, Math.min(step.timeoutMs || 10000, 120000)),
                  },
                });
                if ((res as any).isError) throw new Error('wait selector failed');
              }
              break;
            }
            case 'assert': {
              const s = step as StepAssert;
              // resolve using read_page to ensure element/text
              if ('textPresent' in s.assert) {
                const text = s.assert.textPresent;
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.COMPUTER,
                  args: { action: 'wait', text, appear: true, timeout: step.timeoutMs || 5000 },
                });
                if ((res as any).isError) throw new Error('assert text failed');
              } else if ('exists' in s.assert || 'visible' in s.assert) {
                const selector = (s.assert as any).exists || (s.assert as any).visible;
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const firstTab = tabs && tabs[0];
                const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
                if (!tabId) throw new Error('Active tab not found');
                await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
                const ensured = await chrome.tabs.sendMessage(tabId, {
                  action: 'ensureRefForSelector',
                  selector,
                } as any);
                if (!ensured || !ensured.success) throw new Error('assert selector not found');
                if ('visible' in s.assert) {
                  const rect = ensured && ensured.center ? ensured.center : null;
                  // Minimal visibility check based on existence and center
                  if (!rect) throw new Error('assert visible failed');
                }
              } else if ('attribute' in s.assert) {
                const { selector, name, equals, matches } = (s.assert as any).attribute || {};
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const firstTab = tabs && tabs[0];
                const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
                if (!tabId) throw new Error('Active tab not found');
                await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
                const resp = await chrome.tabs.sendMessage(tabId, {
                  action: 'getAttributeForSelector',
                  selector,
                  name,
                } as any);
                if (!resp || !resp.success) throw new Error('assert attribute: element not found');
                const actual: string | null = resp.value ?? null;
                if (equals !== undefined && equals !== null) {
                  const expected = resolveTemplate(String(equals)) ?? '';
                  if (String(actual) !== String(expected))
                    throw new Error(
                      `assert attribute equals failed: ${name} actual=${String(actual)} expected=${String(
                        expected,
                      )}`,
                    );
                } else if (matches !== undefined && matches !== null) {
                  try {
                    const re = new RegExp(String(matches));
                    if (!re.test(String(actual)))
                      throw new Error(
                        `assert attribute matches failed: ${name} actual=${String(actual)} regex=${String(
                          matches,
                        )}`,
                      );
                  } catch (e) {
                    throw new Error(`invalid regex for attribute matches: ${String(matches)}`);
                  }
                } else {
                  // Only check existence if no comparator provided
                  if (actual == null) throw new Error(`assert attribute failed: ${name} missing`);
                }
              }
              break;
            }
            case 'script': {
              const world = (step as any).world || 'ISOLATED';
              const code = String((step as any).code || '');
              if (!code.trim()) break;
              const wrapped = `(() => { try { ${code} } catch (e) { console.error('flow script error:', e); } })();`;
              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
                args: { type: world, jsScript: wrapped },
              });
              if ((res as any).isError) throw new Error('script execution failed');
              break;
            }
            case 'navigate': {
              const url = (step as any).url;
              const res = await handleCallTool({
                name: TOOL_NAMES.BROWSER.NAVIGATE,
                args: { url },
              });
              if ((res as any).isError) throw new Error('navigate failed');
              break;
            }
            default: {
              // not implemented types in M1
              await new Promise((r) => setTimeout(r, 0));
            }
          }
          logs.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]?.id) {
              await chrome.tabs.sendMessage(tabs[0].id, {
                action: 'rr_overlay',
                cmd: 'append',
                text: `✔ ${step.type} (${step.id})`,
              } as any);
            }
          } catch {
            /* ignore */
          }
          // Run any deferred after-scripts now that a non-script step completed
          if (pendingAfterScripts.length > 0) {
            while (pendingAfterScripts.length) {
              const s = pendingAfterScripts.shift()!;
              const tScript = Date.now();
              const world = (s as any).world || 'ISOLATED';
              const code = String((s as any).code || '');
              if (code.trim()) {
                const wrapped = `(() => { try { ${code} } catch (e) { console.error('flow script error:', e); } })();`;
                const res = await handleCallTool({
                  name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
                  args: { type: world, jsScript: wrapped },
                });
                if ((res as any).isError) throw new Error('script(after) execution failed');
              }
              logs.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
            }
          }
          break; // success, exit retry loop
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
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]?.id) {
              await chrome.tabs.sendMessage(tabs[0].id, {
                action: 'rr_overlay',
                cmd: 'append',
                text: `✘ ${step.type} (${step.id}) -> ${e?.message || String(e)}`,
              } as any);
            }
          } catch {
            /* ignore */
          }
          if (step.screenshotOnFail !== false) {
            try {
              const shot = await handleCallTool({
                name: TOOL_NAMES.BROWSER.COMPUTER,
                args: { action: 'screenshot' },
              });
              const img = (shot?.content?.find((c: any) => c.type === 'image') as any)
                ?.data as string;
              if (img) logs[logs.length - 1].screenshotBase64 = img;
            } catch {
              // ignore
            }
          }
          // stop on first failure after retries
          throw e;
        }
      }
    }
    // Flush any trailing after-scripts if present
    if (pendingAfterScripts.length > 0) {
      while (pendingAfterScripts.length) {
        const s = pendingAfterScripts.shift()!;
        const tScript = Date.now();
        const world = (s as any).world || 'ISOLATED';
        const code = String((s as any).code || '');
        if (code.trim()) {
          const wrapped = `(() => { try { ${code} } catch (e) { console.error('flow script error:', e); } })();`;
          const res = await handleCallTool({
            name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
            args: { type: world, jsScript: wrapped },
          });
          if ((res as any).isError) throw new Error('script(after) execution failed');
        }
        logs.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
      }
    }
  } finally {
    if (networkCaptureStarted) {
      await stopAndSummarizeNetwork();
    }
  }

  const tookMs = Date.now() - startAt;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      await chrome.tabs.sendMessage(tabs[0].id, { action: 'rr_overlay', cmd: 'done' } as any);
    }
  } catch {
    /* ignore */
  }
  const record: RunRecord = {
    id: runId,
    flowId: flow.id,
    startedAt: new Date(startAt).toISOString(),
    finishedAt: new Date().toISOString(),
    success: failed === 0,
    entries: logs,
  };
  await appendRun(record);

  return {
    runId,
    success: failed === 0,
    summary: {
      total: flow.steps.length,
      success: flow.steps.length - failed,
      failed,
      tookMs,
    },
    url: null,
    outputs: null,
    logs: options.returnLogs ? logs : undefined,
    screenshots: { onFailure: logs.find((l) => l.status === 'failed')?.screenshotBase64 },
  };
}

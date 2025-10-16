import { BACKGROUND_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { Flow } from './types';
import {
  listFlows,
  saveFlow,
  getFlow,
  deleteFlow,
  publishFlow,
  unpublishFlow,
  exportFlow,
  exportAllFlows,
  importFlowFromJson,
  listSchedules,
  saveSchedule,
  removeSchedule,
  type FlowSchedule,
} from './flow-store';
import { listRuns } from './flow-store';
import { STORAGE_KEYS } from '@/common/constants';
import { listTriggers, saveTrigger, deleteTrigger, type FlowTrigger } from './trigger-store';
import { runFlow } from './flow-runner';

// design note: background listener for record & replay; manages start/stop and storage

let currentRecording: { tabId: number; flow?: Flow } | null = null;
// persistent guard to avoid unintended resume after stop/refresh
let recordingActive = false;

async function setRecordingActive(active: boolean) {
  recordingActive = active;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.RR_RECORDING_STATE]: { active, ts: Date.now() },
    });
  } catch {
    // ignore storage errors
  }
  // Best-effort sync to content scripts to avoid stray overlays
  if (!active) {
    try {
      await broadcastRecorderCommandToAllTabs('stop');
    } catch {}
  }
}

async function initRecordingActiveFromStorage() {
  try {
    const res = await chrome.storage.local.get([STORAGE_KEYS.RR_RECORDING_STATE]);
    const st = res?.[STORAGE_KEYS.RR_RECORDING_STATE];
    recordingActive = !!(st && st.active);
  } catch {
    recordingActive = false;
  }
  // If not recording per persisted state, ensure any stale overlays are removed
  if (!recordingActive) {
    try {
      await broadcastRecorderCommandToAllTabs('stop');
    } catch {}
  }
}
// 最近一次点击信息（用于导航富化）
let lastClickIdx: number | null = null;
let lastClickTime = 0;
let lastNavTaggedAt = 0;

// Alarm helpers for schedules
async function rescheduleAlarms() {
  const schedules = await listSchedules();
  // Clear existing rr_schedule_* alarms
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => a.name && a.name.startsWith('rr_schedule_'))
      .map((a) => chrome.alarms.clear(a.name)),
  );
  for (const s of schedules) {
    if (!s.enabled) continue;
    const name = `rr_schedule_${s.id}`;
    if (s.type === 'interval') {
      const minutes = Math.max(1, Math.floor(Number(s.when) || 0));
      await chrome.alarms.create(name, { periodInMinutes: minutes });
    } else if (s.type === 'once') {
      const whenMs = Date.parse(s.when);
      if (Number.isFinite(whenMs)) await chrome.alarms.create(name, { when: whenMs });
    } else if (s.type === 'daily') {
      // daily HH:mm local time
      const [hh, mm] = String(s.when || '00:00')
        .split(':')
        .map((x) => Number(x));
      const now = new Date();
      const next = new Date();
      next.setHours(hh || 0, mm || 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 24 * 60 });
    }
  }
}

async function ensureRecorderInjected(tabId: number): Promise<void> {
  // Determine frames and selectively inject only where missing to minimize overhead.
  let frames: Array<{ frameId: number } & Record<string, any>> = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {}
  if (!Array.isArray(frames) || frames.length === 0) frames = [{ frameId: 0 } as any];

  const needHelper: number[] = [];
  const needRecorder: number[] = [];
  await Promise.all(
    frames.map(async (f) => {
      const frameId = (f as any).frameId ?? 0;
      // ping helper
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { action: 'chrome_read_page_ping' } as any,
          { frameId } as any,
        );
        if (!res) needHelper.push(frameId);
      } catch {
        needHelper.push(frameId);
      }
      // ping recorder
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { action: 'rr_recorder_ping' } as any,
          { frameId } as any,
        );
        if (!res) needRecorder.push(frameId);
      } catch {
        needRecorder.push(frameId);
      }
    }),
  );

  if (needHelper.length > 0) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: needHelper },
      files: ['inject-scripts/accessibility-tree-helper.js'],
      world: 'ISOLATED',
    } as any);
  }
  if (needRecorder.length > 0) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: needRecorder },
      files: ['inject-scripts/recorder.js'],
      world: 'ISOLATED',
    } as any);
  }
}

async function broadcastRecorderCommandToAllTabs(cmd: 'start' | 'stop' | 'resume' | 'pause') {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
        const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
        await Promise.all(
          targets.map((f) =>
            chrome.tabs
              .sendMessage(
                t.id!,
                { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd } as any,
                { frameId: (f as any).frameId } as any,
              )
              .catch(() => null),
          ),
        );
      } catch {
        // ignore per-tab failures
      }
    }
  } catch {}
}

async function startRecording(meta?: Partial<Flow>): Promise<{ success: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { success: false, error: 'Active tab not found' };
  try {
    await ensureRecorderInjected(tab.id);
    currentRecording = { tabId: tab.id };
    await setRecordingActive(true);
    // Broadcast to all frames
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
    await Promise.all(
      targets.map((f) =>
        chrome.tabs.sendMessage(
          tab.id!,
          {
            action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL,
            cmd: 'start',
            meta: { id: meta?.id, name: meta?.name, description: meta?.description },
          } as any,
          { frameId: f.frameId } as any,
        ),
      ),
    );
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

async function stopRecording(): Promise<{ success: boolean; flow?: Flow; error?: string }> {
  if (!currentRecording) return { success: false, error: 'No active recording' };
  // Copy reference and clear state early to avoid race with navigation listeners resuming recording
  const rec = currentRecording;
  currentRecording = null;
  await setRecordingActive(false);
  try {
    // Stop all frames; prefer top-frame returned flow as base meta
    let flowFromTab: Flow | undefined = undefined;
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: rec.tabId });
      const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
      const results = await Promise.all(
        targets.map((f) =>
          chrome.tabs
            .sendMessage(
              rec.tabId,
              { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'stop' } as any,
              { frameId: (f as any).frameId } as any,
            )
            .catch(() => null),
        ),
      );
      const topRes = results.find((r: any, idx) => (frames?.[idx]?.frameId ?? 0) === 0);
      flowFromTab = (topRes && (topRes as any).flow) as any;
      // fallback: if top not found, pick first with flow
      if (!flowFromTab) {
        const anyRes = results.find((r: any) => r && (r as any).flow);
        flowFromTab = (anyRes && (anyRes as any).flow) as any;
      }
    } catch {
      // fallback to top frame only
      const flowRes: any = await chrome.tabs.sendMessage(
        rec.tabId,
        { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'stop' } as any,
        { frameId: 0 } as any,
      );
      flowFromTab = (flowRes && flowRes.flow) as any;
    }
    // Merge aggregated steps with meta from content script
    const aggregated = rec.flow;
    const merged: Flow | undefined = (function merge() {
      if (aggregated && !flowFromTab) return aggregated;
      if (!aggregated && flowFromTab) return flowFromTab;
      if (!aggregated && !flowFromTab) return undefined;
      // both present: prefer meta/name from flowFromTab, keep steps/variables from aggregated (cross-tab)
      const id = (aggregated as Flow).id || (flowFromTab as Flow).id || `flow_${Date.now()}`;
      const name = (flowFromTab as Flow).name || (aggregated as Flow).name || '未命名录制';
      const version = (flowFromTab as Flow).version || (aggregated as Flow).version || 1;
      const metaMerged: any = {
        ...((aggregated as Flow).meta || {}),
        ...((flowFromTab as Flow).meta || {}),
      };
      if (!metaMerged.createdAt)
        metaMerged.createdAt =
          ((aggregated as Flow).meta as any)?.createdAt || new Date().toISOString();
      metaMerged.updatedAt = new Date().toISOString();
      return {
        id,
        name,
        version,
        // Prefer aggregated steps only when they exist; otherwise take content-provided steps
        steps:
          Array.isArray((aggregated as Flow).steps) && (aggregated as Flow).steps.length > 0
            ? (aggregated as Flow).steps
            : (flowFromTab as Flow).steps || [],
        variables:
          Array.isArray((aggregated as Flow).variables) && (aggregated as Flow).variables.length > 0
            ? (aggregated as Flow).variables
            : (flowFromTab as Flow).variables || [],
        meta: metaMerged,
      } as Flow;
    })();
    if (merged) await saveFlow(merged);
    return { success: true, flow: merged };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export function initRecordReplayListeners() {
  // Initialize recordingActive from storage; default to false
  initRecordingActiveFromStorage().catch(() => {});
  // Keep in sync when storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    try {
      if (area !== 'local') return;
      if (Object.prototype.hasOwnProperty.call(changes || {}, STORAGE_KEYS.RR_RECORDING_STATE)) {
        const nv = changes[STORAGE_KEYS.RR_RECORDING_STATE]?.newValue;
        recordingActive = !!(nv && nv.active);
      }
    } catch {
      // ignore
    }
  });
  // On startup, re-schedule alarms
  rescheduleAlarms().catch(() => {});
  // Initialize trigger engine (contextMenus/commands/url/dom)
  initTriggerEngine().catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message && message.type === 'rr_recorder_event') {
        if (message.payload?.kind === 'start') {
          // Start event from content: initialize aggregated flow container when allowed
          if (recordingActive && currentRecording) {
            currentRecording.flow = message.payload.flow;
          } else {
            // Stray start from content (e.g., service-worker restart or stale script): force stop that frame
            try {
              if (sender?.tab?.id != null) {
                chrome.tabs
                  .sendMessage(
                    sender.tab.id,
                    { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'stop' } as any,
                    sender?.frameId != null ? ({ frameId: sender.frameId } as any) : ({} as any),
                  )
                  .catch(() => null);
              }
            } catch {}
          }
        } else if (message.payload?.kind === 'step' || message.payload?.kind === 'steps') {
          // Guard: only aggregate when an active recording session is ongoing
          if (currentRecording && recordingActive) {
            const stepsArr: any[] = Array.isArray(message.payload.steps)
              ? message.payload.steps
              : [message.payload.step];
            for (const step of stepsArr) {
              // 记录最近一次 click/dblclick 的索引和时间，用于后续 tabs.onUpdated 导航富化
              if (step && (step.type === 'click' || step.type === 'dblclick')) {
                try {
                  const idx = currentRecording.flow?.steps?.length ?? 0;
                  lastClickIdx = idx;
                  lastClickTime = Date.now();
                } catch {
                  // ignore
                }
              }
              // 统一在后台累积步骤，便于跨标签页聚合
              try {
                if (!currentRecording.flow) {
                  currentRecording.flow = {
                    id: `flow_${Date.now()}`,
                    name: '未命名录制',
                    version: 1,
                    steps: [],
                    variables: [],
                    meta: {
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    },
                  } as Flow;
                }
                currentRecording.flow.steps.push(step);
                currentRecording.flow.meta = {
                  ...(currentRecording.flow.meta || ({} as any)),
                  updatedAt: new Date().toISOString(),
                } as any;
              } catch {
                // ignore
              }
            }
          }
        } else if (message.payload?.kind === 'stop') {
          // User clicked stop inside page overlay: finalize and persist
          (async () => {
            try {
              const flowFromTab = message.payload?.flow as Flow | undefined;
              // Snapshot then clear state; also clear persistent flag to block resume
              const rec = currentRecording;
              currentRecording = null;
              await setRecordingActive(false);
              if (!rec && !flowFromTab) {
                sendResponse({ ok: true });
                return;
              }
              const aggregated = rec?.flow;
              const merged: Flow | undefined = (function merge() {
                if (aggregated && !flowFromTab) return aggregated;
                if (!aggregated && flowFromTab) return flowFromTab;
                if (!aggregated && !flowFromTab) return undefined;
                const id =
                  (aggregated as Flow).id || (flowFromTab as Flow).id || `flow_${Date.now()}`;
                const name =
                  (flowFromTab as Flow).name || (aggregated as Flow).name || '未命名录制';
                const version = (flowFromTab as Flow).version || (aggregated as Flow).version || 1;
                const metaMerged: any = {
                  ...((aggregated as Flow).meta || {}),
                  ...((flowFromTab as Flow).meta || {}),
                };
                if (!metaMerged.createdAt)
                  metaMerged.createdAt =
                    ((aggregated as Flow).meta as any)?.createdAt || new Date().toISOString();
                metaMerged.updatedAt = new Date().toISOString();
                return {
                  id,
                  name,
                  version,
                  steps:
                    Array.isArray((aggregated as Flow).steps) &&
                    (aggregated as Flow).steps.length > 0
                      ? (aggregated as Flow).steps
                      : (flowFromTab as Flow).steps || [],
                  variables:
                    Array.isArray((aggregated as Flow).variables) &&
                    (aggregated as Flow).variables.length > 0
                      ? (aggregated as Flow).variables
                      : (flowFromTab as Flow).variables || [],
                  meta: metaMerged,
                } as Flow;
              })();
              if (merged) await saveFlow(merged);
              sendResponse({ ok: true });
            } catch {
              sendResponse({ ok: false });
            }
          })();
          return true;
        }
        sendResponse({ ok: true });
        return true;
      }

      switch (message?.type) {
        case BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING: {
          startRecording(message.meta)
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING: {
          // Be tolerant: even if currentRecording is lost (service worker restart),
          // make a best-effort to stop any active recorder overlays and clear flag.
          if (!currentRecording) {
            setRecordingActive(false)
              .then(async () => {
                try {
                  await broadcastRecorderCommandToAllTabs('stop');
                } catch {}
                sendResponse({ success: true });
              })
              .catch(() => sendResponse({ success: true }));
            return true;
          }
          stopRecording()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS: {
          listFlows()
            .then((flows) => sendResponse({ success: true, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW: {
          getFlow(message.flowId)
            .then((flow) => sendResponse({ success: !!flow, flow }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_FLOW: {
          deleteFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW: {
          getFlow(message.flowId)
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              await publishFlow(flow, message.slug);
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW: {
          unpublishFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW: {
          getFlow(message.flowId)
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              const result = await runFlow(flow, message.options || {});
              sendResponse({ success: true, result });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW: {
          const flow = message.flow as Flow;
          if (!flow || !flow.id) {
            sendResponse({ success: false, error: 'invalid flow' });
            return true;
          }
          saveFlow(flow)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW: {
          exportFlow(message.flowId)
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_ALL: {
          exportAllFlows()
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW: {
          importFlowFromJson(message.json)
            .then((flows) => sendResponse({ success: true, imported: flows.length, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_RUNS: {
          listRuns()
            .then((runs) => sendResponse({ success: true, runs }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_TRIGGERS: {
          listTriggers()
            .then((triggers) => sendResponse({ success: true, triggers }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER: {
          const t = message.trigger as FlowTrigger;
          if (!t || !t.id || !t.type || !t.flowId) {
            sendResponse({ success: false, error: 'invalid trigger' });
            return true;
          }
          saveTrigger(t)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER: {
          const id = String(message.id || '');
          if (!id) {
            sendResponse({ success: false, error: 'invalid id' });
            return true;
          }
          deleteTrigger(id)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS: {
          refreshTriggers()
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_SCHEDULES: {
          listSchedules()
            .then((s) => sendResponse({ success: true, schedules: s }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SCHEDULE_FLOW: {
          const s = message.schedule as FlowSchedule;
          if (!s || !s.id || !s.flowId) {
            sendResponse({ success: false, error: 'invalid schedule' });
            return true;
          }
          saveSchedule(s)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNSCHEDULE_FLOW: {
          const scheduleId = String(message.scheduleId || '');
          if (!scheduleId) {
            sendResponse({ success: false, error: 'invalid scheduleId' });
            return true;
          }
          removeSchedule(scheduleId)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
      }
    } catch (err) {
      sendResponse({ success: false, error: (err as any)?.message || String(err) });
    }
    return false;
  });
  // 监听 tab 更新，若点击后短时间发生导航则为该点击自动加上 after.waitForNavigation
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    try {
      if (!currentRecording || !recordingActive || tabId !== currentRecording.tabId) return;
      if (!currentRecording.flow) return;
      const urlChanged = typeof changeInfo.url === 'string';
      const isLoading = changeInfo.status === 'loading';
      if (!urlChanged && !isLoading) return;
      if (lastClickIdx == null) return;
      const now = Date.now();
      if (now - lastClickTime > 5000) return; // 仅在最近5秒内的点击认为相关
      if (now - lastNavTaggedAt < 500) return; // 去抖
      const steps = currentRecording.flow.steps;
      if (!Array.isArray(steps) || !steps[lastClickIdx]) return;
      const st: any = steps[lastClickIdx];
      if (!st.after) st.after = {};
      if (!st.after.waitForNavigation) {
        st.after.waitForNavigation = true;
        lastNavTaggedAt = now;
      }
    } catch {
      // ignore
    }
  });

  // 全局录制：监听激活的标签页变化，追加“导航/切换”步骤，并确保在新标签页继续录制
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      if (!currentRecording || !recordingActive) return;
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (!tab) return;
      // 确保该标签页注入并继续录制（不重置流）
      try {
        await ensureRecorderInjected(activeInfo.tabId);
        const frames = await chrome.webNavigation.getAllFrames({ tabId: activeInfo.tabId });
        const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
        await Promise.all(
          targets.map((f) =>
            chrome.tabs.sendMessage(
              activeInfo.tabId!,
              { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'resume' } as any,
              { frameId: f.frameId } as any,
            ),
          ),
        );
      } catch {
        /* ignore */
      }
      if (!currentRecording.flow) return;
      const url = typeof tab.url === 'string' ? tab.url : '';
      if (url) {
        currentRecording.flow.steps.push({
          id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'navigate',
          url,
        } as any);
        currentRecording.flow.meta = {
          ...(currentRecording.flow.meta || ({} as any)),
          updatedAt: new Date().toISOString(),
        } as any;
      }
    } catch {
      // ignore
    }
  });

  // 全局录制：监听顶级导航提交（含显式地址栏输入/刷新），在非链接点击触发时追加“导航”步骤
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (!currentRecording || !recordingActive) return;
      if (details.frameId !== 0) return; // 仅记录顶级 frame
      const tabId = details.tabId;
      // 对于点击触发的 link 导航，不追加 navigate（已有点击+waitForNavigation 富化）
      const t = details.transitionType as string | undefined;
      const isLink = t === 'link';
      if (isLink) {
        // 同时确保继续录制
        try {
          await ensureRecorderInjected(tabId);
          const frames = await chrome.webNavigation.getAllFrames({ tabId });
          const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
          await Promise.all(
            targets.map((f) =>
              chrome.tabs.sendMessage(
                tabId!,
                { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'resume' } as any,
                { frameId: f.frameId } as any,
              ),
            ),
          );
        } catch {
          /* ignore */
        }
        return;
      }
      // 显式导航/刷新/地址栏输入等
      const shouldRecord =
        t === 'reload' ||
        t === 'typed' ||
        t === 'generated' ||
        t === 'auto_bookmark' ||
        t === 'keyword';
      if (!shouldRecord) {
        // 仍确保脚本在该页活跃，用于持续录制
        try {
          await ensureRecorderInjected(tabId);
          const frames = await chrome.webNavigation.getAllFrames({ tabId });
          const targets = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 } as any];
          await Promise.all(
            targets.map((f) =>
              chrome.tabs.sendMessage(
                tabId!,
                { action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL, cmd: 'resume' } as any,
                { frameId: f.frameId } as any,
              ),
            ),
          );
        } catch {
          /* ignore */
        }
        return;
      }
      const tab = await chrome.tabs.get(tabId);
      const url = typeof tab.url === 'string' ? tab.url : details.url;
      if (!url || !currentRecording.flow) return;
      currentRecording.flow.steps.push({
        id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'navigate',
        url,
      } as any);
      currentRecording.flow.meta = {
        ...(currentRecording.flow.meta || ({} as any)),
        updatedAt: new Date().toISOString(),
      } as any;
      // 确保继续录制
      try {
        await ensureRecorderInjected(tabId);
        await chrome.tabs.sendMessage(tabId, {
          action: TOOL_MESSAGE_TYPES.RR_RECORDER_CONTROL,
          cmd: 'resume',
        } as any);
      } catch {
        /* ignore */
      }
    } catch {
      // ignore
    }
  });

  // Trigger engine: contextMenus/commands/url/dom
  if ((chrome as any).contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info) => {
      try {
        const triggers = await listTriggers();
        const t = triggers.find(
          (x) => x.type === 'contextMenu' && (x as any).menuId === info.menuItemId,
        );
        if (!t || t.enabled === false) return;
        const flow = await getFlow(t.flowId);
        if (!flow) return;
        await runFlow(flow, { args: t.args || {}, returnLogs: false });
      } catch {}
    });
  }
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const triggers = await listTriggers();
      const t = triggers.find((x) => x.type === 'command' && (x as any).commandKey === command);
      if (!t || t.enabled === false) return;
      const flow = await getFlow(t.flowId);
      if (!flow) return;
      await runFlow(flow, { args: t.args || {}, returnLogs: false });
    } catch {}
  });
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (details.frameId !== 0) return;
      const url = details.url || '';
      const triggers = await listTriggers();
      const list = triggers.filter((x) => x.type === 'url' && x.enabled !== false) as any[];
      for (const t of list) {
        if (matchUrl(url, (t as any).match || [])) {
          const flow = await getFlow(t.flowId);
          if (!flow) continue;
          await runFlow(flow, { args: t.args || {}, returnLogs: false });
        }
      }
    } catch {}
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message && message.action === 'dom_trigger_fired') {
        const id = message.triggerId;
        listTriggers().then(async (arr) => {
          const t = arr.find((x) => x.id === id && x.type === 'dom');
          if (!t || t.enabled === false) return;
          const flow = await getFlow(t.flowId);
          if (!flow) return;
          await runFlow(flow, { args: t.args || {}, returnLogs: false });
        });
        sendResponse({ ok: true });
        return true;
      }
    } catch {}
    return false;
  });
}

function matchUrl(
  u: string,
  rules: Array<{ kind: 'url' | 'domain' | 'path'; value: string }>,
): boolean {
  try {
    const url = new URL(u);
    for (const r of rules || []) {
      const v = String(r.value || '');
      if (r.kind === 'url' && u.startsWith(v)) return true;
      if (r.kind === 'domain' && url.hostname.includes(v)) return true;
      if (r.kind === 'path' && url.pathname.startsWith(v)) return true;
    }
  } catch {}
  return false;
}

async function refreshTriggers() {
  try {
    const triggers = await listTriggers();
    // Guard: contextMenus permission may be missing in some builds
    if ((chrome as any).contextMenus?.removeAll && (chrome as any).contextMenus?.create) {
      try {
        await chrome.contextMenus.removeAll();
      } catch {}
      for (const t of triggers) {
        if (t.type === 'contextMenu' && t.enabled !== false) {
          const id = `rr_menu_${t.id}`;
          (t as any).menuId = id;
          await chrome.contextMenus.create({
            id,
            title: (t as any).title || '运行工作流',
            contexts: (t as any).contexts || ['all'],
          });
        }
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.RR_TRIGGERS]: triggers });
    const domTriggers = triggers
      .filter((x) => x.type === 'dom' && x.enabled !== false)
      .map((x: any) => ({
        id: x.id,
        selector: x.selector,
        appear: x.appear !== false,
        once: x.once !== false,
        debounceMs: x.debounceMs ?? 800,
      }));
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: true },
          files: ['inject-scripts/dom-observer.js'],
          world: 'ISOLATED',
        } as any);
        await chrome.tabs.sendMessage(t.id, {
          action: 'set_dom_triggers',
          triggers: domTriggers,
        } as any);
      } catch {}
    }
  } catch {}
}

// Backward-compatible init function; initialize all trigger-related hooks/state
async function initTriggerEngine() {
  await refreshTriggers();
}

// Alarm listener executes scheduled flows
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm?.name || !alarm.name.startsWith('rr_schedule_')) return;
    const id = alarm.name.slice('rr_schedule_'.length);
    const schedules = await listSchedules();
    const s = schedules.find((x) => x.id === id && x.enabled);
    if (!s) return;
    const flow = await getFlow(s.flowId);
    if (!flow) return;
    await runFlow(flow, { args: s.args || {}, returnLogs: false });
  } catch (e) {
    // swallow to not spam logs
  }
});

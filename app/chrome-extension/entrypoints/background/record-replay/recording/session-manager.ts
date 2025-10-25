import type { Flow, Step } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { appendSteps as appendFlowSteps } from './flow-builder';

export type RecordingStatus = 'idle' | 'recording' | 'paused';

export interface RecordingSessionState {
  sessionId: string;
  status: RecordingStatus;
  originTabId: number | null;
  flow: Flow | null;
  // Track tabs that have participated in this recording session
  activeTabs: Set<number>;
}

export class RecordingSessionManager {
  private state: RecordingSessionState = {
    sessionId: '',
    status: 'idle',
    originTabId: null,
    flow: null,
    activeTabs: new Set<number>(),
  };

  getStatus(): RecordingStatus {
    return this.state.status;
  }

  getSession(): Readonly<RecordingSessionState> {
    return this.state;
  }

  getFlow(): Flow | null {
    return this.state.flow;
  }

  getOriginTabId(): number | null {
    return this.state.originTabId;
  }

  addActiveTab(tabId: number): void {
    if (typeof tabId === 'number') this.state.activeTabs.add(tabId);
  }

  removeActiveTab(tabId: number): void {
    this.state.activeTabs.delete(tabId);
  }

  getActiveTabs(): number[] {
    return Array.from(this.state.activeTabs);
  }

  async startSession(flow: Flow, originTabId: number): Promise<void> {
    this.state = {
      sessionId: `sess_${Date.now()}`,
      status: 'recording',
      originTabId,
      flow,
      activeTabs: new Set<number>([originTabId]),
    };
  }

  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    this.state.status = 'idle';
    this.state.flow = null;
    this.state.originTabId = null;
    this.state.activeTabs.clear();
    return flow;
  }

  updateFlow(mutator: (f: Flow) => void): void {
    const f = this.state.flow;
    if (!f) return;
    mutator(f);
    try {
      (f.meta as any).updatedAt = new Date().toISOString();
    } catch (e) {
      // ignore meta update errors
    }
  }

  appendSteps(steps: Step[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(steps) || steps.length === 0) return;
    // Reuse builder implementation (ids + meta update) for consistency
    appendFlowSteps(f, steps);
    this.broadcastTimelineUpdate(steps);
  }

  // Broadcast timeline updates to relevant tabs (top-frame only)
  broadcastTimelineUpdate(steps: Step[]): void {
    try {
      if (!steps || steps.length === 0) return;
      // Send full timeline to keep UI consistent across tabs
      const fullSteps = this.state.flow?.steps || [];
      // Prefer broadcasting to all tabs that participated in this session, so timeline
      // stays consistent when user switches across tabs/windows during a single session.
      const targets = this.getActiveTabs();
      const list =
        targets && targets.length
          ? targets
          : this.state.originTabId != null
            ? [this.state.originTabId]
            : [];
      for (const tabId of list) {
        chrome.tabs.sendMessage(
          tabId,
          { action: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE, steps: fullSteps },
          { frameId: 0 },
        );
      }
    } catch {}
  }
}

// Singleton for wiring convenience
export const recordingSession = new RecordingSessionManager();

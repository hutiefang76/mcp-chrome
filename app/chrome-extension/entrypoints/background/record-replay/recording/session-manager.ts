import type { Flow, Step, VariableDef } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { appendSteps as appendFlowSteps } from './flow-builder';

/**
 * Recording status state machine:
 * - idle: No active recording
 * - recording: Actively capturing user interactions
 * - paused: Temporarily paused (UI can resume)
 * - stopping: Draining final steps from content scripts before save
 */
export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopping';

export interface RecordingSessionState {
  sessionId: string;
  status: RecordingStatus;
  originTabId: number | null;
  flow: Flow | null;
  // Track tabs that have participated in this recording session
  activeTabs: Set<number>;
  // Track which tabs have acknowledged stop command
  stoppedTabs: Set<number>;
}

export class RecordingSessionManager {
  private state: RecordingSessionState = {
    sessionId: '',
    status: 'idle',
    originTabId: null,
    flow: null,
    activeTabs: new Set<number>(),
    stoppedTabs: new Set<number>(),
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
      stoppedTabs: new Set<number>(),
    };
  }

  /**
   * Transition to stopping state. Content scripts can still send final steps.
   * Returns the sessionId for barrier verification.
   */
  beginStopping(): string {
    if (this.state.status === 'idle') return '';
    this.state.status = 'stopping';
    this.state.stoppedTabs.clear();
    return this.state.sessionId;
  }

  /**
   * Mark a tab as having acknowledged the stop command.
   * Returns true if all active tabs have stopped.
   */
  markTabStopped(tabId: number): boolean {
    this.state.stoppedTabs.add(tabId);
    // Check if all active tabs have acknowledged
    for (const activeTabId of this.state.activeTabs) {
      if (!this.state.stoppedTabs.has(activeTabId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if we're in stopping state (still accepting final steps).
   */
  isStopping(): boolean {
    return this.state.status === 'stopping';
  }

  /**
   * Check if we can accept steps (recording or stopping).
   */
  canAcceptSteps(): boolean {
    return this.state.status === 'recording' || this.state.status === 'stopping';
  }

  /**
   * Transition to paused state.
   */
  pause(): void {
    if (this.state.status === 'recording') {
      this.state.status = 'paused';
    }
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'recording';
    }
  }

  /**
   * Finalize stop and clear session state.
   */
  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    this.state.status = 'idle';
    this.state.flow = null;
    this.state.originTabId = null;
    this.state.activeTabs.clear();
    this.state.stoppedTabs.clear();
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

  /**
   * Append or upsert steps to the flow.
   * Uses upsert semantics: if a step with the same id exists, update it in place.
   * This ensures fill steps get their final value even after initial flush.
   */
  appendSteps(steps: Step[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(steps) || steps.length === 0) return;

    // Ensure steps array exists
    if (!f.steps) {
      f.steps = [];
    }

    // Build a map of existing step ids for fast lookup
    const existingStepMap = new Map<string, number>();
    f.steps.forEach((s, idx) => {
      if (s.id) existingStepMap.set(s.id, idx);
    });

    // Process each incoming step with upsert semantics
    for (const step of steps) {
      // Ensure step has an id
      if (!step.id) {
        step.id = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      }

      const existingIdx = existingStepMap.get(step.id);
      if (existingIdx !== undefined) {
        // Upsert: update existing step in place (preserves order)
        f.steps[existingIdx] = step;
      } else {
        // Append: new step
        f.steps.push(step);
        existingStepMap.set(step.id, f.steps.length - 1);
      }
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }

    this.broadcastTimelineUpdate(steps);
  }

  /**
   * Append variables to the flow. Deduplicates by key.
   */
  appendVariables(variables: VariableDef[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(variables) || variables.length === 0) return;

    if (!f.variables) {
      f.variables = [];
    }

    // Deduplicate by key - newer definitions override older ones
    const existingKeys = new Set(f.variables.map((v) => v.key));
    for (const v of variables) {
      if (!v.key) continue;
      if (existingKeys.has(v.key)) {
        // Update existing variable
        const idx = f.variables.findIndex((fv) => fv.key === v.key);
        if (idx >= 0) {
          f.variables[idx] = v;
        }
      } else {
        f.variables.push(v);
        existingKeys.add(v.key);
      }
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }
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

import type { Flow } from '../types';
import { saveFlow } from '../flow-store';
import { broadcastControlToTab, ensureRecorderInjected, REC_CMD } from './content-injection';
import { recordingSession as session } from './session-manager';
import { createInitialFlow, addNavigationStep } from './flow-builder';
import { initBrowserEventListeners } from './browser-event-listener';
import { initContentMessageHandler } from './content-message-handler';

/** Timeout for waiting for content scripts to acknowledge stop command */
const STOP_BARRIER_TIMEOUT_MS = 3000;

/**
 * Send stop command to a tab and wait for acknowledgment.
 * Returns true if tab acknowledged, false on timeout/error.
 */
async function sendStopWithAck(tabId: number, sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn(`RecorderManager: Tab ${tabId} did not acknowledge stop within timeout`);
      resolve(false);
    }, STOP_BARRIER_TIMEOUT_MS);

    chrome.tabs
      .sendMessage(
        tabId,
        {
          action: REC_CMD.STOP,
          sessionId,
          requireAck: true,
        },
        { frameId: 0 }, // Only send to main frame
      )
      .then((response) => {
        clearTimeout(timeout);
        if (response && response.ack) {
          resolve(true);
        } else {
          resolve(false);
        }
      })
      .catch((err) => {
        clearTimeout(timeout);
        console.warn(`RecorderManager: Failed to send stop to tab ${tabId}:`, err);
        resolve(false);
      });
  });
}

class RecorderManagerImpl {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    initBrowserEventListeners(session);
    initContentMessageHandler(session);
    this.initialized = true;
  }

  async start(meta?: Partial<Flow>): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'idle')
      return { success: false, error: 'Recording already active' };
    // Resolve active tab
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) return { success: false, error: 'Active tab not found' };

    // Initialize flow & session
    const flow: Flow = createInitialFlow(meta);
    await session.startSession(flow, active.id);

    // Ensure recorder available and start listening
    await ensureRecorderInjected(active.id);
    await broadcastControlToTab(active.id, REC_CMD.START, {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      sessionId: session.getSession().sessionId,
    });
    // Track active tab for targeted STOP broadcasts
    session.addActiveTab(active.id);

    // Record first step
    const url = active.url;
    if (url) {
      addNavigationStep(flow, url);
      try {
        await saveFlow(flow);
      } catch (e) {
        console.warn('RecorderManager: initial saveFlow failed', e);
      }
    }

    return { success: true };
  }

  /**
   * Stop recording with reliable step collection.
   *
   * Flow:
   * 1. Transition to 'stopping' state (still accepts final steps)
   * 2. Send stop command to all active tabs with acknowledgment
   * 3. Wait for all tabs to flush their buffers and acknowledge
   * 4. Finalize session and save flow
   */
  async stop(): Promise<{ success: boolean; error?: string; flow?: Flow }> {
    const currentStatus = session.getStatus();
    if (currentStatus === 'idle' || !session.getFlow()) {
      return { success: false, error: 'No active recording' };
    }

    // Already stopping - don't double-stop
    if (currentStatus === 'stopping') {
      return { success: false, error: 'Stop already in progress' };
    }

    // Step 1: Transition to stopping state
    const sessionId = session.beginStopping();
    const tabs = session.getActiveTabs();

    // Step 2: Send stop commands to all tabs and wait for acks
    // Each tab will flush its buffer, send final steps/variables, then acknowledge
    try {
      await Promise.all(tabs.map((tabId) => sendStopWithAck(tabId, sessionId)));
    } catch (e) {
      console.warn('RecorderManager: Error during stop broadcast:', e);
    }

    // Step 3: Allow a small grace period for any final messages in flight
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Step 4: Finalize - clear session state and save
    const flow = await session.stopSession();
    if (flow) {
      await saveFlow(flow);
    }

    return flow ? { success: true, flow } : { success: true };
  }

  /**
   * Pause recording. Steps are not collected while paused.
   */
  async pause(): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'recording') {
      return { success: false, error: 'Not currently recording' };
    }

    session.pause();

    // Broadcast pause to all active tabs
    const tabs = session.getActiveTabs();
    try {
      await Promise.all(tabs.map((id) => broadcastControlToTab(id, REC_CMD.PAUSE)));
    } catch (e) {
      console.warn('RecorderManager: Error during pause broadcast:', e);
    }

    return { success: true };
  }

  /**
   * Resume recording after pause.
   */
  async resume(): Promise<{ success: boolean; error?: string }> {
    if (session.getStatus() !== 'paused') {
      return { success: false, error: 'Not currently paused' };
    }

    session.resume();

    // Broadcast resume to all active tabs
    const tabs = session.getActiveTabs();
    try {
      await Promise.all(tabs.map((id) => broadcastControlToTab(id, REC_CMD.RESUME)));
    } catch (e) {
      console.warn('RecorderManager: Error during resume broadcast:', e);
    }

    return { success: true };
  }
}

export const RecorderManager = new RecorderManagerImpl();

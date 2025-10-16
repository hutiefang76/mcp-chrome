/* eslint-disable */
// recorder.js - content script for recording user interactions into steps
// Notes: Designed to run in ISOLATED world. Communicates via chrome.runtime messages.

(function () {
  if (window.__RR_RECORDER_INSTALLED__) return;
  window.__RR_RECORDER_INSTALLED__ = true;

  const SENSITIVE_INPUT_TYPES = new Set(['password']);
  const THROTTLE_SCROLL_MS = 200; // legacy (kept for safety)
  const SCROLL_DEBOUNCE_MS = 350; // record on scroll end; update last step during scroll
  const sampledDrag = [];

  let isRecording = false;
  // Persistent guard synced with background to prevent stray resume after stop/refresh
  let allowedByPersistentState = false;
  let isPaused = false;
  let hideInputValues = false;
  let highlightBox = null;
  let highlightEnabled = true;
  let pendingFlow = {
    id: `flow_${Date.now()}`,
    name: '未命名录制',
    version: 1,
    steps: [],
    variables: [],
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };

  // Debounce and coalesce state for input recording
  // Avoid generating one fill step per keystroke; update recent step instead
  const INPUT_DEBOUNCE_MS = 500;
  let lastFill = {
    ref: null,
    idx: -1,
    ts: 0,
  };

  // Initialize persistent recording state from storage and keep it in sync
  try {
    chrome.storage.local
      .get(['rr_recording_state'])
      .then((res) => {
        try {
          allowedByPersistentState = !!(
            res &&
            res.rr_recording_state &&
            res.rr_recording_state.active
          );
          // If state is inactive but a stray overlay is present, force remove
          if (
            !allowedByPersistentState &&
            (document.getElementById('__rr_rec_overlay') || isRecording)
          ) {
            isRecording = false;
            detach();
            removeOverlay();
          }
        } catch {}
      })
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area !== 'local') return;
        if (Object.prototype.hasOwnProperty.call(changes || {}, 'rr_recording_state')) {
          const nv = changes.rr_recording_state?.newValue;
          const active = !!(nv && nv.active);
          allowedByPersistentState = active;
          if (!active && (document.getElementById('__rr_rec_overlay') || isRecording)) {
            // Force stop any stray recorder UI and listeners
            isRecording = false;
            detach();
            removeOverlay();
            try {
              if (scrollTimer) clearTimeout(scrollTimer);
            } catch {}
            scrollTimer = null;
            lastScrollIdx = -1;
            if (hoverRAF) {
              try {
                cancelAnimationFrame(hoverRAF);
              } catch {}
              hoverRAF = 0;
            }
            if (batchTimer) {
              try {
                clearTimeout(batchTimer);
              } catch {}
              batchTimer = null;
              batch.length = 0;
            }
            sampledDrag.length = 0;
            lastFill = { ref: null, idx: -1, ts: 0 };
          }
        }
      } catch {}
    });
  } catch {}

  function now() {
    return Date.now();
  }

  function toRef(el) {
    if (!window.__claudeElementMap) window.__claudeElementMap = {};
    if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
    for (const k in window.__claudeElementMap) {
      if (window.__claudeElementMap[k].deref && window.__claudeElementMap[k].deref() === el)
        return k;
    }
    const id = `ref_${++window.__claudeRefCounter}`;
    window.__claudeElementMap[id] = new WeakRef(el);
    return id;
  }

  // Try to produce a short unique class-based selector
  function uniqueClassSelector(el) {
    try {
      const classes = Array.from(el.classList || []).filter((c) => c && /^[a-zA-Z0-9_-]+$/.test(c));
      for (const cls of classes) {
        const sel = `.${CSS.escape(cls)}`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      for (const cls of classes) {
        const sel = `${tag}.${CSS.escape(cls)}`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      for (let i = 0; i < Math.min(classes.length, 3); i++) {
        for (let j = i + 1; j < Math.min(classes.length, 3); j++) {
          const sel = `.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
    } catch {}
    return '';
  }

  function generateSelector(el) {
    if (!(el instanceof Element)) return '';
    if (/** @type {HTMLElement} */ (el).id) {
      const idSel = `#${CSS.escape(/** @type {HTMLElement} */ (el).id)}`;
      if (document.querySelectorAll(idSel).length === 1) return idSel;
    }
    for (const attr of ['data-testid', 'data-cy', 'name']) {
      const attrValue = el.getAttribute(attr);
      if (attrValue) {
        const s = `[${attr}="${CSS.escape(attrValue)}"]`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
    }
    let path = '';
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName !== 'BODY') {
      let selector = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName,
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      path = path ? `${selector} > ${path}` : selector;
      current = parent;
    }
    return path ? `body > ${path}` : 'body';
  }

  function buildTarget(el) {
    const ref = toRef(el);
    const candidates = [];
    // Prefer id or unique class selector
    const classSel = uniqueClassSelector(el);
    if (classSel) candidates.push({ type: 'css', value: classSel });
    const css = generateSelector(el);
    if (css) candidates.push({ type: 'css', value: css });
    const name = el.getAttribute && el.getAttribute('name');
    if (name) candidates.push({ type: 'attr', value: `[name="${name}"]` });
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) candidates.push({ type: 'aria', value: `textbox[name=${aria}]` });
    // Fallback to text for clickable elements
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'summary'].includes(tag)) {
      const text = (el.textContent || '').trim();
      if (text) candidates.push({ type: 'text', value: text.substring(0, 64) });
    }
    return { ref, candidates };
  }

  function addVariable(key, sensitive, defaultValue) {
    if (!pendingFlow.variables) pendingFlow.variables = [];
    if (pendingFlow.variables.find((v) => v.key === key)) return;
    pendingFlow.variables.push({ key, sensitive: !!sensitive, default: defaultValue || '' });
  }

  // batch send steps to reduce message overhead
  let batch = [];
  let batchTimer = null;
  function flushBatch() {
    if (!batch.length) return;
    const steps = batch.slice();
    batch.length = 0;
    try {
      chrome.runtime.sendMessage({
        type: 'rr_recorder_event',
        payload: { kind: 'steps', steps },
      });
    } catch {}
  }
  function pushStep(step) {
    step.id = step.id || `step_${now()}_${Math.random().toString(36).slice(2, 6)}`;
    pendingFlow.steps.push(step);
    batch.push(step);
    pendingFlow.meta.updatedAt = new Date().toISOString();
    if (batchTimer) {
      try {
        clearTimeout(batchTimer);
      } catch {}
    }
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushBatch();
    }, 80);
  }

  function onClick(e) {
    if (!isRecording || isPaused) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    // Ignore clicks inside our own overlay UI
    try {
      const overlay = document.getElementById('__rr_rec_overlay');
      if (overlay && (el === overlay || (el.closest && el.closest('#__rr_rec_overlay')))) return;
    } catch {}
    try {
      // Special-case: clicking on <a target="_blank"> should record as openTab + switchTab
      const a = el.closest && el.closest('a[href]');
      const href = a && a.getAttribute && a.getAttribute('href');
      const tgt = a && a.getAttribute && a.getAttribute('target');
      if (a && href && tgt && tgt.toLowerCase() === '_blank') {
        // Prevent duplicate click step for this case; record open/switch sequence instead
        try {
          const abs = new URL(href, location.href).href;
          pushStep({ type: 'openTab', url: abs });
          pushStep({ type: 'switchTab', urlContains: abs });
          return;
        } catch (_) {
          // Fallback to raw href substring match
          pushStep({ type: 'openTab', url: href });
          pushStep({ type: 'switchTab', urlContains: href });
          return;
        }
      }
    } catch (_e) {
      /* ignore */
    }
    const target = buildTarget(el);
    pushStep({ type: e.detail >= 2 ? 'dblclick' : 'click', target, screenshotOnFail: true });
  }

  function onInput(e) {
    if (!isRecording || isPaused) return;
    const el =
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        ? e.target
        : null;
    if (!el) return;
    const target = buildTarget(el);
    const isSensitive =
      hideInputValues || SENSITIVE_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
    let value = el.value || '';
    if (isSensitive) {
      const varKey = el.name ? el.name : `var_${Math.random().toString(36).slice(2, 6)}`;
      addVariable(varKey, true, '');
      value = `{${varKey}}`;
    }
    const nowTs = now();
    // If recent fill for the same element within debounce window, update it instead of pushing
    const sameRef = lastFill.ref && target && target.ref && lastFill.ref === target.ref;
    const withinDebounce = nowTs - lastFill.ts <= INPUT_DEBOUNCE_MS;
    if (sameRef && withinDebounce && lastFill.idx >= 0) {
      try {
        const st = pendingFlow.steps[lastFill.idx];
        if (st && st.type === 'fill') {
          st.value = value;
          pendingFlow.meta.updatedAt = new Date().toISOString();
          lastFill.ts = nowTs;
          return;
        }
      } catch {}
    }
    pushStep({ type: 'fill', target, value, screenshotOnFail: true });
    lastFill = {
      ref: target && target.ref ? target.ref : null,
      idx: pendingFlow.steps.length - 1,
      ts: nowTs,
    };
  }

  function onKeydown(e) {
    if (!isRecording || isPaused) return;
    // Only record special keys or chords. Ignore plain character typing (handled by fill).
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.metaKey) mods.push('cmd');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    const key = (e.key || '').toLowerCase();
    const specialKeys = new Set([
      'enter',
      'escape',
      'esc',
      'tab',
      'backspace',
      'delete',
      'home',
      'end',
      'pageup',
      'pagedown',
      'arrowleft',
      'arrowright',
      'arrowup',
      'arrowdown',
    ]);
    const isPlainChar = key.length === 1 && mods.length === 0;
    const shouldRecord = mods.length > 0 || specialKeys.has(key);
    if (!shouldRecord || isPlainChar) return;
    const keys = mods.length ? `${mods.join('+')}+${key}` : key;
    pushStep({ type: 'key', keys, screenshotOnFail: false });
  }

  // keyup 不再记录，避免重复噪声

  // Composition IME events (record markers for analysis; playback is no-op via script step)
  function onCompositionStart() {
    if (!isRecording || isPaused) return;
    pushStep({
      type: 'script',
      world: 'ISOLATED',
      when: 'before',
      code: '/* compositionstart */',
      screenshotOnFail: false,
    });
  }
  function onCompositionEnd() {
    if (!isRecording || isPaused) return;
    pushStep({
      type: 'script',
      world: 'ISOLATED',
      when: 'before',
      code: '/* compositionend */',
      screenshotOnFail: false,
    });
  }

  let lastScrollAt = 0;
  let scrollTimer = null;
  let lastScrollIdx = -1;
  function onScroll(e) {
    if (!isRecording || isPaused) return;
    const nowTs = now();
    // Soft throttle
    if (nowTs - lastScrollAt < Math.min(THROTTLE_SCROLL_MS, 100)) return;
    lastScrollAt = nowTs;
    const top = window.scrollY || document.documentElement.scrollTop || 0;
    try {
      if (lastScrollIdx >= 0 && pendingFlow.steps[lastScrollIdx]) {
        const st = pendingFlow.steps[lastScrollIdx];
        if (st && st.type === 'scroll' && st.mode === 'offset') {
          st.offset = { x: 0, y: top };
          pendingFlow.meta.updatedAt = new Date().toISOString();
        }
      } else {
        // Reduce overhead: do not build element target for generic window scroll
        pushStep({ type: 'scroll', mode: 'offset', offset: { x: 0, y: top } });
        lastScrollIdx = pendingFlow.steps.length - 1;
      }
    } catch {}
    if (scrollTimer) {
      try {
        clearTimeout(scrollTimer);
      } catch {}
    }
    scrollTimer = setTimeout(() => {
      lastScrollIdx = -1;
      scrollTimer = null;
    }, SCROLL_DEBOUNCE_MS);
  }

  let dragging = false;
  function onMouseDown(e) {
    if (!isRecording) return;
    dragging = true;
    sampledDrag.length = 0;
    sampledDrag.push({ x: e.clientX, y: e.clientY });
  }
  function onMouseMove(e) {
    if (!isRecording) return;
    if (!dragging) return;
    if (sampledDrag.length === 0 || now() - sampledDrag._lastTs > 100) {
      sampledDrag.push({ x: e.clientX, y: e.clientY });
      sampledDrag._lastTs = now();
      if (sampledDrag.length > 30) sampledDrag.splice(1, sampledDrag.length - 30);
    }
  }
  function onMouseUp(e) {
    if (!isRecording) return;
    if (!dragging) return;
    dragging = false;
    const start = sampledDrag[0];
    const end = { x: e.clientX, y: e.clientY };
    if (start) {
      pushStep({
        type: 'drag',
        start: { ref: undefined, candidates: [] },
        end: { ref: undefined, candidates: [] },
        path: sampledDrag.slice(),
      });
    }
  }

  function attach() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);
    // document.addEventListener('keyup', onKeyup, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
  }

  function detach() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeydown, true);
    // document.removeEventListener('keyup', onKeyup, true);
    document.removeEventListener('compositionstart', onCompositionStart, true);
    document.removeEventListener('compositionend', onCompositionEnd, true);
    try {
      window.removeEventListener('scroll', onScroll, false);
    } catch {}
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
  }

  function reset(flowMeta) {
    pendingFlow = {
      id: flowMeta && flowMeta.id ? flowMeta.id : `flow_${Date.now()}`,
      name: (flowMeta && flowMeta.name) || '未命名录制',
      version: 1,
      steps: [],
      variables: [],
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        domain: location.hostname,
        bindings: [{ type: 'domain', value: location.hostname }],
      },
    };
  }

  function start(flowMeta) {
    reset(flowMeta || {});
    isRecording = true;
    isPaused = false;
    attach();
    ensureOverlay();
    chrome.runtime.sendMessage({
      type: 'rr_recorder_event',
      payload: { kind: 'start', flow: pendingFlow },
    });
    try {
      // Record current page URL as the first step when starting from an existing page
      // Only add once from the top frame and only when this is a fresh flow
      if (
        window === window.top &&
        Array.isArray(pendingFlow.steps) &&
        pendingFlow.steps.length === 0
      ) {
        const href = String(location && location.href ? location.href : '');
        if (href) pushStep({ type: 'navigate', url: href });
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function stop() {
    isRecording = false;
    detach();
    removeOverlay();
    // Clear timers and transient states to avoid post-stop overhead
    try {
      if (scrollTimer) clearTimeout(scrollTimer);
    } catch {}
    scrollTimer = null;
    lastScrollIdx = -1;
    if (hoverRAF) {
      try {
        cancelAnimationFrame(hoverRAF);
      } catch {}
      hoverRAF = 0;
    }
    if (batchTimer) {
      try {
        clearTimeout(batchTimer);
      } catch {}
      batchTimer = null;
      batch.length = 0;
    }
    sampledDrag.length = 0;
    lastFill = { ref: null, idx: -1, ts: 0 };
    chrome.runtime.sendMessage({
      type: 'rr_recorder_event',
      payload: { kind: 'stop', flow: pendingFlow },
    });
    // Release references to steps to reduce memory pressure after stop
    const ret = pendingFlow;
    try {
      pendingFlow.steps = [];
    } catch {}
    return ret;
  }

  function pause() {
    isPaused = true;
    updateOverlayStatus();
  }

  function resume() {
    // Only resume when background indicates an active recording session
    if (!allowedByPersistentState) return;
    isRecording = true;
    isPaused = false;
    attach();
    ensureOverlay();
    updateOverlayStatus();
  }

  function ensureOverlay() {
    // Only render overlay and highlight in top frame to reduce multi-frame overhead
    if (window !== window.top) return;
    let root = document.getElementById('__rr_rec_overlay');
    if (root) return;
    root = document.createElement('div');
    root.id = '__rr_rec_overlay';
    Object.assign(root.style, {
      position: 'fixed',
      top: '10px',
      right: '10px',
      zIndex: 2147483646,
      fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial',
    });
    root.innerHTML = `
      <div id="__rr_rec_panel" style="background: rgba(220,38,38,0.95); color: #fff; padding:8px 10px; border-radius:8px; display:flex; align-items:center; gap:8px; box-shadow:0 4px 16px rgba(0,0,0,0.2);">
        <span id="__rr_badge" style="font-weight:600;">录制中</span>
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:12px;">
          <input id="__rr_hide_values" type="checkbox" style="vertical-align:middle;" />隐藏输入值
        </label>
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:12px;">
          <input id="__rr_enable_highlight" type="checkbox" style="vertical-align:middle;" />高亮
        </label>
        <button id="__rr_pause" style="background:#fff; color:#111; border:none; border-radius:6px; padding:4px 8px; cursor:pointer;">暂停</button>
        <button id="__rr_stop" style="background:#111; color:#fff; border:none; border-radius:6px; padding:4px 8px; cursor:pointer;">停止</button>
      </div>
    `;
    document.documentElement.appendChild(root);
    const btnPause = root.querySelector('#__rr_pause');
    const btnStop = root.querySelector('#__rr_stop');
    const hideChk = root.querySelector('#__rr_hide_values');
    const highlightChk = root.querySelector('#__rr_enable_highlight');
    hideChk.checked = hideInputValues;
    hideChk.addEventListener('change', () => (hideInputValues = hideChk.checked));
    highlightChk.checked = highlightEnabled;
    highlightChk.addEventListener('change', () => {
      highlightEnabled = !!highlightChk.checked;
      try {
        if (highlightEnabled) document.addEventListener('mousemove', onHoverMove, true);
        else document.removeEventListener('mousemove', onHoverMove, true);
      } catch {}
    });
    btnPause.addEventListener('click', () => {
      if (!isPaused) pause();
      else resume();
    });
    btnStop.addEventListener('click', () => {
      stop();
    });
    updateOverlayStatus();
    // element highlight box
    highlightBox = document.createElement('div');
    Object.assign(highlightBox.style, {
      position: 'fixed',
      border: '2px solid rgba(59,130,246,0.9)',
      borderRadius: '4px',
      background: 'rgba(59,130,246,0.15)',
      pointerEvents: 'none',
      zIndex: 2147483645,
    });
    document.documentElement.appendChild(highlightBox);
    if (highlightEnabled) document.addEventListener('mousemove', onHoverMove, true);
  }

  function removeOverlay() {
    try {
      if (window === window.top) {
        const root = document.getElementById('__rr_rec_overlay');
        if (root) root.remove();
        if (highlightBox) highlightBox.remove();
        document.removeEventListener('mousemove', onHoverMove, true);
      }
    } catch {}
  }

  function updateOverlayStatus() {
    const badge = document.getElementById('__rr_badge');
    const pauseBtn = document.getElementById('__rr_pause');
    if (badge) badge.textContent = isPaused ? '已暂停' : '录制中';
    if (pauseBtn) pauseBtn.textContent = isPaused ? '继续' : '暂停';
  }

  let hoverRAF = 0;
  function onHoverMove(e) {
    if (!highlightBox || !isRecording || isPaused) return;
    if (hoverRAF) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    hoverRAF = requestAnimationFrame(() => {
      try {
        const r = el.getBoundingClientRect();
        Object.assign(highlightBox.style, {
          left: `${Math.round(r.left)}px`,
          top: `${Math.round(r.top)}px`,
          width: `${Math.round(Math.max(0, r.width))}px`,
          height: `${Math.round(Math.max(0, r.height))}px`,
          display: r.width > 0 && r.height > 0 ? 'block' : 'none',
        });
      } catch {}
      hoverRAF = 0;
    });
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      if (request && request.action === 'rr_recorder_control') {
        const cmd = request.cmd;
        if (cmd === 'start') {
          start(request.meta || {});
          sendResponse({ success: true });
          return true;
        } else if (cmd === 'pause') {
          pause();
          sendResponse({ success: true });
          return true;
        } else if (cmd === 'resume') {
          resume();
          sendResponse({ success: true });
          return true;
        } else if (cmd === 'stop') {
          const flow = stop();
          sendResponse({ success: true, flow });
          return true;
        }
      }
    } catch (e) {
      sendResponse({ success: false, error: String(e && e.message ? e.message : e) });
      return true;
    }
    return false;
  });

  // ping handler
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request && request.action === 'rr_recorder_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
    return false;
  });

  console.log('Record & Replay recorder.js loaded');
})();

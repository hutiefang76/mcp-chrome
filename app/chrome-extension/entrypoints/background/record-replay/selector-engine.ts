import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TargetLocator, SelectorCandidate } from './types';

// design note: minimal selector engine that tries ref then candidates

export interface LocatedElement {
  ref?: string;
  center?: { x: number; y: number };
  resolvedBy?: 'ref' | SelectorCandidate['type'];
}

/**
 * Try to resolve an element using ref or candidates via content scripts
 */
export async function locateElement(
  tabId: number,
  target: TargetLocator,
  frameId?: number,
): Promise<LocatedElement | null> {
  // Prefer stable selectors (css/attr/aria/text/xpath); only use ref as a last resort.
  // Rationale: ref is ephemeral across navigations/renders and should not be prioritized in replay.
  for (const c of target.candidates || []) {
    try {
      if (c.type === 'css' || c.type === 'attr') {
        const ensured = await chrome.tabs.sendMessage(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: c.value,
          } as any,
          { frameId } as any,
        );
        if (ensured && ensured.success && ensured.ref && ensured.center) {
          return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
        }
      } else if (c.type === 'text') {
        // Search by visible innerText contains value
        const ensured = await chrome.tabs.sendMessage(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            useText: true,
            text: c.value,
          } as any,
          { frameId } as any,
        );
        if (ensured && ensured.success && ensured.ref && ensured.center) {
          return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
        }
      } else if (c.type === 'aria') {
        // Minimal ARIA role+name parser like: "button[name=提交]" or "textbox[name=用户名]"
        const v = String(c.value || '').trim();
        const m = v.match(/^(\w+)\s*\[\s*name\s*=\s*([^\]]+)\]$/);
        const role = m ? m[1] : '';
        const name = m ? m[2] : '';
        const cleanName = name.replace(/^['"]|['"]$/g, '');
        const ariaSelectors: string[] = [];
        if (role === 'textbox') {
          ariaSelectors.push(
            `[role="textbox"][aria-label=${JSON.stringify(cleanName)}]`,
            `input[aria-label=${JSON.stringify(cleanName)}]`,
            `textarea[aria-label=${JSON.stringify(cleanName)}]`,
          );
        } else if (role === 'button') {
          ariaSelectors.push(
            `[role="button"][aria-label=${JSON.stringify(cleanName)}]`,
            `button[aria-label=${JSON.stringify(cleanName)}]`,
          );
        } else if (role === 'link') {
          ariaSelectors.push(
            `[role="link"][aria-label=${JSON.stringify(cleanName)}]`,
            `a[aria-label=${JSON.stringify(cleanName)}]`,
          );
        }
        if (!ariaSelectors.length && role) {
          ariaSelectors.push(
            `[role=${JSON.stringify(role)}][aria-label=${JSON.stringify(cleanName)}]`,
          );
        }
        for (const sel of ariaSelectors) {
          const ensured = await chrome.tabs.sendMessage(
            tabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: sel,
            } as any,
            { frameId } as any,
          );
          if (ensured && ensured.success && ensured.ref && ensured.center) {
            return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
          }
        }
      } else if (c.type === 'xpath') {
        // Minimal xpath support via document.evaluate through injected helper
        const ensured = await chrome.tabs.sendMessage(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector: c.value,
            isXPath: true,
          } as any,
          { frameId } as any,
        );
        if (ensured && ensured.success && ensured.ref && ensured.center) {
          return { ref: ensured.ref, center: ensured.center, resolvedBy: c.type };
        }
      }
    } catch (e) {
      // continue to next candidate
    }
  }
  // Fallback: try ref (works when ref was produced in the same page lifecycle)
  if (target.ref) {
    try {
      const res = await chrome.tabs.sendMessage(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
          ref: target.ref,
        } as any,
        { frameId } as any,
      );
      if (res && res.success && res.center) {
        return { ref: target.ref, center: res.center, resolvedBy: 'ref' };
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Ensure screenshot context hostname is still valid for coordinate-based actions
 */
export function validateScreenshotHostname(_tabUrl?: string): string | null {
  // Minimal placeholder - domain safety checks handled elsewhere
  return null;
}

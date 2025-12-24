/**
 * Effects Control (Phase 5.1)
 *
 * Edits inline effect styles:
 * - box-shadow (Drop Shadow / Inner Shadow)
 * - filter: blur() (Layer Blur)
 * - backdrop-filter: blur() (Backdrop Blur)
 *
 * Notes:
 * - `box-shadow` can contain multiple comma-separated shadows; this control edits the first one.
 * - `filter`/`backdrop-filter` can contain multiple functions; this control updates `blur()` and keeps others.
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createColorField, type ColorField } from './color-field';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const EFFECT_TYPES = [
  { value: 'drop-shadow', label: 'Drop Shadow' },
  { value: 'inner-shadow', label: 'Inner Shadow' },
  { value: 'layer-blur', label: 'Layer Blur' },
  { value: 'backdrop-blur', label: 'Backdrop Blur' },
] as const;

type EffectType = (typeof EFFECT_TYPES)[number]['value'];

type EffectsProperty = 'box-shadow' | 'filter' | 'backdrop-filter';

/**
 * Regex to match CSS length tokens (e.g., "10px", "-5.5em", "0")
 * Note: Does not match calc()/var() - those are treated as "other" tokens
 */
const LENGTH_TOKEN_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?$/;

/** Check if a token looks like a CSS function call (e.g., calc(), var()) */
function isCssFunctionToken(token: string): boolean {
  return /^[a-zA-Z_-]+\s*\(/.test(token);
}

// =============================================================================
// Types
// =============================================================================

interface ParsedBoxShadow {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

interface CssFunctionMatch {
  start: number;
  end: number;
  args: string;
}

// =============================================================================
// CSS Parsing Helpers
// =============================================================================

/**
 * Check if an element is focused within Shadow DOM context
 */
function isFieldFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement === el;
    return document.activeElement === el;
  } catch {
    return false;
  }
}

/**
 * Normalize a length value to include "px" unit if missing
 */
function normalizeLength(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  // Pure number: add "px" unit
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return `${trimmed}px`;

  // Trailing dot: "10." -> "10px"
  if (/^-?\d+\.$/.test(trimmed)) return `${trimmed.slice(0, -1)}px`;

  return trimmed;
}

/**
 * Read inline style value from element
 */
function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    return style?.getPropertyValue?.(property)?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Read computed style value from element
 */
function readComputedValue(element: Element, property: string): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

/**
 * Split a CSS value by a separator, respecting parentheses and quotes
 */
function splitTopLevel(value: string, separator: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let start = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && ch === separator) {
      results.push(value.slice(start, i));
      start = i + 1;
    }
  }

  results.push(value.slice(start));
  return results;
}

/**
 * Tokenize a CSS value by whitespace, respecting parentheses and quotes
 */
function tokenizeTopLevel(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t) tokens.push(t);
    buffer = '';
  };

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      buffer += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      buffer += ch;
      escape = true;
      continue;
    }

    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      buffer += ch;
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      buffer += ch;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buffer += ch;
      continue;
    }

    if (depth === 0 && /\s/.test(ch)) {
      flush();
      continue;
    }

    buffer += ch;
  }

  flush();
  return tokens;
}

/**
 * Parse a single box-shadow value into components
 */
function parseBoxShadow(raw: string): ParsedBoxShadow | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;

  // Get the first shadow (before comma)
  const first = splitTopLevel(trimmed, ',')[0]?.trim() ?? '';
  if (!first || first.toLowerCase() === 'none') return null;

  const tokens = tokenizeTopLevel(first);
  if (tokens.length === 0) return null;

  let inset = false;
  const lengthTokens: string[] = [];
  const otherTokens: string[] = [];

  for (const token of tokens) {
    if (/^inset$/i.test(token)) {
      inset = true;
      continue;
    }

    // Pure length values (numbers with optional units)
    if (LENGTH_TOKEN_REGEX.test(token)) {
      lengthTokens.push(token);
    }
    // CSS functions like calc(), var() - treat as length if in length position
    else if (isCssFunctionToken(token) && lengthTokens.length < 4) {
      lengthTokens.push(token);
    } else {
      otherTokens.push(token);
    }
  }

  // Need at least 2 length values (offset-x, offset-y)
  if (lengthTokens.length < 2) return null;

  return {
    inset,
    offsetX: lengthTokens[0] ?? '',
    offsetY: lengthTokens[1] ?? '',
    blurRadius: lengthTokens[2] ?? '',
    spreadRadius: lengthTokens[3] ?? '',
    color: otherTokens.join(' ').trim(),
  };
}

/**
 * Format box-shadow components into CSS value
 */
function formatBoxShadow(input: {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}): string {
  const offsetX = normalizeLength(input.offsetX);
  const offsetY = normalizeLength(input.offsetY);
  const blurRadius = normalizeLength(input.blurRadius);
  const spreadRadius = normalizeLength(input.spreadRadius);
  const color = input.color.trim();

  // Return empty if no meaningful values
  if (!offsetX && !offsetY && !blurRadius && !spreadRadius && !color) return '';

  const parts: string[] = [];
  if (input.inset) parts.push('inset');

  parts.push(offsetX || '0px', offsetY || '0px');

  // Include blur if set or if spread is set
  if (blurRadius || spreadRadius) parts.push(blurRadius || '0px');
  if (spreadRadius) parts.push(spreadRadius);
  if (color) parts.push(color);

  return parts.join(' ');
}

/**
 * Update the first shadow in a comma-separated list, preserving others
 */
function upsertFirstShadow(existing: string, first: string): string {
  const base = existing.trim();
  const firstTrimmed = first.trim();

  const segments = base && base.toLowerCase() !== 'none' ? splitTopLevel(base, ',') : [];
  const tail = segments
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!firstTrimmed) return tail.join(', ');
  if (tail.length === 0) return firstTrimmed;
  return `${firstTrimmed}, ${tail.join(', ')}`;
}

/**
 * Find a CSS function call (e.g., blur(...)) in a filter value
 * Handles word boundaries to avoid matching "myblur" when looking for "blur"
 */
function findCssFunction(value: string, fnName: string): CssFunctionMatch | null {
  const src = value;
  const lower = src.toLowerCase();
  const needle = fnName.toLowerCase();

  let searchIndex = 0;

  while (searchIndex < src.length) {
    const found = lower.indexOf(needle, searchIndex);
    if (found < 0) return null;

    // Check word boundary: must not be preceded by a letter/digit/underscore/hyphen
    if (found > 0) {
      const prevChar = src[found - 1]!;
      if (/[a-zA-Z0-9_-]/.test(prevChar)) {
        searchIndex = found + needle.length;
        continue;
      }
    }

    // Find opening parenthesis (allow whitespace)
    let i = found + needle.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '(') {
      searchIndex = found + needle.length;
      continue;
    }

    const openIndex = i;
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let escape = false;

    for (let j = openIndex; j < src.length; j++) {
      const ch = src[j]!;

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        escape = true;
        continue;
      }

      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        continue;
      }

      if (ch === ')') {
        depth--;
        if (depth === 0) {
          return {
            start: found,
            end: j + 1,
            args: src.slice(openIndex + 1, j),
          };
        }
        continue;
      }
    }

    return null;
  }

  return null;
}

/**
 * Extract blur radius from filter/backdrop-filter value
 */
function parseBlurRadius(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  const match = findCssFunction(trimmed, 'blur');
  return match ? match.args.trim() : '';
}

/**
 * Update blur() function in filter value, preserving other functions
 */
function upsertBlurFunction(existing: string, radius: string): string {
  const base = existing.trim().toLowerCase() === 'none' ? '' : existing.trim();
  const match = base ? findCssFunction(base, 'blur') : null;

  const normalizedRadius = normalizeLength(radius);

  // Remove blur if radius is empty
  if (!normalizedRadius) {
    if (!match) return base;

    const left = base.slice(0, match.start).trimEnd();
    const right = base.slice(match.end).trimStart();
    if (left && right) return `${left} ${right}`.trim();
    return (left || right).trim();
  }

  const replacement = `blur(${normalizedRadius})`;

  // Add blur if not present
  if (!match) {
    if (!base) return replacement;
    return `${base} ${replacement}`.trim();
  }

  // Replace existing blur
  const left = base.slice(0, match.start).trimEnd();
  const right = base.slice(match.end).trimStart();
  const parts: string[] = [];
  if (left) parts.push(left);
  parts.push(replacement);
  if (right) parts.push(right);
  return parts.join(' ');
}

// =============================================================================
// Factory
// =============================================================================

export interface EffectsControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
}

export function createEffectsControl(options: EffectsControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentEffectType: EffectType = 'drop-shadow';
  let shadowColorValue = '';

  const handles: Record<EffectsProperty, StyleTransactionHandle | null> = {
    'box-shadow': null,
    filter: null,
    'backdrop-filter': null,
  };

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group';

  // -------------------------------------------------------------------------
  // DOM Construction Helpers
  // -------------------------------------------------------------------------

  function createInputRow(
    labelText: string,
    ariaLabel: string,
  ): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'we-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', ariaLabel);

    row.append(label, input);
    return { row, input };
  }

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly { value: string; label: string }[],
  ): { row: HTMLDivElement; select: HTMLSelectElement } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const select = document.createElement('select');
    select.className = 'we-select';
    select.setAttribute('aria-label', ariaLabel);

    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      select.append(opt);
    }

    row.append(label, select);
    return { row, select };
  }

  function createColorRow(labelText: string): {
    row: HTMLDivElement;
    colorFieldContainer: HTMLDivElement;
  } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const colorFieldContainer = document.createElement('div');
    colorFieldContainer.style.flex = '1';
    colorFieldContainer.style.minWidth = '0';

    row.append(label, colorFieldContainer);
    return { row, colorFieldContainer };
  }

  // -------------------------------------------------------------------------
  // Create UI Elements
  // -------------------------------------------------------------------------

  const { row: typeRow, select: effectTypeSelect } = createSelectRow(
    'Type',
    'Effect Type',
    EFFECT_TYPES,
  );

  // Shadow-specific fields
  const { row: offsetXRow, input: offsetXInput } = createInputRow('X', 'Shadow Offset X');
  const { row: offsetYRow, input: offsetYInput } = createInputRow('Y', 'Shadow Offset Y');
  const { row: shadowBlurRow, input: shadowBlurInput } = createInputRow(
    'Blur',
    'Shadow Blur Radius',
  );
  const { row: spreadRow, input: spreadInput } = createInputRow('Spread', 'Shadow Spread Radius');
  const { row: colorRow, colorFieldContainer } = createColorRow('Color');

  // Blur-specific fields
  const { row: blurRadiusRow, input: blurRadiusInput } = createInputRow('Radius', 'Blur Radius');

  root.append(typeRow, offsetXRow, offsetYRow, shadowBlurRow, spreadRow, colorRow, blurRadiusRow);
  container.append(root);
  disposer.add(() => root.remove());

  // Wire keyboard stepping for numeric inputs
  wireNumberStepping(disposer, offsetXInput, { mode: 'css-length' });
  wireNumberStepping(disposer, offsetYInput, { mode: 'css-length' });
  wireNumberStepping(disposer, shadowBlurInput, {
    mode: 'css-length',
    min: 0,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, spreadInput, {
    mode: 'css-length',
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, blurRadiusInput, {
    mode: 'css-length',
    min: 0,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });

  // Create color field
  const shadowColorField: ColorField = createColorField({
    container: colorFieldContainer,
    ariaLabel: 'Shadow Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      shadowColorValue = value;
      previewShadow();
    },
    onCommit: () => {
      commitTransaction('box-shadow');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('box-shadow');
      syncAllFields(true);
    },
  });
  disposer.add(() => shadowColorField.dispose());

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(property: EffectsProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const existing = handles[property];
    if (existing) return existing;

    const handle = transactionManager.beginStyle(target, property);
    handles[property] = handle;
    return handle;
  }

  function commitTransaction(property: EffectsProperty): void {
    const handle = handles[property];
    handles[property] = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: EffectsProperty): void {
    const handle = handles[property];
    handles[property] = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    commitTransaction('box-shadow');
    commitTransaction('filter');
    commitTransaction('backdrop-filter');
  }

  // -------------------------------------------------------------------------
  // Effect Type Helpers
  // -------------------------------------------------------------------------

  function isShadowType(type: EffectType): boolean {
    return type === 'drop-shadow' || type === 'inner-shadow';
  }

  function getBlurProperty(type: EffectType): EffectsProperty {
    return type === 'backdrop-blur' ? 'backdrop-filter' : 'filter';
  }

  function updateRowVisibility(): void {
    const isShadow = isShadowType(currentEffectType);

    offsetXRow.hidden = !isShadow;
    offsetYRow.hidden = !isShadow;
    shadowBlurRow.hidden = !isShadow;
    spreadRow.hidden = !isShadow;
    colorRow.hidden = !isShadow;
    blurRadiusRow.hidden = isShadow;
  }

  function isShadowEditing(): boolean {
    return (
      handles['box-shadow'] !== null ||
      isFieldFocused(offsetXInput) ||
      isFieldFocused(offsetYInput) ||
      isFieldFocused(shadowBlurInput) ||
      isFieldFocused(spreadInput) ||
      shadowColorField.isFocused()
    );
  }

  function isBlurEditing(property: EffectsProperty): boolean {
    return handles[property] !== null || isFieldFocused(blurRadiusInput);
  }

  // -------------------------------------------------------------------------
  // Live Preview
  // -------------------------------------------------------------------------

  function previewShadow(): void {
    if (disposer.isDisposed || !isShadowType(currentEffectType)) return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const handle = beginTransaction('box-shadow');
    if (!handle) return;

    const shadowValue = formatBoxShadow({
      inset: currentEffectType === 'inner-shadow',
      offsetX: offsetXInput.value,
      offsetY: offsetYInput.value,
      blurRadius: shadowBlurInput.value,
      spreadRadius: spreadInput.value,
      color: shadowColorValue,
    });

    const existingInline = readInlineValue(target, 'box-shadow');
    handle.set(upsertFirstShadow(existingInline, shadowValue));
  }

  function previewBlur(): void {
    if (disposer.isDisposed) return;
    if (currentEffectType !== 'layer-blur' && currentEffectType !== 'backdrop-blur') return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const property = getBlurProperty(currentEffectType);
    const handle = beginTransaction(property);
    if (!handle) return;

    const existingInline = readInlineValue(target, property);
    handle.set(upsertBlurFunction(existingInline, blurRadiusInput.value));
  }

  // -------------------------------------------------------------------------
  // Sync (Render from Element State)
  // -------------------------------------------------------------------------

  function setAllDisabled(disabled: boolean): void {
    effectTypeSelect.disabled = disabled;
    offsetXInput.disabled = disabled;
    offsetYInput.disabled = disabled;
    shadowBlurInput.disabled = disabled;
    spreadInput.disabled = disabled;
    blurRadiusInput.disabled = disabled;
    shadowColorField.setDisabled(disabled);
  }

  function clearAllValues(): void {
    offsetXInput.value = '';
    offsetYInput.value = '';
    shadowBlurInput.value = '';
    spreadInput.value = '';
    blurRadiusInput.value = '';
    shadowColorValue = '';
    shadowColorField.setValue('');
    shadowColorField.setPlaceholder('');
  }

  function syncShadowFields(force = false): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    if (isShadowEditing() && !force) return;

    const inlineValue = readInlineValue(target, 'box-shadow');
    const inlineParsed = inlineValue ? parseBoxShadow(inlineValue) : null;

    // Only read computed value if inline is empty or contains CSS variables
    const needsComputed = !inlineParsed || /\bvar\s*\(/i.test(inlineValue);
    const computedParsed = needsComputed
      ? parseBoxShadow(readComputedValue(target, 'box-shadow'))
      : null;

    const parsed = inlineParsed ?? computedParsed;

    if (!parsed) {
      offsetXInput.value = '';
      offsetYInput.value = '';
      shadowBlurInput.value = '';
      spreadInput.value = '';
      shadowColorValue = '';
      shadowColorField.setValue('');
      shadowColorField.setPlaceholder('');
      return;
    }

    offsetXInput.value = parsed.offsetX;
    offsetYInput.value = parsed.offsetY;
    shadowBlurInput.value = parsed.blurRadius;
    spreadInput.value = parsed.spreadRadius;

    if (inlineParsed) {
      shadowColorValue = inlineParsed.color;
      shadowColorField.setValue(inlineParsed.color);

      // Pass computed value as placeholder for CSS variables
      const needsPlaceholder = /\bvar\s*\(/i.test(inlineParsed.color);
      shadowColorField.setPlaceholder(needsPlaceholder ? (computedParsed?.color ?? '') : '');
    } else {
      shadowColorValue = parsed.color;
      shadowColorField.setValue(parsed.color);
      shadowColorField.setPlaceholder('');
    }
  }

  function syncBlurFields(property: EffectsProperty, force = false): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    if (isBlurEditing(property) && !force) return;

    const inlineValue = readInlineValue(target, property);
    // Only read computed if inline is empty
    const display = inlineValue || readComputedValue(target, property);

    blurRadiusInput.value = parseBlurRadius(display);
  }

  function syncAllFields(force = false): void {
    updateRowVisibility();

    const target = currentTarget;
    if (!target || !target.isConnected) {
      setAllDisabled(true);
      clearAllValues();
      return;
    }

    setAllDisabled(false);

    if (isShadowType(currentEffectType)) {
      syncShadowFields(force);
    } else {
      syncBlurFields(getBlurProperty(currentEffectType), force);
    }
  }

  /**
   * Infer the initial effect type based on existing styles
   */
  function inferEffectType(target: Element): EffectType {
    const shadowValue =
      readInlineValue(target, 'box-shadow') || readComputedValue(target, 'box-shadow');
    const parsedShadow = parseBoxShadow(shadowValue);
    if (parsedShadow) return parsedShadow.inset ? 'inner-shadow' : 'drop-shadow';

    const filterValue = readInlineValue(target, 'filter') || readComputedValue(target, 'filter');
    if (parseBlurRadius(filterValue)) return 'layer-blur';

    const backdropValue =
      readInlineValue(target, 'backdrop-filter') || readComputedValue(target, 'backdrop-filter');
    if (parseBlurRadius(backdropValue)) return 'backdrop-blur';

    return 'drop-shadow';
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function rollbackAllTransactions(): void {
    rollbackTransaction('box-shadow');
    rollbackTransaction('filter');
    rollbackTransaction('backdrop-filter');
  }

  const onEffectTypeChange = () => {
    const next = effectTypeSelect.value as EffectType;
    if (next === currentEffectType) return;

    // Rollback any in-progress edits when switching effect type
    // This prevents accidentally committing half-edited values
    rollbackAllTransactions();
    currentEffectType = next;
    updateRowVisibility();
    syncAllFields(true);
  };

  disposer.listen(effectTypeSelect, 'input', onEffectTypeChange);
  disposer.listen(effectTypeSelect, 'change', onEffectTypeChange);

  function wireShadowInput(input: HTMLInputElement): void {
    disposer.listen(input, 'input', previewShadow);

    disposer.listen(input, 'blur', () => {
      commitTransaction('box-shadow');
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('box-shadow');
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('box-shadow');
        syncAllFields(true);
      }
    });
  }

  wireShadowInput(offsetXInput);
  wireShadowInput(offsetYInput);
  wireShadowInput(shadowBlurInput);
  wireShadowInput(spreadInput);

  disposer.listen(blurRadiusInput, 'input', previewBlur);

  disposer.listen(blurRadiusInput, 'blur', () => {
    if (currentEffectType !== 'layer-blur' && currentEffectType !== 'backdrop-blur') return;
    commitTransaction(getBlurProperty(currentEffectType));
    syncAllFields();
  });

  disposer.listen(blurRadiusInput, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentEffectType === 'layer-blur' || currentEffectType === 'backdrop-blur') {
        commitTransaction(getBlurProperty(currentEffectType));
        syncAllFields();
      }
      blurRadiusInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (currentEffectType === 'layer-blur' || currentEffectType === 'backdrop-blur') {
        rollbackTransaction(getBlurProperty(currentEffectType));
        syncAllFields(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    if (element && element.isConnected) {
      currentEffectType = inferEffectType(element);
      effectTypeSelect.value = currentEffectType;
    }

    syncAllFields(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncAllFields();
  }

  function dispose(): void {
    commitAllTransactions();
    currentTarget = null;
    disposer.dispose();
  }

  // Initialize
  effectTypeSelect.value = currentEffectType;
  syncAllFields(true);

  return { setTarget, refresh, dispose };
}

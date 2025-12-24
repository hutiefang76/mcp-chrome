/**
 * Gradient Control
 *
 * Edits inline `background-image` gradients (simplified):
 * - linear-gradient(<angle>deg, <stop>, <stop>)
 * - radial-gradient([<shape>] [at <x>% <y>%], <stop>, <stop>)
 *
 * Limitations:
 * - Only supports up to 2 color stops for simplicity
 * - Only supports numeric angles (deg) and percent positions
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

const GRADIENT_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
] as const;

type GradientType = (typeof GRADIENT_TYPES)[number]['value'];

const RADIAL_SHAPES = [
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'circle', label: 'Circle' },
] as const;

type RadialShape = (typeof RADIAL_SHAPES)[number]['value'];

const DEFAULT_LINEAR_ANGLE = 180;
const DEFAULT_POSITION = 50;

const DEFAULT_STOP_1: GradientStop = { color: '#000000', position: 0 };
const DEFAULT_STOP_2: GradientStop = { color: '#ffffff', position: 100 };

// =============================================================================
// Types
// =============================================================================

interface GradientStop {
  color: string;
  position: number;
}

interface ParsedLinearGradient {
  type: 'linear';
  angle: number;
  stops: [GradientStop, GradientStop];
}

interface ParsedRadialGradient {
  type: 'radial';
  shape: RadialShape;
  position: { x: number; y: number } | null;
  stops: [GradientStop, GradientStop];
}

type ParsedGradient = ParsedLinearGradient | ParsedRadialGradient;

interface ParsedStop {
  color: string;
  position: number | null;
}

// =============================================================================
// Helpers
// =============================================================================

function isFieldFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement === el;
    return document.activeElement === el;
  } catch {
    return false;
  }
}

function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    return style?.getPropertyValue?.(property)?.trim() ?? '';
  } catch {
    return '';
  }
}

function readComputedValue(element: Element, property: string): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

function isNoneValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed.toLowerCase() === 'none';
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseAngleToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*deg$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parsePercentToken(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse X position keyword (left/center/right or %)
 */
function parsePositionX(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'left') return 0;
  if (trimmed === 'right') return 100;

  return null;
}

/**
 * Parse Y position keyword (top/center/bottom or %)
 */
function parsePositionY(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const pct = parsePercentToken(trimmed);
  if (pct !== null) return pct;

  if (trimmed === 'center') return 50;
  if (trimmed === 'top') return 0;
  if (trimmed === 'bottom') return 100;

  return null;
}

/**
 * Check if a token is an X-axis keyword
 */
function isXKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'left' || lower === 'right';
}

/**
 * Check if a token is a Y-axis keyword
 */
function isYKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === 'top' || lower === 'bottom';
}

function clampAngle(value: number): number {
  return clampNumber(value, 0, 360);
}

function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
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

function parseColorStop(raw: string): ParsedStop | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = tokenizeTopLevel(trimmed);
  if (tokens.length === 0) return null;

  const color = tokens[0] ?? '';
  if (!color) return null;

  let position: number | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const p = parsePercentToken(tokens[i] ?? '');
    if (p !== null) {
      position = p;
      break;
    }
  }

  return { color, position };
}

function normalizeStops(stops: [ParsedStop, ParsedStop]): [GradientStop, GradientStop] {
  const s1 = stops[0];
  const s2 = stops[1];

  const c1 = s1.color.trim() || DEFAULT_STOP_1.color;
  const c2 = s2.color.trim() || DEFAULT_STOP_2.color;

  const p1 = clampPercent(s1.position ?? DEFAULT_STOP_1.position);
  const p2 = clampPercent(s2.position ?? DEFAULT_STOP_2.position);

  return [
    { color: c1, position: p1 },
    { color: c2, position: p2 },
  ];
}

function parseGradientFunctionCall(
  value: string,
): { kind: 'linear' | 'radial'; args: string } | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  let kind: 'linear' | 'radial' | null = null;
  let fnName = '';

  if (lower.startsWith('linear-gradient')) {
    kind = 'linear';
    fnName = 'linear-gradient';
  } else if (lower.startsWith('radial-gradient')) {
    kind = 'radial';
    fnName = 'radial-gradient';
  } else {
    return null;
  }

  let i = fnName.length;
  while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
  if (trimmed[i] !== '(') return null;

  const openIndex = i;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let j = openIndex; j < trimmed.length; j++) {
    const ch = trimmed[j]!;

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
        // Check no trailing content
        const trailing = trimmed.slice(j + 1).trim();
        if (trailing) return null;

        const args = trimmed.slice(openIndex + 1, j);
        return { kind, args };
      }
    }
  }

  return null;
}

function parseLinearGradient(args: string): ParsedLinearGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Need at least 2 color stops
  if (parts.length < 2) return null;

  // Check if first part is an angle
  const maybeAngle = parseAngleToken(parts[0] ?? '');

  let angle: number;
  let stop1: ParsedStop | null;
  let stop2: ParsedStop | null;

  if (maybeAngle !== null) {
    // Format: linear-gradient(angle, stop1, stop2, ...)
    if (parts.length < 3) return null;
    angle = maybeAngle;
    stop1 = parseColorStop(parts[1] ?? '');
    stop2 = parseColorStop(parts[2] ?? '');
  } else {
    // Format: linear-gradient(stop1, stop2, ...) - no angle, default to 180deg
    angle = DEFAULT_LINEAR_ANGLE;
    stop1 = parseColorStop(parts[0] ?? '');
    stop2 = parseColorStop(parts[1] ?? '');
  }

  if (!stop1 || !stop2) return null;

  return {
    type: 'linear',
    angle: clampAngle(angle),
    stops: normalizeStops([stop1, stop2]),
  };
}

function parseRadialGradient(args: string): ParsedRadialGradient | null {
  const parts = splitTopLevel(args, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  let shape: RadialShape = 'ellipse';
  let position: { x: number; y: number } | null = null;
  let stopStartIndex = 0;

  const first = parts[0] ?? '';
  const tokens = tokenizeTopLevel(first);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  const atIndex = lowerTokens.indexOf('at');
  const hasAt = atIndex >= 0;

  const hasCircle = lowerTokens.includes('circle');
  const hasEllipse = lowerTokens.includes('ellipse');
  const hasShape = hasCircle || hasEllipse;

  if (hasShape || hasAt) {
    stopStartIndex = 1;

    if (hasCircle) shape = 'circle';
    else if (hasEllipse) shape = 'ellipse';

    if (hasAt) {
      const token1 = tokens[atIndex + 1] ?? '';
      const token2 = tokens[atIndex + 2] ?? '';

      // Handle position parsing with axis awareness
      // CSS allows "at top right" (Y then X) or "at right top" (X then Y)
      let x: number | null = null;
      let y: number | null = null;

      // Check if first token is a Y keyword (top/bottom)
      if (isYKeyword(token1)) {
        // "at top" or "at top right" - first is Y
        y = parsePositionY(token1);
        x = token2 ? parsePositionX(token2) : null;
      } else if (isXKeyword(token1)) {
        // "at left" or "at left top" - first is X
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      } else {
        // Default: treat as "X Y" order (most common for percentages)
        x = parsePositionX(token1);
        y = token2 ? parsePositionY(token2) : null;
      }

      position = {
        x: clampPercent(x ?? DEFAULT_POSITION),
        y: clampPercent(y ?? DEFAULT_POSITION),
      };
    }
  }

  const stopParts = parts.slice(stopStartIndex);
  const stop1 = parseColorStop(stopParts[0] ?? '');
  const stop2 = parseColorStop(stopParts[1] ?? '');
  if (!stop1 || !stop2) return null;

  return {
    type: 'radial',
    shape,
    position,
    stops: normalizeStops([stop1, stop2]),
  };
}

function parseGradient(value: string): ParsedGradient | null {
  const fn = parseGradientFunctionCall(value);
  if (!fn) return null;
  return fn.kind === 'linear' ? parseLinearGradient(fn.args) : parseRadialGradient(fn.args);
}

function needsColorPlaceholder(value: string): boolean {
  return /\bvar\s*\(/i.test(value);
}

// =============================================================================
// Factory
// =============================================================================

export interface GradientControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
}

export function createGradientControl(options: GradientControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentType: GradientType = 'none';

  let stop1ColorValue = DEFAULT_STOP_1.color;
  let stop2ColorValue = DEFAULT_STOP_2.color;

  let backgroundHandle: StyleTransactionHandle | null = null;

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

  function createStopRow(
    labelText: string,
    posAriaLabel: string,
  ): {
    row: HTMLDivElement;
    colorFieldContainer: HTMLDivElement;
    posInput: HTMLInputElement;
  } {
    const row = document.createElement('div');
    row.className = 'we-field';

    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex:1;min-width:0;gap:4px;';

    const colorFieldContainer = document.createElement('div');
    colorFieldContainer.style.cssText = 'flex:1;min-width:0;';

    const posInput = document.createElement('input');
    posInput.type = 'text';
    posInput.className = 'we-input';
    posInput.autocomplete = 'off';
    posInput.spellcheck = false;
    posInput.inputMode = 'decimal';
    posInput.setAttribute('aria-label', posAriaLabel);
    posInput.style.cssText = 'flex:0 0 56px;text-align:right;';
    posInput.placeholder = '0';

    wrapper.append(colorFieldContainer, posInput);
    row.append(label, wrapper);
    return { row, colorFieldContainer, posInput };
  }

  // -------------------------------------------------------------------------
  // Create UI Elements
  // -------------------------------------------------------------------------

  const { row: typeRow, select: typeSelect } = createSelectRow(
    'Type',
    'Gradient Type',
    GRADIENT_TYPES,
  );

  const { row: angleRow, input: angleInput } = createInputRow('Angle', 'Gradient Angle (deg)');
  angleInput.placeholder = String(DEFAULT_LINEAR_ANGLE);

  const { row: shapeRow, select: shapeSelect } = createSelectRow(
    'Shape',
    'Radial Gradient Shape',
    RADIAL_SHAPES,
  );

  const { row: posXRow, input: posXInput } = createInputRow('Pos X', 'Radial Position X (%)');
  const { row: posYRow, input: posYInput } = createInputRow('Pos Y', 'Radial Position Y (%)');

  const {
    row: stop1Row,
    colorFieldContainer: stop1ColorContainer,
    posInput: stop1PosInput,
  } = createStopRow('Stop 1', 'Stop 1 Position (%)');

  const {
    row: stop2Row,
    colorFieldContainer: stop2ColorContainer,
    posInput: stop2PosInput,
  } = createStopRow('Stop 2', 'Stop 2 Position (%)');

  root.append(typeRow, angleRow, shapeRow, posXRow, posYRow, stop1Row, stop2Row);
  container.append(root);
  disposer.add(() => root.remove());

  // Wire keyboard stepping for numeric inputs
  wireNumberStepping(disposer, angleInput, {
    mode: 'number',
    min: 0,
    max: 360,
    step: 1,
    shiftStep: 15,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posXInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, posYInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, stop1PosInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, stop2PosInput, {
    mode: 'number',
    min: 0,
    max: 100,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });

  // Create color fields
  const stop1ColorField: ColorField = createColorField({
    container: stop1ColorContainer,
    ariaLabel: 'Stop 1 Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      stop1ColorValue = value;
      previewGradient();
    },
    onCommit: () => {
      commitTransaction();
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction();
      syncAllFields(true);
    },
  });
  disposer.add(() => stop1ColorField.dispose());

  const stop2ColorField: ColorField = createColorField({
    container: stop2ColorContainer,
    ariaLabel: 'Stop 2 Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      stop2ColorValue = value;
      previewGradient();
    },
    onCommit: () => {
      commitTransaction();
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction();
      syncAllFields(true);
    },
  });
  disposer.add(() => stop2ColorField.dispose());

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    if (backgroundHandle) return backgroundHandle;

    backgroundHandle = transactionManager.beginStyle(target, 'background-image');
    return backgroundHandle;
  }

  function commitTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(): void {
    const handle = backgroundHandle;
    backgroundHandle = null;
    if (handle) handle.rollback();
  }

  // -------------------------------------------------------------------------
  // UI State Helpers
  // -------------------------------------------------------------------------

  function updateRowVisibility(): void {
    angleRow.hidden = currentType !== 'linear';
    shapeRow.hidden = currentType !== 'radial';
    posXRow.hidden = currentType !== 'radial';
    posYRow.hidden = currentType !== 'radial';
    stop1Row.hidden = currentType === 'none';
    stop2Row.hidden = currentType === 'none';
  }

  function setAllDisabled(disabled: boolean): void {
    typeSelect.disabled = disabled;
    angleInput.disabled = disabled;
    shapeSelect.disabled = disabled;
    posXInput.disabled = disabled;
    posYInput.disabled = disabled;
    stop1PosInput.disabled = disabled;
    stop2PosInput.disabled = disabled;
    stop1ColorField.setDisabled(disabled);
    stop2ColorField.setDisabled(disabled);
  }

  function resetDefaults(): void {
    angleInput.value = String(DEFAULT_LINEAR_ANGLE);
    shapeSelect.value = 'ellipse';
    posXInput.value = '';
    posYInput.value = '';

    stop1PosInput.value = String(DEFAULT_STOP_1.position);
    stop2PosInput.value = String(DEFAULT_STOP_2.position);

    stop1ColorValue = DEFAULT_STOP_1.color;
    stop2ColorValue = DEFAULT_STOP_2.color;

    stop1ColorField.setValue(DEFAULT_STOP_1.color);
    stop2ColorField.setValue(DEFAULT_STOP_2.color);
    stop1ColorField.setPlaceholder('');
    stop2ColorField.setPlaceholder('');
  }

  function isEditing(): boolean {
    return (
      backgroundHandle !== null ||
      isFieldFocused(typeSelect) ||
      isFieldFocused(angleInput) ||
      isFieldFocused(shapeSelect) ||
      isFieldFocused(posXInput) ||
      isFieldFocused(posYInput) ||
      isFieldFocused(stop1PosInput) ||
      isFieldFocused(stop2PosInput) ||
      stop1ColorField.isFocused() ||
      stop2ColorField.isFocused()
    );
  }

  // -------------------------------------------------------------------------
  // Formatting / Live Preview
  // -------------------------------------------------------------------------

  function buildGradientValue(): string {
    if (currentType === 'none') return 'none';

    const c1 = stop1ColorValue.trim() || DEFAULT_STOP_1.color;
    const c2 = stop2ColorValue.trim() || DEFAULT_STOP_2.color;

    const p1 = clampPercent(parseNumber(stop1PosInput.value) ?? DEFAULT_STOP_1.position);
    const p2 = clampPercent(parseNumber(stop2PosInput.value) ?? DEFAULT_STOP_2.position);

    if (currentType === 'linear') {
      const angle = clampAngle(parseNumber(angleInput.value) ?? DEFAULT_LINEAR_ANGLE);
      return `linear-gradient(${angle}deg, ${c1} ${p1}%, ${c2} ${p2}%)`;
    }

    const shape = (shapeSelect.value as RadialShape) || 'ellipse';
    const rawX = posXInput.value.trim();
    const rawY = posYInput.value.trim();
    const includeAt = Boolean(rawX || rawY);

    const x = clampPercent(parseNumber(rawX) ?? DEFAULT_POSITION);
    const y = clampPercent(parseNumber(rawY) ?? DEFAULT_POSITION);

    const atClause = includeAt ? ` at ${x}% ${y}%` : '';
    return `radial-gradient(${shape}${atClause}, ${c1} ${p1}%, ${c2} ${p2}%)`;
  }

  function previewGradient(): void {
    if (disposer.isDisposed) return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const handle = beginTransaction();
    if (!handle) return;

    handle.set(buildGradientValue());
  }

  // -------------------------------------------------------------------------
  // Sync (Render from Element State)
  // -------------------------------------------------------------------------

  function syncAllFields(force = false): void {
    const target = currentTarget;

    if (!target || !target.isConnected) {
      setAllDisabled(true);
      currentType = 'none';
      typeSelect.value = 'none';
      resetDefaults();
      updateRowVisibility();
      return;
    }

    setAllDisabled(false);

    if (isEditing() && !force) return;

    const inlineValue = readInlineValue(target, 'background-image');
    const needsComputed = !inlineValue || /\bvar\s*\(/i.test(inlineValue);
    const computedValue = needsComputed ? readComputedValue(target, 'background-image') : '';

    const inlineParsed = !isNoneValue(inlineValue) ? parseGradient(inlineValue) : null;
    const computedParsed = !isNoneValue(computedValue) ? parseGradient(computedValue) : null;

    let parsed: ParsedGradient | null = null;
    let source: 'inline' | 'computed' | 'none' = 'none';

    if (inlineValue.trim()) {
      if (isNoneValue(inlineValue)) {
        parsed = null;
        source = 'none';
      } else if (inlineParsed) {
        parsed = inlineParsed;
        source = 'inline';
      } else {
        // Has value but couldn't parse - treat as none for our UI
        parsed = null;
        source = 'none';
      }
    } else {
      if (isNoneValue(computedValue)) {
        parsed = null;
        source = 'none';
      } else if (computedParsed) {
        parsed = computedParsed;
        source = 'computed';
      } else {
        parsed = null;
        source = 'none';
      }
    }

    resetDefaults();

    if (!parsed) {
      currentType = 'none';
      typeSelect.value = 'none';
      updateRowVisibility();
      return;
    }

    // Apply stops (with CSS variable placeholder support)
    const placeholderStops = source === 'inline' && computedParsed ? computedParsed.stops : null;

    const stop1 = parsed.stops[0];
    const stop2 = parsed.stops[1];

    stop1ColorValue = stop1.color;
    stop2ColorValue = stop2.color;

    stop1ColorField.setValue(stop1.color);
    stop2ColorField.setValue(stop2.color);

    stop1ColorField.setPlaceholder(
      source === 'inline' && needsColorPlaceholder(stop1.color)
        ? (placeholderStops?.[0].color ?? '')
        : '',
    );
    stop2ColorField.setPlaceholder(
      source === 'inline' && needsColorPlaceholder(stop2.color)
        ? (placeholderStops?.[1].color ?? '')
        : '',
    );

    stop1PosInput.value = String(stop1.position);
    stop2PosInput.value = String(stop2.position);

    if (parsed.type === 'linear') {
      currentType = 'linear';
      typeSelect.value = 'linear';
      angleInput.value = String(parsed.angle);
    } else {
      currentType = 'radial';
      typeSelect.value = 'radial';
      shapeSelect.value = parsed.shape;
      if (parsed.position) {
        posXInput.value = String(parsed.position.x);
        posYInput.value = String(parsed.position.y);
      } else {
        posXInput.value = '';
        posYInput.value = '';
      }
    }

    updateRowVisibility();
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function wireTextInput(input: HTMLInputElement): void {
    disposer.listen(input, 'input', previewGradient);

    disposer.listen(input, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  function wireSelect(select: HTMLSelectElement, onPreview?: () => void): void {
    const preview = () => {
      onPreview?.();
      previewGradient();
    };

    disposer.listen(select, 'input', preview);
    disposer.listen(select, 'change', preview);

    disposer.listen(select, 'blur', () => {
      commitTransaction();
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction();
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction();
        syncAllFields(true);
      }
    });
  }

  wireSelect(typeSelect, () => {
    currentType = typeSelect.value as GradientType;
    updateRowVisibility();
  });

  wireSelect(shapeSelect);

  wireTextInput(angleInput);
  wireTextInput(posXInput);
  wireTextInput(posYInput);
  wireTextInput(stop1PosInput);
  wireTextInput(stop2PosInput);

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitTransaction();
    currentTarget = element;
    syncAllFields(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncAllFields();
  }

  function dispose(): void {
    commitTransaction();
    currentTarget = null;
    disposer.dispose();
  }

  // Initialize
  typeSelect.value = currentType;
  resetDefaults();
  updateRowVisibility();
  syncAllFields(true);

  return { setTarget, refresh, dispose };
}

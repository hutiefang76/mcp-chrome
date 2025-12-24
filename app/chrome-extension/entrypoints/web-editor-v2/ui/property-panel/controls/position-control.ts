/**
 * Position Control (Phase 3.3 - Refactored)
 *
 * Edits inline positioning and transform styles:
 * - position (icon button group): static/relative/absolute/fixed/sticky
 * - X (left), Y (top), Z (z-index) inputs
 * - rotate (transform: rotate)
 * - flip X/Y (transform: scaleX/scaleY toggles)
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignControl } from '../types';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createIconButtonGroup, type IconButtonGroup } from '../components/icon-button-group';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';

// =============================================================================
// Types
// =============================================================================

type PositionValue = 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';

/** Single-style field keys */
type StyleProperty = 'position' | 'left' | 'top' | 'z-index';

/** All field keys */
type FieldKey = StyleProperty | 'transform';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

const POSITION_VALUES: readonly PositionValue[] = [
  'static',
  'relative',
  'absolute',
  'fixed',
  'sticky',
];

// SVG path data for position icons
const POSITION_ICON_PATHS: Record<PositionValue, string> = {
  // Static: Simple square (no positioning context)
  static: 'M3 3h9v9H3z',
  // Relative: Square with offset arrow
  relative: 'M3 3h7v7H3zM8 8l4 4M10 8v4h-4',
  // Absolute: Square with corner anchors
  absolute: 'M4 4h7v7H4zM2 2v2M2 2h2M13 2h-2M13 2v2M2 13v-2M2 13h2M13 13h-2M13 13v-2',
  // Fixed: Square pinned to viewport edge
  fixed: 'M1 1h13v13H1zM4 4h7v7H4z',
  // Sticky: Square with top adhesion line
  sticky: 'M2 3h11M4 6h7v6H4z',
};

// =============================================================================
// Transform Parsing Helpers
// =============================================================================

/** Represents a single transform function with its full string and parsed components */
interface TransformFunction {
  /** Original full string, e.g. "rotate(45deg)" */
  original: string;
  /** Function name lowercase, e.g. "rotate" */
  name: string;
  /** Arguments string (without parentheses), e.g. "45deg" */
  args: string;
}

/** Parsed transform state for editing */
interface TransformState {
  /** All parsed transform functions in original order */
  functions: TransformFunction[];
  /** Index of rotate function (-1 if not found) */
  rotateIndex: number;
  /** Index of scaleX function (-1 if not found) */
  scaleXIndex: number;
  /** Index of scaleY function (-1 if not found) */
  scaleYIndex: number;
}

/**
 * Tokenize transform string into individual functions.
 * Uses bracket-depth scanning to handle nested parentheses like var(), calc().
 */
function tokenizeTransform(transform: string): TransformFunction[] {
  const result: TransformFunction[] = [];
  if (!transform || transform === 'none') return result;

  const trimmed = transform.trim();
  let i = 0;

  while (i < trimmed.length) {
    // Skip whitespace
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    if (i >= trimmed.length) break;

    // Find function name (letters, numbers, hyphens before '(')
    const nameStart = i;
    while (i < trimmed.length && /[\w-]/.test(trimmed[i]!)) i++;
    const name = trimmed.slice(nameStart, i);

    // Skip whitespace before '('
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;

    // Expect '('
    if (trimmed[i] !== '(') {
      // Not a function, skip
      i++;
      continue;
    }

    // Find matching ')' using bracket depth
    const argsStart = i + 1;
    let depth = 1;
    i++;

    while (i < trimmed.length && depth > 0) {
      if (trimmed[i] === '(') depth++;
      else if (trimmed[i] === ')') depth--;
      i++;
    }

    const argsEnd = i - 1;
    const args = trimmed.slice(argsStart, argsEnd).trim();
    const original = trimmed.slice(nameStart, i);

    result.push({
      original,
      name: name.toLowerCase(),
      args,
    });
  }

  return result;
}

/**
 * Parse transform string into editable state.
 * Finds rotate, scaleX, scaleY positions while preserving all functions.
 */
function parseTransform(transform: string): TransformState {
  const functions = tokenizeTransform(transform);

  let rotateIndex = -1;
  let scaleXIndex = -1;
  let scaleYIndex = -1;

  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i]!;
    switch (fn.name) {
      case 'rotate':
        if (rotateIndex === -1) rotateIndex = i;
        break;
      case 'scalex':
        if (scaleXIndex === -1) scaleXIndex = i;
        break;
      case 'scaley':
        if (scaleYIndex === -1) scaleYIndex = i;
        break;
      // Note: We don't extract from scale(x,y) to avoid complexity
      // User can still have scale(2) and we preserve it
    }
  }

  return { functions, rotateIndex, scaleXIndex, scaleYIndex };
}

/**
 * Get rotate value from parsed state.
 */
function getRotateValue(state: TransformState): string {
  if (state.rotateIndex < 0) return '';
  return state.functions[state.rotateIndex]!.args;
}

/**
 * Get scaleX value from parsed state.
 */
function getScaleXValue(state: TransformState): number {
  if (state.scaleXIndex < 0) return 1;
  const val = parseFloat(state.functions[state.scaleXIndex]!.args);
  return isNaN(val) ? 1 : val;
}

/**
 * Get scaleY value from parsed state.
 */
function getScaleYValue(state: TransformState): number {
  if (state.scaleYIndex < 0) return 1;
  const val = parseFloat(state.functions[state.scaleYIndex]!.args);
  return isNaN(val) ? 1 : val;
}

/**
 * Check if element is horizontally flipped (scaleX === -1).
 */
function isFlippedX(state: TransformState): boolean {
  return getScaleXValue(state) === -1;
}

/**
 * Check if element is vertically flipped (scaleY === -1).
 */
function isFlippedY(state: TransformState): boolean {
  return getScaleYValue(state) === -1;
}

/**
 * Set rotate value in transform state (mutates functions array).
 * Adds rotate at end if not present, updates if present, removes if empty.
 */
function setRotateValue(state: TransformState, value: string): void {
  const rotateStr = value.trim();

  if (state.rotateIndex >= 0) {
    if (rotateStr) {
      // Update existing rotate
      state.functions[state.rotateIndex] = {
        original: `rotate(${rotateStr})`,
        name: 'rotate',
        args: rotateStr,
      };
    } else {
      // Remove rotate
      state.functions.splice(state.rotateIndex, 1);
      // Adjust indices
      if (state.scaleXIndex > state.rotateIndex) state.scaleXIndex--;
      if (state.scaleYIndex > state.rotateIndex) state.scaleYIndex--;
      state.rotateIndex = -1;
    }
  } else if (rotateStr) {
    // Add new rotate at end
    state.rotateIndex = state.functions.length;
    state.functions.push({
      original: `rotate(${rotateStr})`,
      name: 'rotate',
      args: rotateStr,
    });
  }
}

/**
 * Toggle flip X in transform state.
 * If currently -1, removes scaleX. Otherwise sets to -1.
 */
function toggleFlipX(state: TransformState): void {
  const currentVal = getScaleXValue(state);

  if (currentVal === -1) {
    // Remove scaleX(-1)
    if (state.scaleXIndex >= 0) {
      state.functions.splice(state.scaleXIndex, 1);
      // Adjust indices
      if (state.rotateIndex > state.scaleXIndex) state.rotateIndex--;
      if (state.scaleYIndex > state.scaleXIndex) state.scaleYIndex--;
      state.scaleXIndex = -1;
    }
  } else if (state.scaleXIndex >= 0) {
    // Update existing scaleX to -1
    state.functions[state.scaleXIndex] = {
      original: 'scaleX(-1)',
      name: 'scalex',
      args: '-1',
    };
  } else {
    // Add new scaleX(-1) at end
    state.scaleXIndex = state.functions.length;
    state.functions.push({
      original: 'scaleX(-1)',
      name: 'scalex',
      args: '-1',
    });
  }
}

/**
 * Toggle flip Y in transform state.
 * If currently -1, removes scaleY. Otherwise sets to -1.
 */
function toggleFlipY(state: TransformState): void {
  const currentVal = getScaleYValue(state);

  if (currentVal === -1) {
    // Remove scaleY(-1)
    if (state.scaleYIndex >= 0) {
      state.functions.splice(state.scaleYIndex, 1);
      // Adjust indices
      if (state.rotateIndex > state.scaleYIndex) state.rotateIndex--;
      if (state.scaleXIndex > state.scaleYIndex) state.scaleXIndex--;
      state.scaleYIndex = -1;
    }
  } else if (state.scaleYIndex >= 0) {
    // Update existing scaleY to -1
    state.functions[state.scaleYIndex] = {
      original: 'scaleY(-1)',
      name: 'scaley',
      args: '-1',
    };
  } else {
    // Add new scaleY(-1) at end
    state.scaleYIndex = state.functions.length;
    state.functions.push({
      original: 'scaleY(-1)',
      name: 'scaley',
      args: '-1',
    });
  }
}

/**
 * Compose transform string from state, preserving order.
 */
function composeTransform(state: TransformState): string {
  return state.functions
    .map((fn) => fn.original)
    .join(' ')
    .trim();
}

/**
 * Extract numeric value from rotate angle (e.g., "45deg" -> "45")
 */
function extractRotateValue(rotate: string): string {
  if (!rotate) return '';
  const match = rotate.match(/^(-?[\d.]+)/);
  return match ? match[1]! : '';
}

/**
 * Extract unit from rotate angle (e.g., "45deg" -> "deg")
 */
function extractRotateUnit(rotate: string): string {
  if (!rotate) return 'deg';
  const match = rotate.match(/[\d.]+(.*)$/);
  return match && match[1] ? match[1] : 'deg';
}

// =============================================================================
// SVG Icon Helpers
// =============================================================================

function createPositionIcon(position: PositionValue): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1');
  path.setAttribute('d', POSITION_ICON_PATHS[position]);
  svg.append(path);

  return svg;
}

function createRotateIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  // Circular arrow icon
  path.setAttribute('d', 'M12 7.5a4.5 4.5 0 1 1-1.5-3.4M12 3v3h-3');
  svg.append(path);

  return svg;
}

function createFlipXIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  // Horizontal flip arrows
  path.setAttribute('d', 'M4 4L1 7.5L4 11M11 4l3 3.5L11 11M7.5 2v11');
  svg.append(path);

  return svg;
}

function createFlipYIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  // Vertical flip arrows
  path.setAttribute('d', 'M4 4L7.5 1L11 4M4 11l3.5 3L11 11M2 7.5h11');
  svg.append(path);

  return svg;
}

// =============================================================================
// Helpers
// =============================================================================

function isFieldFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode.activeElement === el;
    }
    return document.activeElement === el;
  } catch {
    return false;
  }
}

function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    if (!style || typeof style.getPropertyValue !== 'function') return '';
    return style.getPropertyValue(property).trim();
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

function normalizeZIndex(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^-?\d+\.$/.test(trimmed)) return trimmed.slice(0, -1);
  return trimmed;
}

function isPositionValue(value: string): value is PositionValue {
  return (POSITION_VALUES as readonly string[]).includes(value);
}

// =============================================================================
// Field State Types
// =============================================================================

interface IconButtonGroupFieldState {
  kind: 'icon-button-group';
  property: 'position';
  group: IconButtonGroup<PositionValue>;
  handle: StyleTransactionHandle | null;
}

interface InputFieldState {
  kind: 'input';
  property: 'left' | 'top' | 'z-index';
  input: HTMLInputElement;
  container: InputContainer;
  handle: StyleTransactionHandle | null;
}

interface TransformFieldState {
  kind: 'transform';
  rotateInput: HTMLInputElement;
  rotateContainer: InputContainer;
  flipXBtn: HTMLButtonElement;
  flipYBtn: HTMLButtonElement;
  handle: StyleTransactionHandle | null;
  /** Cached transform state for editing */
  cached: TransformState;
}

type FieldState = IconButtonGroupFieldState | InputFieldState | TransformFieldState;

// =============================================================================
// Factory
// =============================================================================

export interface PositionControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
}

export function createPositionControl(options: PositionControlOptions): DesignControl {
  const { container, transactionManager } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ---------------------------------------------------------------------------
  // Position Row (icon button group)
  // ---------------------------------------------------------------------------
  const positionRow = document.createElement('div');
  positionRow.className = 'we-field';

  const positionLabel = document.createElement('span');
  positionLabel.className = 'we-field-label';
  positionLabel.textContent = 'Position';

  const positionMount = document.createElement('div');
  positionMount.className = 'we-field-content';

  positionRow.append(positionLabel, positionMount);

  const positionGroup = createIconButtonGroup<PositionValue>({
    container: positionMount,
    ariaLabel: 'Position type',
    columns: 5,
    items: POSITION_VALUES.map((pos) => ({
      value: pos,
      ariaLabel: pos,
      title: pos,
      icon: createPositionIcon(pos),
    })),
    onChange: (value) => {
      const handle = beginStyleTransaction('position');
      if (handle) handle.set(value);
      commitStyleTransaction('position');
      syncAllFields();
    },
  });
  disposer.add(() => positionGroup.dispose());

  // ---------------------------------------------------------------------------
  // X / Y row (left / top)
  // ---------------------------------------------------------------------------
  const xyRow = document.createElement('div');
  xyRow.className = 'we-field-row';

  const xContainer = createInputContainer({
    ariaLabel: 'X (Left)',
    inputMode: 'decimal',
    prefix: 'X',
    suffix: 'px',
  });

  const yContainer = createInputContainer({
    ariaLabel: 'Y (Top)',
    inputMode: 'decimal',
    prefix: 'Y',
    suffix: 'px',
  });

  xyRow.append(xContainer.root, yContainer.root);

  wireNumberStepping(disposer, xContainer.input, { mode: 'css-length' });
  wireNumberStepping(disposer, yContainer.input, { mode: 'css-length' });

  // ---------------------------------------------------------------------------
  // Z row (z-index)
  // ---------------------------------------------------------------------------
  const zRow = document.createElement('div');
  zRow.className = 'we-field';

  const zLabel = document.createElement('span');
  zLabel.className = 'we-field-label';
  zLabel.textContent = 'Z-Index';

  const zContainer = createInputContainer({
    ariaLabel: 'Z-Index',
    inputMode: 'numeric',
    prefix: 'Z',
    suffix: null,
  });

  zRow.append(zLabel, zContainer.root);

  wireNumberStepping(disposer, zContainer.input, { mode: 'number', integer: true });

  // ---------------------------------------------------------------------------
  // Rotate + Flip row (transform)
  // ---------------------------------------------------------------------------
  const transformRow = document.createElement('div');
  transformRow.className = 'we-field';

  const transformLabel = document.createElement('span');
  transformLabel.className = 'we-field-label';
  transformLabel.textContent = 'Rotate';

  const transformContent = document.createElement('div');
  transformContent.className = 'we-field-content';
  transformContent.style.display = 'flex';
  transformContent.style.gap = '4px';
  transformContent.style.alignItems = 'center';

  const rotateContainer = createInputContainer({
    ariaLabel: 'Rotate',
    inputMode: 'decimal',
    prefix: createRotateIcon(),
    suffix: 'deg',
  });
  rotateContainer.root.style.flex = '1';

  wireNumberStepping(disposer, rotateContainer.input, { mode: 'number', step: 1, shiftStep: 15 });

  // Flip X button
  const flipXBtn = document.createElement('button');
  flipXBtn.type = 'button';
  flipXBtn.className = 'we-toggle-btn';
  flipXBtn.setAttribute('aria-label', 'Flip horizontal');
  flipXBtn.setAttribute('aria-pressed', 'false');
  flipXBtn.dataset.tooltip = 'Flip horizontal';
  flipXBtn.append(createFlipXIcon());

  // Flip Y button
  const flipYBtn = document.createElement('button');
  flipYBtn.type = 'button';
  flipYBtn.className = 'we-toggle-btn';
  flipYBtn.setAttribute('aria-label', 'Flip vertical');
  flipYBtn.setAttribute('aria-pressed', 'false');
  flipYBtn.dataset.tooltip = 'Flip vertical';
  flipYBtn.append(createFlipYIcon());

  transformContent.append(rotateContainer.root, flipXBtn, flipYBtn);
  transformRow.append(transformLabel, transformContent);

  // ---------------------------------------------------------------------------
  // Assemble DOM
  // ---------------------------------------------------------------------------
  root.append(positionRow, xyRow, zRow, transformRow);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Field State Registry
  // ==========================================================================

  const fields: Record<FieldKey, FieldState> = {
    position: {
      kind: 'icon-button-group',
      property: 'position',
      group: positionGroup,
      handle: null,
    },
    left: {
      kind: 'input',
      property: 'left',
      input: xContainer.input,
      container: xContainer,
      handle: null,
    },
    top: {
      kind: 'input',
      property: 'top',
      input: yContainer.input,
      container: yContainer,
      handle: null,
    },
    'z-index': {
      kind: 'input',
      property: 'z-index',
      input: zContainer.input,
      container: zContainer,
      handle: null,
    },
    transform: {
      kind: 'transform',
      rotateInput: rotateContainer.input,
      rotateContainer: rotateContainer,
      flipXBtn,
      flipYBtn,
      handle: null,
      cached: { functions: [], rotateIndex: -1, scaleXIndex: -1, scaleYIndex: -1 },
    },
  };

  const STYLE_PROPERTIES: readonly StyleProperty[] = ['position', 'left', 'top', 'z-index'];
  const FIELD_KEYS: readonly FieldKey[] = ['position', 'left', 'top', 'z-index', 'transform'];

  // ==========================================================================
  // Transaction Management
  // ==========================================================================

  function beginStyleTransaction(property: StyleProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.kind === 'transform') return null;
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitStyleTransaction(property: StyleProperty): void {
    const field = fields[property];
    if (field.kind === 'transform') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackStyleTransaction(property: StyleProperty): void {
    const field = fields[property];
    if (field.kind === 'transform') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function beginTransformTransaction(): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields.transform as TransformFieldState;
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, 'transform');
    field.handle = handle;

    // Cache current transform components
    const currentTransform =
      readInlineValue(target, 'transform') || readComputedValue(target, 'transform');
    field.cached = parseTransform(currentTransform);

    return handle;
  }

  function commitTransformTransaction(): void {
    const field = fields.transform as TransformFieldState;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransformTransaction(): void {
    const field = fields.transform as TransformFieldState;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of STYLE_PROPERTIES) commitStyleTransaction(p);
    commitTransformTransaction();
  }

  // ==========================================================================
  // Field Synchronization
  // ==========================================================================

  function syncField(key: FieldKey, force = false): void {
    const field = fields[key];
    const target = currentTarget;

    // Handle icon button group (position)
    if (field.kind === 'icon-button-group') {
      const group = field.group;

      if (!target || !target.isConnected) {
        group.setDisabled(true);
        group.setValue(null);
        return;
      }

      group.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const inline = readInlineValue(target, 'position');
      const computed = readComputedValue(target, 'position');
      const raw = (inline || computed).trim();
      group.setValue(isPositionValue(raw) ? raw : 'static');
      return;
    }

    // Handle input field (left, top, z-index)
    if (field.kind === 'input') {
      const input = field.input;

      if (!target || !target.isConnected) {
        input.disabled = true;
        input.value = '';
        input.placeholder = '';
        // Reset suffix to default
        if (field.property === 'z-index') {
          field.container.setSuffix(null);
        } else {
          field.container.setSuffix('px');
        }
        return;
      }

      input.disabled = false;
      const isEditing = field.handle !== null || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, field.property);
      const displayValue = inlineValue || readComputedValue(target, field.property);

      // z-index is unitless
      if (field.property === 'z-index') {
        input.value = displayValue;
        field.container.setSuffix(null);
      } else {
        const formatted = formatLengthForDisplay(displayValue);
        input.value = formatted.value;
        field.container.setSuffix(formatted.suffix);
      }
      input.placeholder = '';
      return;
    }

    // Handle transform field (rotate + flip)
    if (field.kind === 'transform') {
      const { rotateInput, rotateContainer, flipXBtn, flipYBtn } = field;

      if (!target || !target.isConnected) {
        rotateInput.disabled = true;
        rotateInput.value = '';
        rotateInput.placeholder = '';
        rotateContainer.setSuffix('deg');
        flipXBtn.disabled = true;
        flipYBtn.disabled = true;
        flipXBtn.setAttribute('aria-pressed', 'false');
        flipYBtn.setAttribute('aria-pressed', 'false');
        return;
      }

      rotateInput.disabled = false;
      flipXBtn.disabled = false;
      flipYBtn.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(rotateInput);
      if (isEditing && !force) return;

      const transformValue =
        readInlineValue(target, 'transform') || readComputedValue(target, 'transform');
      const state = parseTransform(transformValue);

      // Update rotate input
      const rotateArgs = getRotateValue(state);
      const rotateValue = extractRotateValue(rotateArgs);
      const rotateUnit = extractRotateUnit(rotateArgs);
      rotateInput.value = rotateValue;
      rotateContainer.setSuffix(rotateUnit || 'deg');

      // Update flip buttons
      flipXBtn.setAttribute('aria-pressed', isFlippedX(state) ? 'true' : 'false');
      flipYBtn.setAttribute('aria-pressed', isFlippedY(state) ? 'true' : 'false');
    }
  }

  function syncAllFields(): void {
    for (const key of FIELD_KEYS) syncField(key);
  }

  // ==========================================================================
  // Event Wiring - Style Inputs
  // ==========================================================================

  function wireStyleInput(property: 'left' | 'top' | 'z-index'): void {
    const field = fields[property] as InputFieldState;
    const input = field.input;

    disposer.listen(input, 'input', () => {
      const handle = beginStyleTransaction(property);
      if (!handle) return;

      if (property === 'z-index') {
        handle.set(normalizeZIndex(input.value));
      } else {
        const suffix = field.container.getSuffixText();
        handle.set(combineLengthValue(input.value, suffix));
      }
    });

    disposer.listen(input, 'blur', () => {
      commitStyleTransaction(property);
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitStyleTransaction(property);
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackStyleTransaction(property);
        syncField(property, true);
      }
    });
  }

  wireStyleInput('left');
  wireStyleInput('top');
  wireStyleInput('z-index');

  // ==========================================================================
  // Event Wiring - Transform
  // ==========================================================================

  const transformField = fields.transform as TransformFieldState;

  // Rotate input
  disposer.listen(transformField.rotateInput, 'input', () => {
    const handle = beginTransformTransaction();
    if (!handle) return;

    const value = transformField.rotateInput.value.trim();
    const unit = transformField.rotateContainer.getSuffixText() || 'deg';
    const rotateStr = value ? `${value}${unit}` : '';

    setRotateValue(transformField.cached, rotateStr);
    handle.set(composeTransform(transformField.cached));
  });

  disposer.listen(transformField.rotateInput, 'blur', () => {
    commitTransformTransaction();
    syncAllFields();
  });

  disposer.listen(transformField.rotateInput, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTransformTransaction();
      syncAllFields();
      transformField.rotateInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      rollbackTransformTransaction();
      syncField('transform', true);
    }
  });

  // Flip X button
  disposer.listen(transformField.flipXBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    const handle = beginTransformTransaction();
    if (!handle) return;

    toggleFlipX(transformField.cached);
    handle.set(composeTransform(transformField.cached));
    commitTransformTransaction();
    syncAllFields();
  });

  // Flip Y button
  disposer.listen(transformField.flipYBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    const handle = beginTransformTransaction();
    if (!handle) return;

    toggleFlipY(transformField.cached);
    handle.set(composeTransform(transformField.cached));
    commitTransformTransaction();
    syncAllFields();
  });

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) {
      commitAllTransactions();
    }
    currentTarget = element;
    syncAllFields();
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

  syncAllFields();

  return { setTarget, refresh, dispose };
}

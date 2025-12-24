/**
 * Appearance Control (Phase 3.8 - Refactored)
 *
 * Edits inline appearance styles with grouped sections:
 *
 * General:
 * - overflow (select)
 * - box-sizing (select)
 * - opacity (input)
 *
 * Border (grouped):
 * - edge selector (all/top/right/bottom/left)
 * - border-width (input)
 * - border-style (select: solid/dashed/dotted/none)
 * - border-color (color picker)
 * - border-radius (input)
 *
 * Background (grouped):
 * - type selector (solid/gradient/image)
 * - solid: background-color picker
 * - gradient: gradient editor (reuses gradient-control.ts)
 * - image: background-image URL input
 */

import { Disposer } from '../../../utils/disposables';
import type {
  MultiStyleTransactionHandle,
  StyleTransactionHandle,
  TransactionManager,
} from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createIconButtonGroup, type IconButtonGroup } from '../components/icon-button-group';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createColorField, type ColorField } from './color-field';
import { createGradientControl } from './gradient-control';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

const OVERFLOW_VALUES = ['visible', 'hidden', 'scroll', 'auto'] as const;
const BOX_SIZING_VALUES = ['content-box', 'border-box'] as const;
const BORDER_STYLE_VALUES = ['solid', 'dashed', 'dotted', 'none'] as const;

const BORDER_EDGE_VALUES = ['all', 'top', 'right', 'bottom', 'left'] as const;
type BorderEdge = (typeof BORDER_EDGE_VALUES)[number];

const BACKGROUND_TYPE_VALUES = ['solid', 'gradient', 'image'] as const;
type BackgroundType = (typeof BACKGROUND_TYPE_VALUES)[number];

// Border radius corner properties
const BORDER_RADIUS_CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
type BorderRadiusCorner = (typeof BORDER_RADIUS_CORNERS)[number];

const BORDER_RADIUS_CORNER_PROPERTIES: Record<BorderRadiusCorner, string> = {
  'top-left': 'border-top-left-radius',
  'top-right': 'border-top-right-radius',
  'bottom-right': 'border-bottom-right-radius',
  'bottom-left': 'border-bottom-left-radius',
};

const BORDER_RADIUS_TRANSACTION_PROPERTIES = [
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

// =============================================================================
// Types
// =============================================================================

/** Standard CSS properties managed by this control */
type AppearanceProperty =
  | 'overflow'
  | 'box-sizing'
  | 'opacity'
  | 'border-radius'
  | 'border-width'
  | 'border-style'
  | 'border-color'
  | 'background-color'
  | 'background-image';

/** Text input field state */
interface TextFieldState {
  kind: 'text';
  property: AppearanceProperty;
  element: HTMLInputElement;
  handle: StyleTransactionHandle | null;
}

/** Select field state */
interface SelectFieldState {
  kind: 'select';
  property: AppearanceProperty;
  element: HTMLSelectElement;
  handle: StyleTransactionHandle | null;
}

/** Color field state */
interface ColorFieldState {
  kind: 'color';
  property: AppearanceProperty;
  field: ColorField;
  handle: StyleTransactionHandle | null;
}

/** Border radius field state (unified + per-corner inputs) */
interface BorderRadiusFieldState {
  kind: 'border-radius';
  property: 'border-radius';
  root: HTMLDivElement;
  unified: InputContainer;
  toggleButton: HTMLButtonElement;
  cornersGrid: HTMLDivElement;
  corners: Record<BorderRadiusCorner, InputContainer>;
  handle: MultiStyleTransactionHandle | null;
  expanded: boolean;
  mode: 'unified' | 'corners' | null;
  cornersMaterialized: boolean;
}

type FieldState = TextFieldState | SelectFieldState | ColorFieldState | BorderRadiusFieldState;

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

function normalizeLength(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return `${trimmed}px`;
  if (/^-?\d+\.$/.test(trimmed)) return `${trimmed.slice(0, -1)}px`;
  return trimmed;
}

function normalizeOpacity(raw: string): string {
  return raw.trim();
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

/**
 * Create SVG icon for border edge selector
 */
function createBorderEdgeIcon(edge: BorderEdge): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  // Base outline (dimmed)
  const outline = document.createElementNS(SVG_NS, 'rect');
  outline.setAttribute('x', '3.5');
  outline.setAttribute('y', '3.5');
  outline.setAttribute('width', '8');
  outline.setAttribute('height', '8');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '1');
  outline.setAttribute('opacity', '0.4');
  svg.appendChild(outline);

  // Highlighted edge
  const highlight = document.createElementNS(SVG_NS, 'path');
  highlight.setAttribute('stroke', 'currentColor');
  highlight.setAttribute('stroke-width', '2');
  highlight.setAttribute('stroke-linecap', 'round');

  switch (edge) {
    case 'all':
      highlight.setAttribute('d', 'M3.5 3.5h8v8h-8z');
      break;
    case 'top':
      highlight.setAttribute('d', 'M3.5 3.5h8');
      break;
    case 'right':
      highlight.setAttribute('d', 'M11.5 3.5v8');
      break;
    case 'bottom':
      highlight.setAttribute('d', 'M3.5 11.5h8');
      break;
    case 'left':
      highlight.setAttribute('d', 'M3.5 3.5v8');
      break;
  }

  svg.appendChild(highlight);
  return svg;
}

/**
 * Create SVG icon for edit corners button
 */
function createEditCornersIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'M4 6V4H6 M9 4H11V6 M11 9V11H9 M6 11H4V9');
  svg.appendChild(path);

  return svg;
}

/**
 * Create SVG icon for specific corner
 */
function createCornerIcon(corner: BorderRadiusCorner): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  switch (corner) {
    case 'top-left':
      path.setAttribute('d', 'M11 4H6Q4 4 4 6V11');
      break;
    case 'top-right':
      path.setAttribute('d', 'M4 4H9Q11 4 11 6V11');
      break;
    case 'bottom-right':
      path.setAttribute('d', 'M11 4V9Q11 11 9 11H4');
      break;
    case 'bottom-left':
      path.setAttribute('d', 'M4 4V9Q4 11 6 11H11');
      break;
  }

  svg.appendChild(path);
  return svg;
}

/**
 * Infer background type from background-image CSS value
 */
function inferBackgroundType(bgImage: string): BackgroundType {
  const trimmed = bgImage.trim().toLowerCase();
  if (!trimmed || trimmed === 'none') return 'solid';
  if (/\b(?:linear|radial|conic)-gradient\s*\(/i.test(trimmed)) return 'gradient';
  if (/\burl\s*\(/i.test(trimmed)) return 'image';
  return 'solid';
}

/**
 * Extract URL from background-image: url("...") value
 */
function extractUrlFromBackgroundImage(raw: string): string {
  const match = raw.trim().match(/\burl\(\s*(['"]?)(.*?)\1\s*\)/i);
  return match?.[2]?.trim() ?? '';
}

/**
 * Normalize user input to background-image: url("...") format
 */
function normalizeBackgroundImageUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^none$/i.test(trimmed)) return 'none';
  if (/^url\s*\(/i.test(trimmed)) return trimmed;
  // Escape special characters
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
}

// =============================================================================
// Factory
// =============================================================================

export interface AppearanceControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
}

export function createAppearanceControl(options: AppearanceControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentBorderEdge: BorderEdge = 'all';
  let currentBackgroundType: BackgroundType = 'solid';

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ===========================================================================
  // DOM Helpers
  // ===========================================================================

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
    input.setAttribute('aria-label', ariaLabel);
    row.append(label, input);
    return { row, input };
  }

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly string[],
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
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
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

  function createSection(title: string): HTMLDivElement {
    const section = document.createElement('div');
    section.className = 'we-spacing-section';
    const header = document.createElement('div');
    header.className = 'we-spacing-header';
    header.textContent = title;
    section.appendChild(header);
    return section;
  }

  // ===========================================================================
  // General Section
  // ===========================================================================

  const { row: overflowRow, select: overflowSelect } = createSelectRow(
    'Overflow',
    'Overflow',
    OVERFLOW_VALUES,
  );
  const { row: boxSizingRow, select: boxSizingSelect } = createSelectRow(
    'Box Size',
    'Box Sizing',
    BOX_SIZING_VALUES,
  );
  const { row: opacityRow, input: opacityInput } = createInputRow('Opacity', 'Opacity');

  wireNumberStepping(disposer, opacityInput, {
    mode: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    shiftStep: 0.1,
    altStep: 0.001,
  });

  // ===========================================================================
  // Border Section
  // ===========================================================================

  const borderSection = createSection('Border');

  // Edge selector row
  const borderEdgeRow = document.createElement('div');
  borderEdgeRow.className = 'we-field';
  const borderEdgeLabel = document.createElement('span');
  borderEdgeLabel.className = 'we-field-label';
  borderEdgeLabel.textContent = 'Edge';
  const borderEdgeMount = document.createElement('div');
  borderEdgeMount.style.flex = '1';
  borderEdgeRow.append(borderEdgeLabel, borderEdgeMount);

  const { row: borderWidthRow, input: borderWidthInput } = createInputRow('Width', 'Border Width');
  const { row: borderStyleRow, select: borderStyleSelect } = createSelectRow(
    'Style',
    'Border Style',
    BORDER_STYLE_VALUES,
  );
  const { row: borderColorRow, colorFieldContainer: borderColorContainer } =
    createColorRow('Color');

  // ---------------------------------------------------------------------------
  // Border Radius (unified + per-corner editing)
  // ---------------------------------------------------------------------------
  const borderRadiusRow = document.createElement('div');
  borderRadiusRow.className = 'we-field';

  const borderRadiusLabel = document.createElement('span');
  borderRadiusLabel.className = 'we-field-label';
  borderRadiusLabel.textContent = 'Radius';

  const borderRadiusControl = document.createElement('div');
  borderRadiusControl.className = 'we-radius-control';

  // Unified row (input + toggle button)
  const borderRadiusUnifiedRow = document.createElement('div');
  borderRadiusUnifiedRow.className = 'we-field-row';

  const borderRadiusUnified = createInputContainer({
    ariaLabel: 'Border Radius',
    inputMode: 'decimal',
    prefix: null,
    suffix: 'px',
  });
  borderRadiusUnified.root.style.flex = '1';

  const borderRadiusToggleButton = document.createElement('button');
  borderRadiusToggleButton.type = 'button';
  borderRadiusToggleButton.className = 'we-toggle-btn';
  borderRadiusToggleButton.setAttribute('aria-label', 'Edit corners');
  borderRadiusToggleButton.setAttribute('aria-pressed', 'false');
  borderRadiusToggleButton.dataset.tooltip = 'Edit corners';
  borderRadiusToggleButton.append(createEditCornersIcon());

  borderRadiusUnifiedRow.append(borderRadiusUnified.root, borderRadiusToggleButton);

  // Corners grid (2x2 layout)
  const borderRadiusCornersGrid = document.createElement('div');
  borderRadiusCornersGrid.className = 'we-radius-corners-grid';
  borderRadiusCornersGrid.hidden = true;

  const borderRadiusCorners: Record<BorderRadiusCorner, InputContainer> = {
    'top-left': createInputContainer({
      ariaLabel: 'Top-left radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('top-left'),
      suffix: 'px',
    }),
    'top-right': createInputContainer({
      ariaLabel: 'Top-right radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('top-right'),
      suffix: 'px',
    }),
    'bottom-left': createInputContainer({
      ariaLabel: 'Bottom-left radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('bottom-left'),
      suffix: 'px',
    }),
    'bottom-right': createInputContainer({
      ariaLabel: 'Bottom-right radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('bottom-right'),
      suffix: 'px',
    }),
  };

  // 2x2 layout matching visual corner positions
  borderRadiusCornersGrid.append(
    borderRadiusCorners['top-left'].root,
    borderRadiusCorners['top-right'].root,
    borderRadiusCorners['bottom-left'].root,
    borderRadiusCorners['bottom-right'].root,
  );

  borderRadiusControl.append(borderRadiusUnifiedRow, borderRadiusCornersGrid);
  borderRadiusRow.append(borderRadiusLabel, borderRadiusControl);

  // Create field state
  const borderRadiusField: BorderRadiusFieldState = {
    kind: 'border-radius',
    property: 'border-radius',
    root: borderRadiusRow,
    unified: borderRadiusUnified,
    toggleButton: borderRadiusToggleButton,
    cornersGrid: borderRadiusCornersGrid,
    corners: borderRadiusCorners,
    handle: null,
    expanded: false,
    mode: null,
    cornersMaterialized: false,
  };

  wireNumberStepping(disposer, borderWidthInput, { mode: 'css-length' });
  wireNumberStepping(disposer, borderRadiusUnified.input, { mode: 'css-length' });
  for (const corner of BORDER_RADIUS_CORNERS) {
    wireNumberStepping(disposer, borderRadiusCorners[corner].input, { mode: 'css-length' });
  }

  borderSection.append(
    borderEdgeRow,
    borderWidthRow,
    borderStyleRow,
    borderColorRow,
    borderRadiusRow,
  );

  // ===========================================================================
  // Background Section
  // ===========================================================================

  const backgroundSection = createSection('Background');

  // Type selector
  const bgTypeRow = document.createElement('div');
  bgTypeRow.className = 'we-field';
  const bgTypeLabel = document.createElement('span');
  bgTypeLabel.className = 'we-field-label';
  bgTypeLabel.textContent = 'Type';
  const bgTypeSelect = document.createElement('select');
  bgTypeSelect.className = 'we-select';
  bgTypeSelect.setAttribute('aria-label', 'Background Type');
  for (const v of BACKGROUND_TYPE_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
    bgTypeSelect.appendChild(opt);
  }
  bgTypeRow.append(bgTypeLabel, bgTypeSelect);

  // Solid color row
  const { row: bgColorRow, colorFieldContainer: bgColorContainer } = createColorRow('Color');

  // Gradient mount
  const bgGradientMount = document.createElement('div');

  // Image URL row
  const { row: bgImageRow, input: bgImageInput } = createInputRow('URL', 'Background Image URL');
  bgImageInput.placeholder = 'https://...';
  bgImageInput.spellcheck = false;

  backgroundSection.append(bgTypeRow, bgColorRow, bgGradientMount, bgImageRow);

  // ===========================================================================
  // Assemble DOM
  // ===========================================================================

  root.append(overflowRow, boxSizingRow, opacityRow, borderSection, backgroundSection);
  container.appendChild(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Border Edge Selector
  // ===========================================================================

  const borderEdgeGroup = createIconButtonGroup<BorderEdge>({
    container: borderEdgeMount,
    ariaLabel: 'Border edge',
    columns: 5,
    value: currentBorderEdge,
    items: BORDER_EDGE_VALUES.map((edge) => ({
      value: edge,
      ariaLabel: edge,
      title: edge.charAt(0).toUpperCase() + edge.slice(1),
      icon: createBorderEdgeIcon(edge),
    })),
    onChange: (edge) => {
      if (edge === currentBorderEdge) return;
      // Commit current edge transactions before switching
      commitTransaction('border-width');
      commitTransaction('border-style');
      commitTransaction('border-color');
      currentBorderEdge = edge;
      syncAllFields();
    },
  });
  disposer.add(() => borderEdgeGroup.dispose());

  // ===========================================================================
  // Gradient Control
  // ===========================================================================

  const gradientControl = createGradientControl({
    container: bgGradientMount,
    transactionManager,
    tokensService,
  });
  disposer.add(() => gradientControl.dispose());

  // ===========================================================================
  // Color Fields
  // ===========================================================================

  const borderColorField = createColorField({
    container: borderColorContainer,
    ariaLabel: 'Border Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const handle = beginTransaction('border-color');
      if (handle) handle.set(value);
    },
    onCommit: () => {
      commitTransaction('border-color');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('border-color');
      syncField('border-color', true);
    },
  });
  disposer.add(() => borderColorField.dispose());

  const bgColorField = createColorField({
    container: bgColorContainer,
    ariaLabel: 'Background Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const handle = beginTransaction('background-color');
      if (handle) handle.set(value);
    },
    onCommit: () => {
      commitTransaction('background-color');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('background-color');
      syncField('background-color', true);
    },
  });
  disposer.add(() => bgColorField.dispose());

  // ===========================================================================
  // Field State Map
  // ===========================================================================

  const fields: Record<AppearanceProperty, FieldState> = {
    overflow: { kind: 'select', property: 'overflow', element: overflowSelect, handle: null },
    'box-sizing': {
      kind: 'select',
      property: 'box-sizing',
      element: boxSizingSelect,
      handle: null,
    },
    opacity: { kind: 'text', property: 'opacity', element: opacityInput, handle: null },
    'border-radius': borderRadiusField,
    'border-width': {
      kind: 'text',
      property: 'border-width',
      element: borderWidthInput,
      handle: null,
    },
    'border-style': {
      kind: 'select',
      property: 'border-style',
      element: borderStyleSelect,
      handle: null,
    },
    'border-color': {
      kind: 'color',
      property: 'border-color',
      field: borderColorField,
      handle: null,
    },
    'background-color': {
      kind: 'color',
      property: 'background-color',
      field: bgColorField,
      handle: null,
    },
    'background-image': {
      kind: 'text',
      property: 'background-image',
      element: bgImageInput,
      handle: null,
    },
  };

  const PROPS: readonly AppearanceProperty[] = [
    'overflow',
    'box-sizing',
    'opacity',
    'border-radius',
    'border-width',
    'border-style',
    'border-color',
    'background-color',
    'background-image',
  ];

  // ===========================================================================
  // CSS Property Resolution (handles border edge selection)
  // ===========================================================================

  function resolveBorderProperty(kind: 'width' | 'style' | 'color'): string {
    if (currentBorderEdge === 'all') return `border-${kind}`;
    return `border-${currentBorderEdge}-${kind}`;
  }

  function resolveCssProperty(property: AppearanceProperty): string {
    if (property === 'border-width') return resolveBorderProperty('width');
    if (property === 'border-style') return resolveBorderProperty('style');
    if (property === 'border-color') return resolveBorderProperty('color');
    return property;
  }

  // ===========================================================================
  // Transaction Management
  // ===========================================================================

  function beginTransaction(property: AppearanceProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    // Border-radius uses multi-style transaction
    if (field.kind === 'border-radius') return null;
    if (field.handle) return field.handle;

    const cssProperty = resolveCssProperty(property);
    const handle = transactionManager.beginStyle(target, cssProperty);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: AppearanceProperty): void {
    const field = fields[property];
    // Border-radius uses separate commit function
    if (field.kind === 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: AppearanceProperty): void {
    const field = fields[property];
    // Border-radius uses separate rollback function
    if (field.kind === 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  // Border-radius multi-style transaction helpers
  function beginBorderRadiusTransaction(): MultiStyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    if (field.handle) return field.handle;

    const handle = transactionManager.beginMultiStyle(target, [
      ...BORDER_RADIUS_TRANSACTION_PROPERTIES,
    ]);
    field.handle = handle;
    field.mode = null;
    field.cornersMaterialized = false;
    return handle;
  }

  function commitBorderRadiusTransaction(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    field.mode = null;
    field.cornersMaterialized = false;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackBorderRadiusTransaction(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    field.mode = null;
    field.cornersMaterialized = false;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of PROPS) commitTransaction(p);
    commitBorderRadiusTransaction();
  }

  // ===========================================================================
  // Background Type Visibility
  // ===========================================================================

  function updateBackgroundVisibility(): void {
    bgColorRow.hidden = currentBackgroundType !== 'solid';
    bgGradientMount.hidden = currentBackgroundType !== 'gradient';
    bgImageRow.hidden = currentBackgroundType !== 'image';
  }

  function setBackgroundType(type: BackgroundType): void {
    const target = currentTarget;
    currentBackgroundType = type;
    bgTypeSelect.value = type;
    updateBackgroundVisibility();

    if (!target || !target.isConnected) return;

    // Clear conflicting background-image when switching to solid
    if (type === 'solid') {
      // Commit any pending background-image transaction first
      commitTransaction('background-image');
      // Then clear background-image
      const handle = transactionManager.beginStyle(target, 'background-image');
      if (handle) {
        handle.set('none');
        handle.commit({ merge: true });
      }
    }
  }

  // Background type change handler
  disposer.listen(bgTypeSelect, 'change', () => {
    const type = bgTypeSelect.value as BackgroundType;
    setBackgroundType(type);
    gradientControl.refresh();
    syncAllFields();
  });

  // ===========================================================================
  // Field Synchronization
  // ===========================================================================

  function syncField(property: AppearanceProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;
    const cssProperty = resolveCssProperty(property);

    // Handle border-radius field (unified + per-corner)
    if (field.kind === 'border-radius') {
      const hasTarget = Boolean(target && target.isConnected);

      field.unified.input.disabled = !hasTarget;
      field.toggleButton.disabled = !hasTarget;
      for (const corner of BORDER_RADIUS_CORNERS) {
        field.corners[corner].input.disabled = !hasTarget;
      }

      if (!hasTarget || !target) {
        field.unified.input.value = '';
        field.unified.input.placeholder = '';
        field.unified.setSuffix('px');
        for (const corner of BORDER_RADIUS_CORNERS) {
          field.corners[corner].input.value = '';
          field.corners[corner].input.placeholder = '';
          field.corners[corner].setSuffix('px');
        }
        return;
      }

      const isCornerFocused = BORDER_RADIUS_CORNERS.some((c) =>
        isFieldFocused(field.corners[c].input),
      );
      const isEditing =
        field.handle !== null || isFieldFocused(field.unified.input) || isCornerFocused;
      if (isEditing && !force) return;

      // Unified value
      const inlineUnified = readInlineValue(target, 'border-radius');
      if (inlineUnified) {
        const formatted = formatLengthForDisplay(inlineUnified);
        field.unified.input.value = formatted.value;
        field.unified.setSuffix(formatted.suffix);
      } else {
        // Check if all corners are the same
        const tl = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['top-left']);
        const tr = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['top-right']);
        const br = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['bottom-right']);
        const bl = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['bottom-left']);
        const displayValue =
          tl === tr && tl === br && tl === bl ? tl : readComputedValue(target, 'border-radius');
        const formatted = formatLengthForDisplay(displayValue);
        field.unified.input.value = formatted.value;
        field.unified.setSuffix(formatted.suffix);
      }
      field.unified.input.placeholder = '';

      // Corner values
      for (const corner of BORDER_RADIUS_CORNERS) {
        const propName = BORDER_RADIUS_CORNER_PROPERTIES[corner];
        const inlineValue = readInlineValue(target, propName);
        const computedValue = readComputedValue(target, propName);
        const displayValue = inlineValue || computedValue;
        const formatted = formatLengthForDisplay(displayValue);
        field.corners[corner].input.value = formatted.value;
        field.corners[corner].input.placeholder = '';
        field.corners[corner].setSuffix(formatted.suffix);
      }
      return;
    }

    if (field.kind === 'text') {
      const input = field.element;

      if (!target || !target.isConnected) {
        input.disabled = true;
        input.value = '';
        input.placeholder = '';
        return;
      }

      input.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, cssProperty);
      const computedValue = readComputedValue(target, cssProperty);
      const displayValue = inlineValue || computedValue;

      // Special handling for background-image URL field
      if (property === 'background-image') {
        input.value = extractUrlFromBackgroundImage(displayValue);
      } else {
        input.value = displayValue;
      }
      input.placeholder = '';
    } else if (field.kind === 'select') {
      const select = field.element;

      if (!target || !target.isConnected) {
        select.disabled = true;
        return;
      }

      select.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(select);
      if (isEditing && !force) return;

      const inline = readInlineValue(target, cssProperty);
      const computed = readComputedValue(target, cssProperty);
      const val = inline || computed;
      const hasOption = Array.from(select.options).some((o) => o.value === val);
      select.value = hasOption ? val : (select.options[0]?.value ?? '');
    } else {
      // Color field
      const colorField = field.field;

      if (!target || !target.isConnected) {
        colorField.setDisabled(true);
        colorField.setValue('');
        colorField.setPlaceholder('');
        return;
      }

      colorField.setDisabled(false);

      const isEditing = field.handle !== null || colorField.isFocused();
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, cssProperty);
      const computedValue = readComputedValue(target, cssProperty);
      if (inlineValue) {
        colorField.setValue(inlineValue);
        colorField.setPlaceholder(/\bvar\s*\(/i.test(inlineValue) ? computedValue : '');
      } else {
        colorField.setValue(computedValue);
        colorField.setPlaceholder('');
      }
    }
  }

  function syncAllFields(): void {
    for (const p of PROPS) syncField(p);
    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);
    borderEdgeGroup.setDisabled(!hasTarget);
    bgTypeSelect.disabled = !hasTarget;
    updateBackgroundVisibility();
  }

  // ===========================================================================
  // Event Wiring
  // ===========================================================================

  function getNormalizer(property: AppearanceProperty): (v: string) => string {
    if (property === 'opacity') return normalizeOpacity;
    if (property === 'border-width') return normalizeLength;
    if (property === 'background-image') return normalizeBackgroundImageUrl;
    return (v) => v.trim();
  }

  function wireTextInput(property: AppearanceProperty): void {
    const field = fields[property];
    if (field.kind !== 'text') return;

    const input = field.element;
    const normalize = getNormalizer(property);

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (handle) handle.set(normalize(input.value));
    });

    disposer.listen(input, 'blur', () => {
      commitTransaction(property);
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction(property);
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction(property);
        syncField(property, true);
      }
    });
  }

  function wireSelect(property: AppearanceProperty): void {
    const field = fields[property];
    if (field.kind !== 'select') return;

    const select = field.element;

    const preview = () => {
      const handle = beginTransaction(property);
      if (handle) handle.set(select.value);
    };

    disposer.listen(select, 'input', preview);
    disposer.listen(select, 'change', preview);
    disposer.listen(select, 'blur', () => {
      commitTransaction(property);
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction(property);
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction(property);
        syncField(property, true);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wire border-radius control (toggle + unified + corners)
  // ---------------------------------------------------------------------------
  function wireBorderRadiusControl(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;

    // Toggle button
    const setExpanded = (expanded: boolean) => {
      field.expanded = expanded;
      field.cornersGrid.hidden = !expanded;
      field.toggleButton.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    };
    setExpanded(false);

    disposer.listen(field.toggleButton, 'click', () => {
      setExpanded(!field.expanded);
    });

    // Unified input preview
    const previewUnified = () => {
      const handle = beginBorderRadiusTransaction();
      if (!handle) return;

      field.mode = 'unified';
      field.cornersMaterialized = false;

      const v = combineLengthValue(field.unified.input.value, field.unified.getSuffixText());
      handle.set({
        'border-radius': v,
        'border-top-left-radius': '',
        'border-top-right-radius': '',
        'border-bottom-right-radius': '',
        'border-bottom-left-radius': '',
      });
    };

    // Corner input preview
    const previewCorner = (corner: BorderRadiusCorner) => {
      const target = currentTarget;
      if (!target || !target.isConnected) return;

      const handle = beginBorderRadiusTransaction();
      if (!handle) return;

      const cornerProp = BORDER_RADIUS_CORNER_PROPERTIES[corner];
      const container = field.corners[corner];
      const next = combineLengthValue(container.input.value, container.getSuffixText());

      // When switching from shorthand to per-corner, materialize all corners first
      if (field.mode !== 'corners' || !field.cornersMaterialized) {
        const initialValues: Record<string, string> = {
          'border-radius': '',
          'border-top-left-radius':
            readInlineValue(target, 'border-top-left-radius') ||
            readComputedValue(target, 'border-top-left-radius'),
          'border-top-right-radius':
            readInlineValue(target, 'border-top-right-radius') ||
            readComputedValue(target, 'border-top-right-radius'),
          'border-bottom-right-radius':
            readInlineValue(target, 'border-bottom-right-radius') ||
            readComputedValue(target, 'border-bottom-right-radius'),
          'border-bottom-left-radius':
            readInlineValue(target, 'border-bottom-left-radius') ||
            readComputedValue(target, 'border-bottom-left-radius'),
        };
        initialValues[cornerProp] = next;
        handle.set(initialValues);
        field.mode = 'corners';
        field.cornersMaterialized = true;
        return;
      }

      handle.set({ 'border-radius': '', [cornerProp]: next });
    };

    disposer.listen(field.unified.input, 'input', previewUnified);
    for (const corner of BORDER_RADIUS_CORNERS) {
      disposer.listen(field.corners[corner].input, 'input', () => previewCorner(corner));
    }

    // Commit when leaving the whole radius control
    disposer.listen(field.root, 'focusout', (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && field.root.contains(next)) return;
      commitBorderRadiusTransaction();
      syncAllFields();
    });

    // Keydown handlers
    const wireKeydown = (input: HTMLInputElement) => {
      disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitBorderRadiusTransaction();
          syncAllFields();
          input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          rollbackBorderRadiusTransaction();
          syncField('border-radius', true);
        }
      });
    };

    wireKeydown(field.unified.input);
    for (const corner of BORDER_RADIUS_CORNERS) {
      wireKeydown(field.corners[corner].input);
    }
  }

  // Wire all fields
  wireSelect('overflow');
  wireSelect('box-sizing');
  wireTextInput('opacity');
  wireBorderRadiusControl();
  wireTextInput('border-width');
  wireSelect('border-style');
  wireTextInput('background-image');

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    // Infer background type from element
    if (element && element.isConnected) {
      const bgImage =
        readInlineValue(element, 'background-image') ||
        readComputedValue(element, 'background-image');
      currentBackgroundType = inferBackgroundType(bgImage);
      bgTypeSelect.value = currentBackgroundType;
    } else {
      currentBackgroundType = 'solid';
      bgTypeSelect.value = 'solid';
    }

    gradientControl.setTarget(element);
    updateBackgroundVisibility();
    syncAllFields();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    gradientControl.refresh();
    syncAllFields();
  }

  function dispose(): void {
    commitAllTransactions();
    currentTarget = null;
    // gradientControl.dispose() is called via disposer.add() registration
    disposer.dispose();
  }

  // Initial state
  updateBackgroundVisibility();
  syncAllFields();

  return { setTarget, refresh, dispose };
}

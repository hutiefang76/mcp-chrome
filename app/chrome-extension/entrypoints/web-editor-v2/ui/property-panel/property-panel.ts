/**
 * Property Panel
 *
 * Right-side panel displaying Design controls, CSS styles, Props, and DOM tree for selected elements.
 *
 * Features:
 * - Tab switching between Design, CSS, Props, and DOM views
 * - Collapsible control groups (Position, Layout, Size, Spacing, Typography, Appearance, Effects, Gradient)
 * - CSS panel showing matched rules and inheritance (Phase 4.6)
 * - Props panel for React/Vue component props editing (Phase 7.3)
 * - Empty state when no element is selected
 * - Close button integration
 * - Automatic control initialization and lifecycle management
 */

import { Disposer } from '../../utils/disposables';
import { installFloatingDrag, type FloatingPosition } from '../floating-drag';
import type {
  PropertyPanel,
  PropertyPanelOptions,
  PropertyPanelTab,
  ControlGroup,
  DesignControl,
} from './types';
import { createSizeControl } from './controls/size-control';
import { createSpacingControl } from './controls/spacing-control';
import { createPositionControl } from './controls/position-control';
import { createLayoutControl } from './controls/layout-control';
import { createTypographyControl } from './controls/typography-control';
import { createAppearanceControl } from './controls/appearance-control';
import { createEffectsControl } from './controls/effects-control';
import { createGradientControl } from './controls/gradient-control';
import { createComponentsTree, type ComponentsTree } from './components-tree';
import { createCssPanel, type CssPanel } from './css-panel';
import { createPropsPanel, type PropsPanel } from './props-panel';

// =============================================================================
// Constants
// =============================================================================

/** Control group configuration */
const CONTROL_GROUPS = [
  { id: 'position', label: 'Position' },
  { id: 'layout', label: 'Layout' },
  { id: 'size', label: 'Size' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'typography', label: 'Typography' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'effects', label: 'Effects' },
  { id: 'gradient', label: 'Gradient' },
] as const;

type ControlGroupId = (typeof CONTROL_GROUPS)[number]['id'];

// =============================================================================
// Helpers
// =============================================================================

let groupIdSeq = 0;

/**
 * Format element label for display (tag + id/classes)
 */
function formatTargetLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const htmlEl = element as HTMLElement;
  const id = htmlEl.id?.trim();

  if (id) {
    return `${tag}#${id}`;
  }

  const classes = Array.from(element.classList ?? []).slice(0, 2);
  if (classes.length > 0) {
    return `${tag}.${classes.join('.')}`;
  }

  return tag;
}

/**
 * Create chevron SVG icon for collapse/expand indicator
 */
function createChevronIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.classList.add('we-chevron');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 8l3 3 3-3');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  return svg;
}

/**
 * Create close (X) SVG icon for window close button
 */
function createCloseIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 6l8 8M14 6l-8 8');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  return svg;
}

/**
 * Create sliders SVG icon for property panel minimize/expand button
 */
function createSlidersIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // Three horizontal lines
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M4 5H16 M4 10H16 M4 15H16');
  lines.setAttribute('stroke', 'currentColor');
  lines.setAttribute('stroke-width', '2');
  lines.setAttribute('stroke-linecap', 'round');
  lines.setAttribute('stroke-linejoin', 'round');
  svg.append(lines);

  // Three knob circles at different positions
  const knobs: Array<[number, number]> = [
    [7, 5],
    [13, 10],
    [9, 15],
  ];

  for (const [cx, cy] of knobs) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '1.75');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
    svg.append(circle);
  }

  return svg;
}

/**
 * Create grip (drag handle) SVG icon
 */
function createGripIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // 6 dots in 2 columns
  const dots: Array<[number, number]> = [
    [7, 6],
    [13, 6],
    [7, 10],
    [13, 10],
    [7, 14],
    [13, 14],
  ];

  for (const [cx, cy] of dots) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '1.4');
    circle.setAttribute('fill', 'currentColor');
    svg.append(circle);
  }

  return svg;
}

/**
 * Create a collapsible control group
 */
function createControlGroup(groupId: string, label: string, disposer: Disposer): ControlGroup {
  const uniqueId = `we_group_${groupId}_${++groupIdSeq}`;
  let collapsed = false;

  // Group container
  const root = document.createElement('section');
  root.className = 'we-group';
  root.dataset.group = groupId;
  root.dataset.collapsed = 'false';

  // Header button (clickable to toggle)
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'we-group-header';
  header.setAttribute('aria-expanded', 'true');
  header.setAttribute('aria-controls', uniqueId);

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;

  header.append(labelSpan, createChevronIcon());

  // Body container
  const body = document.createElement('div');
  body.className = 'we-group-body';
  body.id = uniqueId;

  // Toggle handler
  disposer.listen(header, 'click', (event) => {
    event.preventDefault();
    toggle();
  });

  root.append(header, body);

  function setCollapsed(value: boolean): void {
    collapsed = value;
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function isCollapsed(): boolean {
    return collapsed;
  }

  function toggle(): void {
    setCollapsed(!collapsed);
  }

  return {
    root,
    body,
    setCollapsed,
    isCollapsed,
    toggle,
  };
}

// =============================================================================
// Property Panel Implementation
// =============================================================================

/**
 * Create the Property Panel component
 */
export function createPropertyPanel(options: PropertyPanelOptions): PropertyPanel {
  const disposer = new Disposer();

  // State
  let currentTarget: Element | null = null;
  let currentTab: PropertyPanelTab = options.defaultTab ?? 'design';
  let minimized = false;
  let floatingPosition: FloatingPosition | null = options.initialPosition ?? null;
  const controlGroups = new Map<ControlGroupId, ControlGroup>();
  const controls: DesignControl[] = [];
  let componentsTree: ComponentsTree | null = null;
  let cssPanel: CssPanel | null = null;
  let propsPanel: PropsPanel | null = null;

  // References to specific controls for live style sync (Bug 3 fix)
  let sizeControl: DesignControl | null = null;
  let positionControl: DesignControl | null = null;
  let spacingControl: DesignControl | null = null;

  // Live style sync state (MutationObserver for external style changes)
  let styleObserver: MutationObserver | null = null;
  let styleObserverTarget: Element | null = null;
  let styleObserverRafId: number | null = null;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  // Root panel container
  const root = document.createElement('aside');
  root.className = 'we-panel we-prop-panel';
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Properties');
  root.dataset.tab = currentTab;
  root.dataset.empty = 'true';
  root.dataset.minimized = 'false';
  root.dataset.dragged = floatingPosition ? 'true' : 'false';

  // Header
  const header = document.createElement('header');
  header.className = 'we-header';

  // Drag handle (grip) - placed directly in header for proper alignment
  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'we-drag-handle';
  dragHandle.setAttribute('aria-label', 'Drag property panel');
  dragHandle.dataset.tooltip = 'Drag';
  dragHandle.append(createGripIcon());

  // Header left: title and target label (column layout)
  const headerLeft = document.createElement('div');
  headerLeft.className = 'we-prop-header-left';

  const title = document.createElement('div');
  title.className = 'we-title';
  title.textContent = 'Properties';

  const targetLabel = document.createElement('div');
  targetLabel.className = 'we-prop-target';

  headerLeft.append(title, targetLabel);

  // Header right: tabs and close button
  const headerRight = document.createElement('div');
  headerRight.className = 'we-prop-header-right';

  // Tab buttons
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'we-prop-tabs';
  tabsContainer.setAttribute('role', 'tablist');
  tabsContainer.setAttribute('aria-label', 'Property tabs');

  const designTabBtn = document.createElement('button');
  designTabBtn.type = 'button';
  designTabBtn.className = 'we-tab';
  designTabBtn.setAttribute('role', 'tab');
  designTabBtn.dataset.tab = 'design';
  designTabBtn.textContent = 'Design';

  const cssTabBtn = document.createElement('button');
  cssTabBtn.type = 'button';
  cssTabBtn.className = 'we-tab';
  cssTabBtn.setAttribute('role', 'tab');
  cssTabBtn.dataset.tab = 'css';
  cssTabBtn.textContent = 'CSS';

  const propsTabBtn = document.createElement('button');
  propsTabBtn.type = 'button';
  propsTabBtn.className = 'we-tab';
  propsTabBtn.setAttribute('role', 'tab');
  propsTabBtn.dataset.tab = 'props';
  propsTabBtn.textContent = 'Props';

  const domTabBtn = document.createElement('button');
  domTabBtn.type = 'button';
  domTabBtn.className = 'we-tab';
  domTabBtn.setAttribute('role', 'tab');
  domTabBtn.dataset.tab = 'dom';
  domTabBtn.textContent = 'DOM';

  tabsContainer.append(designTabBtn, cssTabBtn, propsTabBtn, domTabBtn);
  headerRight.append(tabsContainer);

  // Minimize/expand button
  const minimizeBtn = document.createElement('button');
  minimizeBtn.type = 'button';
  minimizeBtn.className = 'we-icon-btn';
  minimizeBtn.setAttribute('aria-label', 'Minimize property panel');
  minimizeBtn.dataset.tooltip = 'Minimize';
  minimizeBtn.append(createSlidersIcon());
  headerRight.append(minimizeBtn);

  // Close button reference (used in setMinimized)
  let closeBtn: HTMLButtonElement | null = null;

  // Close button (optional) - icon button style
  if (options.onRequestClose) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'we-icon-btn';
    closeBtn.setAttribute('aria-label', 'Close Web Editor');
    closeBtn.dataset.tooltip = 'Close';
    closeBtn.append(createCloseIcon());

    disposer.listen(closeBtn, 'click', (event) => {
      event.preventDefault();
      options.onRequestClose?.();
    });

    headerRight.append(closeBtn);
  }

  header.append(dragHandle, headerLeft, headerRight);

  // Body container
  const body = document.createElement('div');
  body.className = 'we-prop-body';

  // Empty state message
  const emptyState = document.createElement('div');
  emptyState.className = 'we-prop-empty';
  emptyState.textContent = 'Select an element to view and edit its properties.';

  // Design panel (contains control groups)
  const designPanel = document.createElement('div');
  designPanel.className = 'we-prop-tab-content';
  designPanel.dataset.tabContent = 'design';

  // Create control groups
  for (const { id, label } of CONTROL_GROUPS) {
    const group = createControlGroup(id, label, disposer);
    controlGroups.set(id, group);
    designPanel.append(group.root);
  }

  // CSS panel (Phase 4.6)
  const cssPanelContainer = document.createElement('div');
  cssPanelContainer.className = 'we-prop-tab-content';
  cssPanelContainer.dataset.tabContent = 'css';

  // Props panel (Phase 7.3)
  const propsPanelContainer = document.createElement('div');
  propsPanelContainer.className = 'we-prop-tab-content';
  propsPanelContainer.dataset.tabContent = 'props';

  // DOM panel (Components tree - Phase 3.2)
  const domPanel = document.createElement('div');
  domPanel.className = 'we-prop-tab-content';
  domPanel.dataset.tabContent = 'dom';

  body.append(emptyState, designPanel, cssPanelContainer, propsPanelContainer, domPanel);
  root.append(header, body);

  // Mount to container
  options.container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Floating Drag (Panel Position)
  // ==========================================================================

  const CLAMP_MARGIN_PX = 16;

  function clampToViewport(position: FloatingPosition): FloatingPosition {
    const rect = root.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const margin = CLAMP_MARGIN_PX;
    const maxLeft = Math.max(margin, viewportW - margin - rect.width);
    const maxTop = Math.max(margin, viewportH - margin - rect.height);

    const left = Number.isFinite(position.left) ? position.left : 0;
    const top = Number.isFinite(position.top) ? position.top : 0;

    return {
      left: Math.round(Math.min(maxLeft, Math.max(margin, left))),
      top: Math.round(Math.min(maxTop, Math.max(margin, top))),
    };
  }

  function syncFloatingPositionStyles(): void {
    root.dataset.dragged = floatingPosition ? 'true' : 'false';

    // While minimized, prefer the existing minimized layout (top-right)
    if (!floatingPosition || minimized) {
      root.style.left = '';
      root.style.top = '';
      root.style.right = '';
      root.style.bottom = '';
      return;
    }

    root.style.left = `${floatingPosition.left}px`;
    root.style.top = `${floatingPosition.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function setPosition(position: FloatingPosition | null): void {
    floatingPosition = position ? clampToViewport(position) : null;
    syncFloatingPositionStyles();
    options.onPositionChange?.(floatingPosition);
  }

  function getPosition(): FloatingPosition | null {
    return floatingPosition;
  }

  // Install drag behavior
  disposer.add(
    installFloatingDrag({
      handleEl: dragHandle,
      targetEl: root,
      clampMargin: CLAMP_MARGIN_PX,
      onPositionChange: (pos) => setPosition(pos),
    }),
  );

  // Apply initial position (if provided)
  if (floatingPosition !== null) {
    setPosition(floatingPosition);
  } else {
    syncFloatingPositionStyles();
  }

  // ==========================================================================
  // Initialize Controls
  // ==========================================================================

  /**
   * Initialize all design controls.
   * Controls are created once and manage their own lifecycle.
   */
  function initializeControls(): void {
    // Size control (width/height) - save reference for live sync
    const sizeGroup = controlGroups.get('size');
    if (sizeGroup) {
      sizeControl = createSizeControl({
        container: sizeGroup.body,
        transactionManager: options.transactionManager,
      });
      controls.push(sizeControl);
    }

    // Spacing control (margin/padding) - save reference for live sync
    const spacingGroup = controlGroups.get('spacing');
    if (spacingGroup) {
      spacingControl = createSpacingControl({
        container: spacingGroup.body,
        transactionManager: options.transactionManager,
      });
      controls.push(spacingControl);
    }

    // Position control (position, top/right/bottom/left, z-index) - save reference for live sync
    const positionGroup = controlGroups.get('position');
    if (positionGroup) {
      positionControl = createPositionControl({
        container: positionGroup.body,
        transactionManager: options.transactionManager,
      });
      controls.push(positionControl);
    }

    // Layout control (display, flex-direction, justify-content, align-items, gap)
    const layoutGroup = controlGroups.get('layout');
    if (layoutGroup) {
      const layoutControl = createLayoutControl({
        container: layoutGroup.body,
        transactionManager: options.transactionManager,
      });
      controls.push(layoutControl);
    }

    // Typography control (font-size, font-weight, line-height, text-align, color)
    const typographyGroup = controlGroups.get('typography');
    if (typographyGroup) {
      const typographyControl = createTypographyControl({
        container: typographyGroup.body,
        transactionManager: options.transactionManager,
        tokensService: options.tokensService,
      });
      controls.push(typographyControl);
    }

    // Appearance control (opacity, border-radius, border, background-color)
    const appearanceGroup = controlGroups.get('appearance');
    if (appearanceGroup) {
      const appearanceControl = createAppearanceControl({
        container: appearanceGroup.body,
        transactionManager: options.transactionManager,
        tokensService: options.tokensService,
      });
      controls.push(appearanceControl);
    }

    // Effects control (box-shadow, filter blur, backdrop-filter blur)
    const effectsGroup = controlGroups.get('effects');
    if (effectsGroup) {
      const effectsControl = createEffectsControl({
        container: effectsGroup.body,
        transactionManager: options.transactionManager,
        tokensService: options.tokensService,
      });
      controls.push(effectsControl);
    }

    // Gradient control (linear-gradient, radial-gradient)
    const gradientGroup = controlGroups.get('gradient');
    if (gradientGroup) {
      const gradientControl = createGradientControl({
        container: gradientGroup.body,
        transactionManager: options.transactionManager,
        tokensService: options.tokensService,
      });
      controls.push(gradientControl);
    }
  }

  // Initialize controls immediately
  initializeControls();

  // Initialize Components Tree (Phase 3.2)
  componentsTree = createComponentsTree({
    container: domPanel,
    onSelect: (element) => {
      // When user clicks an element in the tree, select it
      options.onSelectElement(element);
    },
  });

  // Initialize CSS Panel (Phase 4.6 + 4.7)
  cssPanel = createCssPanel({
    container: cssPanelContainer,
    transactionManager: options.transactionManager,
    onClassChange: () => {
      // Keep header label in sync with class edits (Phase 4.7)
      if (currentTarget) {
        targetLabel.textContent = formatTargetLabel(currentTarget);
      }
    },
  });

  // Initialize Props Panel (Phase 7.3)
  propsPanel = createPropsPanel({
    container: propsPanelContainer,
    propsBridge: options.propsBridge,
  });

  // ==========================================================================
  // Tab Event Handlers
  // ==========================================================================

  disposer.listen(designTabBtn, 'click', (event) => {
    event.preventDefault();
    setTab('design');
  });

  disposer.listen(cssTabBtn, 'click', (event) => {
    event.preventDefault();
    setTab('css');
  });

  disposer.listen(propsTabBtn, 'click', (event) => {
    event.preventDefault();
    setTab('props');
  });

  disposer.listen(domTabBtn, 'click', (event) => {
    event.preventDefault();
    setTab('dom');
  });

  // Minimize button handler
  disposer.listen(minimizeBtn, 'click', (event) => {
    event.preventDefault();
    setMinimized(!minimized);
  });

  // ==========================================================================
  // Minimize State
  // ==========================================================================

  /**
   * Toggle minimized state of property panel
   */
  function setMinimized(value: boolean): void {
    minimized = value;
    root.dataset.minimized = minimized ? 'true' : 'false';

    // Hide/show body and header elements
    body.hidden = minimized;
    headerLeft.hidden = minimized;
    tabsContainer.hidden = minimized;
    if (closeBtn) closeBtn.hidden = minimized;

    // Update minimize button label and tooltip
    minimizeBtn.setAttribute(
      'aria-label',
      minimized ? 'Expand property panel' : 'Minimize property panel',
    );
    minimizeBtn.dataset.tooltip = minimized ? 'Expand' : 'Minimize';

    // Keep minimized layout stable while preserving stored floating position.
    // When restoring, re-apply stored position (and clamp with current size).
    if (!minimized && floatingPosition) {
      setPosition(floatingPosition);
    } else {
      syncFloatingPositionStyles();
    }
  }

  // ==========================================================================
  // Render Functions
  // ==========================================================================

  /**
   * Update tab button states and panel visibility
   */
  function renderTabs(): void {
    root.dataset.tab = currentTab;

    designTabBtn.setAttribute('aria-selected', currentTab === 'design' ? 'true' : 'false');
    cssTabBtn.setAttribute('aria-selected', currentTab === 'css' ? 'true' : 'false');
    propsTabBtn.setAttribute('aria-selected', currentTab === 'props' ? 'true' : 'false');
    domTabBtn.setAttribute('aria-selected', currentTab === 'dom' ? 'true' : 'false');

    // Show/hide panels based on tab and target
    const hasTarget = currentTarget !== null;
    designPanel.hidden = !hasTarget || currentTab !== 'design';
    cssPanelContainer.hidden = !hasTarget || currentTab !== 'css';
    propsPanelContainer.hidden = !hasTarget || currentTab !== 'props';
    domPanel.hidden = !hasTarget || currentTab !== 'dom';

    // Notify panels of visibility change (for lazy loading optimization)
    cssPanel?.setVisible(hasTarget && currentTab === 'css');
    propsPanel?.setVisible(hasTarget && currentTab === 'props');
  }

  /**
   * Update empty state visibility
   */
  function renderEmptyState(): void {
    const hasTarget = currentTarget !== null;
    root.dataset.empty = hasTarget ? 'false' : 'true';
    emptyState.hidden = hasTarget;

    if (!hasTarget) {
      targetLabel.textContent = '';
    }

    renderTabs();
  }

  /**
   * Update all controls with current target
   */
  function updateControls(): void {
    for (const control of controls) {
      control.setTarget(currentTarget);
    }
    // Also update Components Tree
    componentsTree?.setTarget(currentTarget);
    // Also update CSS Panel
    cssPanel?.setTarget(currentTarget);
    // Also update Props Panel
    propsPanel?.setTarget(currentTarget);
  }

  // ==========================================================================
  // Live Style Sync (for external style mutations like resize handles)
  // ==========================================================================

  /**
   * Cancel pending rAF for style observer
   */
  function cancelStyleObserverRaf(): void {
    if (styleObserverRafId !== null) {
      cancelAnimationFrame(styleObserverRafId);
      styleObserverRafId = null;
    }
  }

  /**
   * Schedule a throttled refresh of size/position/spacing controls.
   * Uses rAF to coalesce multiple style mutations within the same frame.
   */
  function scheduleLiveStyleRefresh(): void {
    if (disposer.isDisposed) return;
    if (styleObserverRafId !== null) return;

    styleObserverRafId = requestAnimationFrame(() => {
      styleObserverRafId = null;
      if (disposer.isDisposed) return;
      if (!currentTarget || !currentTarget.isConnected) return;

      // Only refresh controls that are affected by resize operations
      sizeControl?.refresh();
      positionControl?.refresh();
      spacingControl?.refresh();
    });
  }

  /**
   * Disconnect the style observer and clean up
   */
  function disconnectStyleObserver(): void {
    cancelStyleObserverRaf();

    if (styleObserver) {
      try {
        styleObserver.disconnect();
      } catch {
        // Best-effort cleanup
      }
    }

    styleObserver = null;
    styleObserverTarget = null;
  }

  /**
   * Connect a MutationObserver to watch for style attribute changes on the target.
   * This enables live sync when external code (like resize handles) modifies inline styles.
   */
  function connectStyleObserver(target: Element | null): void {
    disconnectStyleObserver();

    if (!target || !target.isConnected) return;
    if (typeof MutationObserver === 'undefined') return;

    styleObserverTarget = target;

    styleObserver = new MutationObserver(() => {
      if (disposer.isDisposed) return;
      // Ignore late events after selection changes
      if (styleObserverTarget !== currentTarget) return;
      scheduleLiveStyleRefresh();
    });

    try {
      styleObserver.observe(target, {
        attributes: true,
        attributeFilter: ['style'],
      });
    } catch {
      // Some nodes may reject observation; ignore
      disconnectStyleObserver();
    }
  }

  // Register cleanup for style observer
  disposer.add(disconnectStyleObserver);

  // ==========================================================================
  // Public API (PropertyPanel interface)
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    currentTarget = element;

    if (element) {
      targetLabel.textContent = formatTargetLabel(element);
    }

    renderEmptyState();
    updateControls();

    // Connect style observer for live sync (resize handles, etc.)
    connectStyleObserver(currentTarget);
  }

  function setTab(tab: PropertyPanelTab): void {
    if (disposer.isDisposed) return;

    currentTab = tab;
    renderTabs();
  }

  function getTab(): PropertyPanelTab {
    return currentTab;
  }

  function refresh(): void {
    if (disposer.isDisposed) return;

    // Refresh header label (class changes may affect display)
    if (currentTarget) {
      targetLabel.textContent = formatTargetLabel(currentTarget);
    }

    for (const control of controls) {
      control.refresh();
    }
    // Also refresh Components Tree
    componentsTree?.refresh();
    // Also refresh CSS Panel
    cssPanel?.refresh();
    // Also refresh Props Panel
    propsPanel?.refresh();
  }

  function dispose(): void {
    // Dispose Components Tree
    componentsTree?.dispose();
    componentsTree = null;

    // Dispose CSS Panel
    cssPanel?.dispose();
    cssPanel = null;

    // Dispose Props Panel
    propsPanel?.dispose();
    propsPanel = null;

    // Dispose all controls
    for (const control of controls) {
      control.dispose();
    }
    controls.length = 0;
    controlGroups.clear();

    currentTarget = null;
    disposer.dispose();
  }

  // Initial render
  renderEmptyState();

  return {
    setTarget,
    setTab,
    getTab,
    refresh,
    getPosition,
    setPosition,
    dispose,
  };
}

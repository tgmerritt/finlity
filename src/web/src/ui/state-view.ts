/**
 * Inline empty / loading / error state component.
 *
 * Render a self-contained "this card has nothing to show" panel inside any
 * container — used in place of a silent blank render so users always know
 * whether a section is loading, has no data, or failed to load.
 *
 * This is deliberately separate from `ui/loading.ts`'s global overlay; that
 * one is for full-screen blocking, this one is per-card / per-section.
 *
 * Usage:
 *   setStateView('#chart-allocation', { kind: 'empty', title: 'No data' });
 *   // ...
 *   clearStateView('#chart-allocation'); // before rendering real data
 */

const STATE_VIEW_CLASS = 'state-view';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type StateKind = 'loading' | 'empty' | 'error';

export interface StateViewOptions {
  kind: StateKind;
  /** Headline shown larger; default per-kind: "Loading", "No data yet", "Could not load". */
  title?: string;
  /** Helper paragraph below the title. */
  description?: string;
  /** Optional action button. */
  action?: { label: string; onClick: () => void };
  /** Optional inline icon (svg string or Node). Defaults provided per-kind. */
  icon?: string | Node;
  /** Extra class added (in addition to the base `state-view state-view--{kind}`). */
  className?: string;
}

const DEFAULT_TITLES: Record<StateKind, string> = {
  loading: 'Loading',
  empty: 'No data yet',
  error: 'Could not load',
};

/**
 * Resolve a container reference (Element or selector string) to an Element.
 */
function resolveContainer(target: Element | string): Element | null {
  if (typeof target === 'string') {
    // Allow either a selector or a bare ID.
    if (target.startsWith('#') || target.startsWith('.') || target.startsWith('[')) {
      return document.querySelector(target);
    }
    return document.getElementById(target);
  }
  return target;
}

/**
 * Build the default per-kind icon as an inline SVG element.
 *
 * Uses `currentColor` so the icon inherits the surrounding text color and
 * automatically adapts to light/dark theme without us shipping new tokens.
 */
function buildDefaultIcon(kind: StateKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '32');
  svg.setAttribute('height', '32');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (kind === 'loading') {
    // Indeterminate spinner: a circle with stroke-dasharray, animated by CSS.
    svg.setAttribute('class', 'state-view-spinner');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '9');
    circle.setAttribute('stroke-dasharray', '40 60');
    svg.appendChild(circle);
  } else if (kind === 'error') {
    // Triangle-with-exclamation (warning sign).
    const tri = document.createElementNS(SVG_NS, 'path');
    tri.setAttribute('d', 'M12 3 L22 20 L2 20 Z');
    svg.appendChild(tri);
    const bar = document.createElementNS(SVG_NS, 'line');
    bar.setAttribute('x1', '12');
    bar.setAttribute('y1', '10');
    bar.setAttribute('x2', '12');
    bar.setAttribute('y2', '14');
    svg.appendChild(bar);
    const dot = document.createElementNS(SVG_NS, 'line');
    dot.setAttribute('x1', '12');
    dot.setAttribute('y1', '17');
    dot.setAttribute('x2', '12');
    dot.setAttribute('y2', '17.01');
    svg.appendChild(dot);
  } else {
    // Empty: muted document icon.
    const doc = document.createElementNS(SVG_NS, 'path');
    doc.setAttribute('d', 'M14 3 H6 a2 2 0 0 0 -2 2 v14 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V9 z');
    svg.appendChild(doc);
    const fold = document.createElementNS(SVG_NS, 'polyline');
    fold.setAttribute('points', '14 3 14 9 20 9');
    svg.appendChild(fold);
  }

  return svg;
}

/**
 * Convert a custom string icon into a Node by parsing it as SVG.
 *
 * We parse rather than `innerHTML` to keep the call site lint-clean
 * (`no-unsanitized/property`) and to surface broken markup early.
 */
function parseStringIcon(svg: string): Node {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  // DOMParser puts errors in a <parsererror> root rather than throwing.
  if (root.nodeName === 'parsererror') {
    const span = document.createElement('span');
    span.textContent = '';
    return span;
  }
  return document.importNode(root, true);
}

/**
 * Render a state view as a self-contained Node. Caller is responsible for
 * clearing/replacing the container.
 *
 * Returns a div with class "state-view state-view--{kind}".
 */
export function createStateView(options: StateViewOptions): HTMLDivElement {
  const { kind, title, description, action, icon, className } = options;

  const wrapper = document.createElement('div');
  wrapper.className = `${STATE_VIEW_CLASS} ${STATE_VIEW_CLASS}--${kind}`;
  if (className) wrapper.className += ` ${className}`;
  wrapper.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  // Icon
  const iconWrap = document.createElement('div');
  iconWrap.className = 'state-view-icon';
  if (icon === undefined) {
    iconWrap.appendChild(buildDefaultIcon(kind));
  } else if (typeof icon === 'string') {
    iconWrap.appendChild(parseStringIcon(icon));
  } else {
    iconWrap.appendChild(icon);
  }
  wrapper.appendChild(iconWrap);

  // Title
  const titleEl = document.createElement('p');
  titleEl.className = 'state-view-title';
  titleEl.textContent = title ?? DEFAULT_TITLES[kind];
  wrapper.appendChild(titleEl);

  // Description
  if (description) {
    const descEl = document.createElement('p');
    descEl.className = 'state-view-description';
    descEl.textContent = description;
    wrapper.appendChild(descEl);
  }

  // Action
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary state-view-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    wrapper.appendChild(btn);
  }

  return wrapper;
}

/**
 * Replace the inner contents of a container with a state view.
 *
 * Idempotent — wipes everything inside the container then mounts the
 * state-view, so callers can safely call this repeatedly to swap states
 * (loading -> empty, empty -> error, etc.) without leaving stragglers.
 */
export function setStateView(container: Element | string, options: StateViewOptions): void {
  const el = resolveContainer(container);
  if (!el) return;

  // Wipe whatever was there. We're explicit about owning the container in
  // this state — siblings are caller's responsibility.
  while (el.firstChild) el.removeChild(el.firstChild);

  el.appendChild(createStateView(options));
}

/**
 * Surgically remove any state-view nodes from a container, leaving regular
 * children alone. Useful before re-rendering real data so callers don't
 * have to manually wipe.
 *
 * Returns true if at least one state-view was removed.
 */
export function clearStateView(container: Element | string): boolean {
  const el = resolveContainer(container);
  if (!el) return false;

  let removed = false;
  // Iterate a static snapshot — `el.children` is live and shifts while we
  // remove.
  const children = Array.from(el.children);
  for (const child of children) {
    if (child.classList.contains(STATE_VIEW_CLASS)) {
      el.removeChild(child);
      removed = true;
    }
  }
  return removed;
}

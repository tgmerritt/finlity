/**
 * HTML and DOM utility functions.
 */

/**
 * Escape HTML special characters to prevent XSS.
 * @param text - Text to escape
 * @returns Escaped HTML string
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Get an element by ID with type safety.
 * @param id - Element ID
 * @returns The element or null
 */
export function getElementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Get an element by ID, throwing if not found.
 * @param id - Element ID
 * @returns The element
 * @throws Error if element not found
 */
export function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id) as T | null;
  if (!element) {
    throw new Error(`Required element not found: ${id}`);
  }
  return element;
}

/**
 * Query selector with type safety.
 * @param selector - CSS selector
 * @param parent - Parent element (default: document)
 * @returns The element or null
 */
export function querySelector<T extends Element>(
  selector: string,
  parent: ParentNode = document
): T | null {
  return parent.querySelector<T>(selector);
}

/**
 * Query selector all with type safety.
 * @param selector - CSS selector
 * @param parent - Parent element (default: document)
 * @returns NodeList of elements
 */
export function querySelectorAll<T extends Element>(
  selector: string,
  parent: ParentNode = document
): NodeListOf<T> {
  return parent.querySelectorAll<T>(selector);
}

/**
 * Create an SVG element with namespace.
 * @param tag - SVG element tag name
 * @returns The SVG element
 */
export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K
): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/**
 * Create an HTML element with optional attributes and children.
 * @param tag - HTML element tag name
 * @param attrs - Element attributes
 * @param children - Child elements or text
 * @returns The created element
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (attrs) {
    Object.entries(attrs).forEach(([key, value]) => {
      element.setAttribute(key, value);
    });
  }

  if (children) {
    children.forEach((child) => {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else {
        element.appendChild(child);
      }
    });
  }

  return element;
}

/**
 * Remove all children from an element.
 * @param element - Element to clear
 */
export function clearElement(element: Element): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Add event listener with automatic cleanup.
 * @param element - Target element
 * @param event - Event type
 * @param handler - Event handler
 * @returns Cleanup function
 */
export function addEventHandler<K extends keyof HTMLElementEventMap>(
  element: HTMLElement,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void
): () => void {
  element.addEventListener(event, handler);
  return () => element.removeEventListener(event, handler);
}

// Note: Theme functions (isDarkMode, setTheme, toggleTheme) are in @/state/theme.ts
// Use that module for theme management to avoid duplication.

/**
 * Show/hide an element by setting display style.
 * @param element - Element to show/hide
 * @param visible - Whether to show the element
 * @param display - Display style when visible (default: 'block')
 */
export function setVisible(
  element: HTMLElement | null,
  visible: boolean,
  display = 'block'
): void {
  if (element) {
    element.style.display = visible ? display : 'none';
  }
}

/**
 * Add/remove a CSS class based on condition.
 * @param element - Target element
 * @param className - Class name
 * @param condition - Whether to add or remove
 */
export function toggleClass(element: Element | null, className: string, condition: boolean): void {
  if (element) {
    element.classList.toggle(className, condition);
  }
}

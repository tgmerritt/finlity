/**
 * The status note under a connection (Settings and the Budget import card):
 * why Sync is off, or what needs care. Text goes in with textContent; the only
 * link is the fixed SimpleFIN Bridge address from statusNote.
 */

import type { StatusNote } from '@/utils/connections-render';

export function noteNode(note: StatusNote): HTMLElement {
  const p = document.createElement('p');
  p.className = 'connection-note';
  p.appendChild(document.createTextNode(note.text));
  if (note.href && note.linkText) {
    p.appendChild(document.createTextNode(' '));
    const a = document.createElement('a');
    a.className = 'connection-note-link';
    a.href = note.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = note.linkText;
    p.appendChild(a);
  }
  return p;
}

/**
 * Run a sync with its button disabled and aria-busy, so a second click cannot
 * start another walk. Afterwards the button is enabled again only if `canSync`
 * (a blocked connection stays disabled) and it is still on the page.
 */
export async function whileBusy(
  btn: HTMLButtonElement,
  canSync: boolean,
  run: () => Promise<void>
): Promise<void> {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    await run();
  } finally {
    if (btn.isConnected) {
      btn.removeAttribute('aria-busy');
      btn.disabled = !canSync;
    }
  }
}

/**
 * Settings page sections: a sticky index on desktop (with the section in view
 * highlighted) and an accordion on phones (768px and below).
 */

const PHONE_QUERY = '(max-width: 768px)';

function sections(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#tab-settings .settings-section'));
}

function visibleSections(): HTMLElement[] {
  return sections().filter((s) => !s.classList.contains('hidden'));
}

function headerOf(section: HTMLElement): HTMLButtonElement | null {
  return section.querySelector<HTMLButtonElement>('.settings-section-header');
}

function bodyOf(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('.settings-section-body');
}

function linkFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#settings-index [data-section="${id}"]`);
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * Open state of each section as the user left it. Null until the user first
 * opens or closes a section on a phone: until then the phone layout is the
 * default of "first visible section open". Kept across breakpoint changes so
 * rotating or resizing does not collapse what the user opened.
 */
let savedOpen: Map<string, boolean> | null = null;

/** Record a user driven open/close, snapshotting the current states on the first one. */
function setOpenByUser(section: HTMLElement, open: boolean): void {
  if (!savedOpen) {
    savedOpen = new Map(sections().map((s) => [s.id, s.classList.contains('is-open')]));
  }
  savedOpen.set(section.id, open);
  setOpen(section, open);
}

function setOpen(section: HTMLElement, open: boolean): void {
  const header = headerOf(section);
  const body = bodyOf(section);
  if (header) header.setAttribute('aria-expanded', String(open));
  if (body) body.hidden = !open;
  section.classList.toggle('is-open', open);
}

function setActive(id: string): void {
  document.querySelectorAll<HTMLElement>('#settings-index .settings-index-link').forEach((link) => {
    const active = link.dataset.section === id;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
}

/** Put every section into the right state for the current width. */
export function applySettingsLayoutMode(): void {
  const phone = isPhone();
  visibleSections().forEach((section, i) => {
    const header = headerOf(section);
    if (phone) {
      header?.removeAttribute('tabindex');
      header?.removeAttribute('aria-disabled');
      header?.removeAttribute('role');
      header?.setAttribute('aria-controls', `${section.id}-body`);
      setOpen(section, savedOpen ? (savedOpen.get(section.id) ?? false) : i === 0);
    } else {
      // The button is only a heading label here; keep it out of the
      // accessibility tree's interactive controls ("button, dimmed").
      header?.removeAttribute('aria-expanded');
      header?.removeAttribute('aria-controls');
      header?.removeAttribute('aria-disabled');
      header?.setAttribute('role', 'presentation');
      header?.setAttribute('tabindex', '-1');
      const body = bodyOf(section);
      if (body) body.hidden = false;
      section.classList.remove('is-open');
    }
  });
}

/**
 * Hide a section (and its index link) when every card in it is hidden, e.g.
 * by the hosted-mode restrictions. Call again after cards are hidden or shown.
 */
export function refreshSettingsSectionVisibility(): void {
  sections().forEach((section) => {
    const cards = Array.from(section.querySelectorAll<HTMLElement>('.card'));
    const allHidden = cards.length > 0 && cards.every((c) => c.classList.contains('hidden'));
    section.classList.toggle('hidden', allHidden);
    linkFor(section.id)?.classList.toggle('hidden', allHidden);
  });
  applySettingsLayoutMode();
}

function toggleSection(section: HTMLElement): void {
  if (!isPhone()) return;
  setOpenByUser(section, !section.classList.contains('is-open'));
}

/** While a smooth scroll from an index click runs, ignore observer highlights. */
let scrollLock = false;
let scrollLockTimer: ReturnType<typeof setTimeout> | undefined;

function lockHighlight(): void {
  scrollLock = true;
  clearTimeout(scrollLockTimer);
  scrollLockTimer = setTimeout(() => {
    scrollLock = false;
  }, 1200);
}

/** Open the section containing el when it is collapsed (phone accordion). */
export function revealInSettings(el: HTMLElement): void {
  const section = el.closest<HTMLElement>('.settings-section');
  if (section && isPhone() && !section.classList.contains('is-open')) setOpenByUser(section, true);
}

/** Scroll to a settings section, opening it first on phones, and focus it. */
export function goToSection(id: string): void {
  const section = document.getElementById(id);
  if (!section) return;
  if (isPhone() && !section.classList.contains('is-open')) setOpenByUser(section, true);
  lockHighlight();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.tabIndex = -1;
  section.focus({ preventScroll: true });
  setActive(id);
}

function atPageBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
}

function onSettingsTab(): boolean {
  return document.body.classList.contains('on-settings');
}

function highlightLastAtBottom(): void {
  if (!onSettingsTab() || scrollLock || !atPageBottom()) return;
  const last = visibleSections().pop();
  if (last) setActive(last.id);
}

/** Aborts the listeners of the previous init so repeat calls do not stack them. */
let listeners: AbortController | null = null;

export function initSettingsSections(): void {
  listeners?.abort();
  clearTimeout(scrollLockTimer);
  scrollLock = false;
  savedOpen = null;
  const index = document.getElementById('settings-index');
  if (!index || sections().length === 0) return;

  const controller = new AbortController();
  listeners = controller;
  const { signal } = controller;

  sections().forEach((section) => {
    headerOf(section)?.addEventListener('click', () => toggleSection(section), { signal });
  });

  index.querySelectorAll<HTMLAnchorElement>('.settings-index-link').forEach((link) => {
    link.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        if (link.dataset.section) goToSection(link.dataset.section);
      },
      { signal }
    );
  });

  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(PHONE_QUERY);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => applySettingsLayoutMode(), { signal });
    }
  }

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).pop();
        if (hit && !scrollLock) setActive((hit.target as HTMLElement).id);
      },
      { rootMargin: '-10% 0px -75% 0px' }
    );
    sections().forEach((s) => observer.observe(s));
    signal.addEventListener('abort', () => observer.disconnect());
  }

  window.addEventListener('scroll', highlightLastAtBottom, { passive: true, signal });
  window.addEventListener(
    'scrollend',
    () => {
      if (onSettingsTab()) scrollLock = false;
    },
    { signal }
  );

  const first = visibleSections()[0];
  if (first) setActive(first.id);
  refreshSettingsSectionVisibility();
}

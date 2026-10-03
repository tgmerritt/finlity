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
      setOpen(section, i === 0);
    } else {
      header?.removeAttribute('aria-expanded');
      header?.setAttribute('tabindex', '-1');
      header?.setAttribute('aria-disabled', 'true');
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
  setOpen(section, !section.classList.contains('is-open'));
}

function goToSection(id: string): void {
  const section = document.getElementById(id);
  if (!section) return;
  if (isPhone() && !section.classList.contains('is-open')) setOpen(section, true);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setActive(id);
}

export function initSettingsSections(): void {
  const index = document.getElementById('settings-index');
  if (!index || sections().length === 0) return;

  sections().forEach((section) => {
    headerOf(section)?.addEventListener('click', () => toggleSection(section));
  });

  index.querySelectorAll<HTMLAnchorElement>('.settings-index-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (link.dataset.section) goToSection(link.dataset.section);
    });
  });

  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(PHONE_QUERY);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => applySettingsLayoutMode());
    }
  }

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).pop();
        if (hit) setActive((hit.target as HTMLElement).id);
      },
      { rootMargin: '-10% 0px -75% 0px' }
    );
    sections().forEach((s) => observer.observe(s));
  }

  const first = visibleSections()[0];
  if (first) setActive(first.id);
  refreshSettingsSectionVisibility();
}

#!/usr/bin/env python3
"""Layout regression checks for the Finlity dashboard.

Loads the dashboard at desktop and phone widths, in light and dark themes,
and reports overflow and truncation problems. Run against a local server in
demo mode:

    python scripts/check_layout.py --base-url http://127.0.0.1:8790

Requires Playwright: pip install playwright && playwright install chromium
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

WIDTHS = (1440, 900, 390, 360)
THEMES = ("light", "dark")
EXTRA_TABS = ("holdings", "projections", "settings", "taxes", "analysis", "budget")

CHECKS_JS = """
() => {
  const problems = [];
  const vw = window.innerWidth;

  const dashboardTab = document.getElementById('tab-dashboard');
  if (!dashboardTab || getComputedStyle(dashboardTab).display === 'none') {
    problems.push('dashboard tab not visible; checks did not run');
    return problems;
  }

  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls horizontally (${document.documentElement.scrollWidth}px > ${vw}px)`);
  }
  const hero = document.querySelector('#total-value');
  if (hero && hero.scrollWidth > hero.clientWidth + 1) {
    problems.push(`hero value truncated (${hero.scrollWidth}px in ${hero.clientWidth}px)`);
  }
  const main = document.querySelector('.main-content') || document.body;
  const mainWidth = main.getBoundingClientRect().width;
  if (vw <= 480) {
    document.querySelectorAll('#tab-dashboard .dash-cards .dash-card').forEach((card, i) => {
      const rendered = card.getBoundingClientRect().width > 0 && getComputedStyle(card).display !== 'none';
      if (!rendered) return;
      const w = card.getBoundingClientRect().width;
      if (w < mainWidth * 0.7) problems.push(`dashboard card ${i} too narrow on phone (${Math.round(w)}px)`);
    });
  }
  document.querySelectorAll('#tab-dashboard .card').forEach((card, i) => {
    const r = card.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) problems.push(`card ${i} overflows viewport (right edge ${Math.round(r.right)}px)`);
  });
  document.querySelectorAll('#tab-dashboard .js-plotly-plot').forEach((plot) => {
    const svg = plot.querySelector('.main-svg');
    const host = plot.parentElement;
    if (svg && host && svg.getBoundingClientRect().width > host.getBoundingClientRect().width + 2) {
      problems.push(`chart ${plot.id || '?'} wider than its container`);
    }
    const card = plot.closest('.card');
    if (svg && card && svg.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 2) {
      problems.push(`chart ${plot.id || '?'} taller than its card`);
    }
  });
  const fab = document.getElementById('global-chat-fab');
  if (fab && vw <= 480) {
    const f = fab.getBoundingClientRect();
    if (f.width > 48) problems.push(`chat button too large on phone (${Math.round(f.width)}px)`);
  }
  if (vw <= 768) {
    const bar = document.querySelector('.bottom-tabbar');
    const b = bar ? bar.getBoundingClientRect() : null;
    const barOk =
      !!bar &&
      getComputedStyle(bar).display !== 'none' &&
      getComputedStyle(bar).position === 'fixed' &&
      b.width > 0 &&
      b.height > 0 &&
      Math.abs(b.bottom - window.innerHeight) <= 1;
    if (!barOk) problems.push('bottom tab bar missing');
    if (barOk && fab) {
      const f = fab.getBoundingClientRect();
      const overlaps = f.left < b.right && f.right > b.left && f.top < b.bottom && f.bottom > b.top;
      if (overlaps) problems.push('chat button overlaps tab bar');
    }
  }
  return problems;
}
"""


# Checks for the non-dashboard tabs, run after switching to the tab the way a
# user does. Scoped to "#tab-<name>"; the argument is the tab name.
TAB_CHECKS_JS = """
(name) => {
  const problems = [];
  const vw = window.innerWidth;
  const tab = document.getElementById('tab-' + name);
  if (!tab || getComputedStyle(tab).display === 'none') {
    problems.push(`${name} tab not visible; checks did not run`);
    return problems;
  }
  if (name === 'settings' && vw <= 768) {
    // Phone Settings is an accordion: open every collapsed section so each
    // card is laid out and measured.
    tab.querySelectorAll('.settings-section-header[aria-expanded="false"]').forEach((h) => h.click());
  }
  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`${name}: page scrolls horizontally (${document.documentElement.scrollWidth}px > ${vw}px)`);
  }
  tab.querySelectorAll('.card').forEach((card, i) => {
    const r = card.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) problems.push(`${name}: card ${i} overflows viewport (right edge ${Math.round(r.right)}px)`);
    // body.on-settings sets overflow-x: clip, which hides page-level overflow
    // (documentElement.scrollWidth stays at the viewport), so measure the
    // content itself: a card whose content is wider than the viewport.
    if (name === 'settings' && r.width > 0 && card.scrollWidth > vw + 1) {
      problems.push(`${name}: card ${i} content is wider than the viewport (${card.scrollWidth}px > ${vw}px)`);
    }
  });
  return problems;
}
"""

DRAWER_JS = """
() => {
  const problems = [];
  const more = document.getElementById('bottom-tab-more');
  if (!more) return ['drawer check: More button missing'];
  more.click();
  const overlay = document.querySelector('.mobile-nav-overlay');
  const sidebar = document.getElementById('app-sidebar');
  const covered = (el) => {
    if (!el) return true;
    const r = el.getBoundingClientRect();
    // Sample near the right edge: the 280px drawer always covers the bar's
    // horizontal centre, so only the overlay (right side) can prove coverage.
    const top = document.elementFromPoint(el.id === 'global-chat-fab' ? r.left + r.width / 2 : r.right - 10, r.top + r.height / 2);
    return !!top && ((overlay && overlay.contains(top)) || (sidebar && sidebar.contains(top)));
  };
  if (!covered(document.getElementById('global-chat-fab'))) problems.push('drawer does not cover chat button');
  if (!covered(document.querySelector('.bottom-tabbar'))) problems.push('drawer does not cover tab bar');
  more.click();
  return problems;
}
"""


QUIET_JS = """
() => {
  const overlay = document.getElementById('loading-overlay');
  const overlayHidden =
    !overlay ||
    overlay.classList.contains('hidden') ||
    getComputedStyle(overlay).display === 'none' ||
    getComputedStyle(overlay).visibility === 'hidden';
  const toastShown = Array.from(document.querySelectorAll('.toast')).some((t) => {
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(t).visibility !== 'hidden';
  });
  return overlayHidden && !toastShown;
}
"""


def drawer_problems(page: Page, attempts: int = 3) -> list[str]:
    """Run the drawer check once the page is quiet. A background price refresh
    can show the loading overlay or a toast above the drawer while it samples,
    so wait for them to clear and retry the sample before reporting."""
    problems: list[str] = []
    for _ in range(attempts):
        try:
            page.wait_for_function(QUIET_JS, timeout=10000)
        except PlaywrightTimeoutError:
            pass
        page.wait_for_timeout(400)
        problems = page.evaluate(DRAWER_JS)
        if not problems:
            return []
    return problems


def open_dashboard(page: Page, base_url: str, theme: str, hosted: bool = False) -> None:
    # Each new_page() is a fresh context, so the app boots as a first-time
    # visitor. Boot always lands on the Dashboard and loads data, so no
    # localStorage priming is needed.

    # "load" rather than "networkidle": hosted mode keeps requests in flight
    # (CDN assets, background polling), so the network may never go idle.
    # Readiness is decided by the wait_for_function below.
    page.goto(base_url + "/", wait_until="load", timeout=60000)
    page.evaluate("t => document.documentElement.setAttribute('data-theme', t)", theme)

    if hosted:
        # Hosted (browser storage) mode has no server-side database, so
        # ensureLocalDatabaseReady() always finds IndexedDB empty on a fresh
        # context and blocks on the "open or create your portfolio database"
        # modal (onboarding.ts's showDatabaseGateModal). Click "Continue with
        # browser storage" when it appears so the app creates a new IndexedDB database, seeds the demo dataset
        # into it, and proceeds the same way a real hosted-mode user would.
        browser_storage_button = page.get_by_role(
            "button", name="Continue with browser storage", exact=False
        )
        try:
            browser_storage_button.wait_for(state="visible", timeout=10000)
        except PlaywrightTimeoutError:
            pass
        else:
            browser_storage_button.click()

    # Wait for the dashboard tab to actually be visible, for demo data to
    # have loaded (the hero stat shows a non-zero dollar amount), and for the
    # global loading overlay to be hidden, rather than relying on a fixed
    # sleep. Without the overlay check, a screenshot or the layout checks
    # below can run while "Loading data..." is still covering the page.
    page.wait_for_function(
        """() => {
          const tab = document.getElementById('tab-dashboard');
          if (!tab || getComputedStyle(tab).display === 'none') return false;
          const hero = document.querySelector('#total-value');
          // The hero fills in before the account list and the cards that load
          // their own data, so also wait for account rows and the on-track and
          // attention cards or screenshots can catch a half-rendered page.
          const accountRows = document.querySelectorAll('#account-groups .account-row').length;
          const onTrack = (document.getElementById('on-track-body')?.textContent || '').trim();
          const attention = (document.getElementById('attention-list')?.textContent || '').trim();
          const overlay = document.getElementById('loading-overlay');
          const overlayHidden =
            !overlay ||
            overlay.classList.contains('hidden') ||
            getComputedStyle(overlay).display === 'none' ||
            getComputedStyle(overlay).visibility === 'hidden';
          return (
            !!hero &&
            /\\$[1-9]/.test(hero.textContent || '') &&
            accountRows > 0 &&
            onTrack.length > 0 &&
            attention.length > 0 &&
            overlayHidden
          );
        }""",
        timeout=45000,
    )


def open_tab(page: Page, name: str, width: int) -> None:
    """Switch to a tab through its nav button: the bottom tab bar on phones
    (768px and below), the sidebar nav item otherwise."""
    if width <= 768 and page.locator(f'.bottom-tab[data-tab="{name}"]').count():
        page.locator(f'.bottom-tab[data-tab="{name}"]').click()
    elif width <= 768:
        # Tabs without a bottom-bar button (Settings) live in the More drawer.
        page.locator("#bottom-tab-more").click()
        page.locator(f'.nav-item[data-tab="{name}"]').click()
    else:
        page.locator(f'.nav-item[data-tab="{name}"]').click()
    page.wait_for_function(
        """n => {
          const tab = document.getElementById('tab-' + n);
          return !!tab && getComputedStyle(tab).display !== 'none';
        }""",
        arg=name,
        timeout=10000,
    )
    # Let tab-specific rendering settle (tables, charts) before measuring.
    page.wait_for_timeout(500)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8790")
    parser.add_argument("--screenshots", type=Path, default=None)
    parser.add_argument(
        "--hosted",
        action="store_true",
        help="Click through the 'open or create your portfolio database' modal "
        "(hosted/browser-storage mode) before running checks.",
    )
    parser.add_argument(
        "--tabs",
        default="dashboard",
        help="Comma-separated tabs to check (dashboard, holdings, projections, "
        "settings, taxes, analysis, budget). The dashboard checks always run; each extra tab is opened "
        "through its nav button and checked for overflow. Default: dashboard.",
    )
    args = parser.parse_args()
    extra_tabs = [t.strip() for t in args.tabs.split(",") if t.strip() and t.strip() != "dashboard"]
    unknown = [t for t in extra_tabs if t not in EXTRA_TABS]
    if unknown:
        parser.error(f"unknown tab(s): {', '.join(unknown)} (choose from dashboard, {', '.join(EXTRA_TABS)})")

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in WIDTHS:
            for theme in THEMES:
                page = browser.new_page(viewport={"width": width, "height": 900})

                def save_dashboard_shot(page: Page = page, width: int = width, theme: str = theme) -> None:
                    if args.screenshots:
                        args.screenshots.mkdir(parents=True, exist_ok=True)
                        page.screenshot(path=str(args.screenshots / f"dashboard-{width}-{theme}.png"), full_page=True)

                try:
                    open_dashboard(page, args.base_url, theme, hosted=args.hosted)
                except PlaywrightTimeoutError:
                    failures.append(f"{width}px {theme}: dashboard did not finish loading")
                    save_dashboard_shot()
                else:
                    for problem in page.evaluate(CHECKS_JS):
                        failures.append(f"{width}px {theme}: {problem}")
                    if width == 390:
                        for problem in drawer_problems(page):
                            failures.append(f"{width}px {theme}: {problem}")
                    save_dashboard_shot()
                    for tab in extra_tabs:
                        try:
                            open_tab(page, tab, width)
                        except PlaywrightTimeoutError:
                            failures.append(f"{width}px {theme}: {tab} tab did not open")
                            continue
                        for problem in page.evaluate(TAB_CHECKS_JS, tab):
                            failures.append(f"{width}px {theme}: {problem}")
                        if args.screenshots:
                            page.screenshot(path=str(args.screenshots / f"{tab}-{width}-{theme}.png"), full_page=True)
                page.close()
        browser.close()

    for failure in failures:
        print(failure)
    print(f"{len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

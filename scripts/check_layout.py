#!/usr/bin/env python3
"""Layout regression checks for the Finlity dashboard.

Loads the dashboard at desktop and phone widths, in light and dark themes,
and reports overflow and truncation problems. Run against a local server in
demo mode:

    python scripts/check_layout.py --base-url http://127.0.0.1:8790
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

WIDTHS = (1440, 390, 360)
THEMES = ("light", "dark")

CHECKS_JS = """
() => {
  const problems = [];
  const vw = window.innerWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls horizontally (${document.documentElement.scrollWidth}px > ${vw}px)`);
  }
  const hero = document.querySelector('.stat-card--hero .stat-value');
  if (hero && hero.scrollWidth > hero.clientWidth + 1) {
    problems.push(`hero value truncated (${hero.scrollWidth}px in ${hero.clientWidth}px)`);
  }
  const main = document.querySelector('.main-content') || document.body;
  const mainWidth = main.getBoundingClientRect().width;
  if (vw <= 480) {
    document.querySelectorAll('#tab-dashboard .stats-row .stat-card').forEach((card, i) => {
      const w = card.getBoundingClientRect().width;
      if (w < mainWidth * 0.7) problems.push(`stat card ${i} too narrow on phone (${Math.round(w)}px)`);
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
  });
  const fab = document.getElementById('global-chat-fab');
  if (fab && vw <= 480) {
    const f = fab.getBoundingClientRect();
    if (f.width > 48) problems.push(`chat button too large on phone (${Math.round(f.width)}px)`);
  }
  return problems;
}
"""


def open_dashboard(page: Page, base_url: str, theme: str) -> None:
    page.goto(base_url + "/", wait_until="networkidle", timeout=60000)
    page.evaluate("t => document.documentElement.setAttribute('data-theme', t)", theme)
    page.wait_for_timeout(3000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8790")
    parser.add_argument("--screenshots", type=Path, default=None)
    args = parser.parse_args()

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in WIDTHS:
            for theme in THEMES:
                page = browser.new_page(viewport={"width": width, "height": 900})
                open_dashboard(page, args.base_url, theme)
                for problem in page.evaluate(CHECKS_JS):
                    failures.append(f"{width}px {theme}: {problem}")
                if args.screenshots:
                    args.screenshots.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(args.screenshots / f"dashboard-{width}-{theme}.png"), full_page=True)
                page.close()
        browser.close()

    for failure in failures:
        print(failure)
    print(f"{len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Debug script to test demo mode toggle in a real browser using Playwright."""

import time
from playwright.sync_api import sync_playwright

def main():
    with sync_playwright() as p:
        # Launch browser in headless mode
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Collect console logs
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"{msg.type}: {msg.text}"))

        # Collect network requests
        api_responses = {}
        def handle_response(response):
            if '/api/' in response.url:
                try:
                    api_responses[response.url] = {
                        'status': response.status,
                        'body_preview': response.text()[:500] if response.status == 200 else None
                    }
                except:
                    pass
        page.on("response", handle_response)

        print("\n=== Step 1: Navigate to app ===")
        page.goto("http://localhost:8000")
        page.wait_for_load_state("networkidle")
        time.sleep(3)

        # Print API responses
        print("\n=== Step 2: API responses during page load ===")
        for url, data in api_responses.items():
            print(f"  {url}: status={data['status']}")
            if 'dashboard/data' in url and data['body_preview']:
                # Parse to show first account
                import json
                try:
                    d = json.loads(data['body_preview'] + '...')  # May be truncated
                except:
                    pass

        # Check demo mode status via API
        print("\n=== Step 3: Check demo mode status ===")
        demo_status = page.evaluate("""
            async () => {
                const resp = await fetch('/api/settings/demo-mode');
                return await resp.json();
            }
        """)
        print(f"Demo mode enabled: {demo_status.get('enabled')}")

        # Direct API call to dashboard/data
        print("\n=== Step 4: Direct API call to dashboard/data ===")
        dashboard_data = page.evaluate("""
            async () => {
                const resp = await fetch('/api/dashboard/data');
                const data = await resp.json();
                return data.summary.accounts.slice(0, 3).map(a => a.name);
            }
        """)
        print(f"API returns accounts: {dashboard_data}")

        # Check what's in the DOM
        print("\n=== Step 5: Check DOM content ===")
        try:
            page.wait_for_selector("#account-groups .account-row", timeout=5000)
            names = page.locator("#account-groups .account-row-name").all_inner_texts()[:10]
            print(f"DOM account rows: {names}")
        except Exception as e:
            print(f"Could not read account rows: {e}")

        # Check if there's a loading overlay blocking
        print("\n=== Step 6: Check for overlays ===")
        loading = page.locator(".loading-overlay, .modal, [class*='loading']").all()
        print(f"Found {len(loading)} loading/modal elements")

        # Check currentPositions variable
        print("\n=== Step 7: Check JS variables ===")
        try:
            current_positions = page.evaluate("window.currentPositions ? currentPositions.slice(0,3).map(p => p.account) : 'undefined'")
            print(f"currentPositions accounts: {current_positions}")
        except Exception as e:
            print(f"Error getting currentPositions: {e}")

        # Print console logs
        print("\n=== Console logs ===")
        for log in console_logs[:20]:
            print(f"  {log}")

        browser.close()
        print("\n=== Done ===")

if __name__ == "__main__":
    main()

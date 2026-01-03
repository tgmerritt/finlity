#!/usr/bin/env python3
"""
UI testing script using Playwright to test all pages and functionality.
"""

import asyncio
import sys
import time
import urllib.request
import urllib.error
from playwright.async_api import async_playwright, Page

BASE_URL = "http://localhost:8000"


def wait_for_server(url: str, timeout: int = 60, interval: float = 1.0) -> bool:
    """Wait for the server to be ready by polling the health endpoint.

    Args:
        url: Base URL of the server
        timeout: Maximum seconds to wait
        interval: Seconds between retries

    Returns:
        True if server is ready, False if timeout
    """
    start_time = time.time()
    health_url = f"{url}/api/portfolio"  # Use a simple API endpoint

    print(f"Waiting for server at {url}...")

    while time.time() - start_time < timeout:
        try:
            req = urllib.request.Request(health_url, method='GET')
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.status == 200:
                    print(f"Server is ready! (took {time.time() - start_time:.1f}s)")
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionRefusedError):
            pass

        elapsed = time.time() - start_time
        print(f"  Waiting... ({elapsed:.0f}s/{timeout}s)")
        time.sleep(interval)

    print(f"Server did not become ready within {timeout}s")
    return False


async def close_any_modals(page: Page):
    """Close any open modals."""
    # Try various ways to close modals
    try:
        # Press Escape
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(200)

        # Click modal backdrop if visible
        backdrop = page.locator('.modal-backdrop:visible')
        if await backdrop.count() > 0:
            await backdrop.first.click(force=True)
            await page.wait_for_timeout(200)

        # Click close buttons
        for selector in ['.modal-close:visible', 'button:has-text("Cancel"):visible', 'button:has-text("Close"):visible']:
            btn = page.locator(selector)
            if await btn.count() > 0:
                await btn.first.click(force=True)
                await page.wait_for_timeout(200)
    except Exception:
        pass


async def test_dashboard(page: Page):
    """Test the Dashboard tab."""
    print("\n=== Testing Dashboard ===")

    await close_any_modals(page)
    await page.click('button[data-tab="dashboard"]')
    await page.wait_for_timeout(1500)

    # Check key elements exist
    total_value = await page.locator('#total-value').text_content()
    print(f"  Total Value: {total_value}")

    # Check for retirement metrics
    retirement_value = page.locator('#retirement-value')
    if await retirement_value.count() > 0:
        val = await retirement_value.text_content()
        print(f"  Retirement Value: {val}")

    return True


async def test_holdings(page: Page):
    """Test the Holdings tab."""
    print("\n=== Testing Holdings ===")

    await close_any_modals(page)
    await page.click('button[data-tab="holdings"]')
    await page.wait_for_timeout(2000)

    # Check positions exist
    positions_body = page.locator('#positions-table tbody tr, .positions-table tbody tr')
    positions = await positions_body.count()
    print(f"  Positions shown: {positions}")

    # Test account filters
    account_filters = page.locator('.account-filter input[type="checkbox"]')
    filter_count = await account_filters.count()
    print(f"  Account filters: {filter_count}")

    return True


async def test_analysis(page: Page):
    """Test the Analysis tab."""
    print("\n=== Testing Analysis ===")

    await close_any_modals(page)
    await page.click('button[data-tab="analysis"]')
    await page.wait_for_timeout(2500)

    # Check allocation data loaded
    total_val = page.locator('.allocation-total, #allocation-total-value')
    if await total_val.count() > 0:
        print("  Allocation data present")

    # Check for charts
    charts = await page.locator('canvas, .plotly-graph-div, svg.main-svg').count()
    print(f"  Charts found: {charts}")

    return True


async def test_projections(page: Page):
    """Test the Projections tab."""
    print("\n=== Testing Projections ===")

    await close_any_modals(page)
    await page.click('button[data-tab="projections"]')
    await page.wait_for_timeout(1500)

    # Check form fields exist
    current_age = page.locator('#projection-current-age, input[name="current_age"]')
    if await current_age.count() > 0:
        print("  Current age field present")

    retirement_age = page.locator('#projection-retirement-age, input[name="retirement_age"]')
    if await retirement_age.count() > 0:
        print("  Retirement age field present")

    # Check run button
    run_btn = page.locator('button:has-text("Run"), button:has-text("Calculate")')
    if await run_btn.count() > 0:
        print("  Run button present")

    return True


async def test_taxes(page: Page):
    """Test the Taxes tab."""
    print("\n=== Testing Taxes ===")

    await close_any_modals(page)
    await page.click('button[data-tab="taxes"]')
    await page.wait_for_timeout(1500)

    # Check for sub-tabs
    sub_tabs = page.locator('.tab-group button, .sub-tab')
    sub_count = await sub_tabs.count()
    print(f"  Sub-tabs found: {sub_count}")

    return True


async def test_budget(page: Page):
    """Test the Budget/Expenses & Income section."""
    print("\n=== Testing Budget (Expenses & Income) ===")

    await close_any_modals(page)

    # Navigate to taxes first
    await page.click('button[data-tab="taxes"]')
    await page.wait_for_timeout(1000)

    # Click on Income & Taxes sub-tab
    income_tab = page.locator('button:has-text("Income & Taxes"), button:has-text("Expenses & Income")')
    if await income_tab.count() > 0:
        await income_tab.first.click()
        await page.wait_for_timeout(1500)
        print("  Clicked Income & Taxes tab")

    # Check if income sources section exists
    has_income = await page.locator('text=Income Sources').count() > 0
    print(f"  Income Sources section: {has_income}")

    # Try clicking "Add Income" button
    add_income_btn = page.locator('button:has-text("Add Income")')
    if await add_income_btn.count() > 0:
        print("  Found 'Add Income' button, clicking...")
        await add_income_btn.first.click()
        await page.wait_for_timeout(800)

        # Check if modal opened
        modal_visible = await page.locator('#budget-modal:visible, .modal:visible').count() > 0
        print(f"  Modal opened: {modal_visible}")

        if modal_visible:
            # Fill the form using the actual modal field IDs
            # Name field
            await page.fill('#income-name', 'Test Job')
            print("  Filled name: Test Job")

            # Annual gross income
            await page.fill('#income-gross', '85000')
            print("  Filled gross income: 85000")

            # Save - button has ID modal-save-btn
            save_btn = page.locator('#modal-save-btn')
            if await save_btn.count() > 0:
                await save_btn.click()
                await page.wait_for_timeout(1000)
                print("  Clicked Save")

    await close_any_modals(page)
    return True


async def test_settings(page: Page):
    """Test the Settings tab."""
    print("\n=== Testing Settings ===")

    await close_any_modals(page)
    await page.wait_for_timeout(500)

    await page.click('button[data-tab="settings"]', force=True)
    await page.wait_for_timeout(1500)

    # Check for settings sections
    personal = await page.locator('text=Personal Settings, text=Personal Information').count() > 0
    print(f"  Personal Settings section: {personal}")

    targets = await page.locator('text=Target Allocation, text=Allocation Targets').count() > 0
    print(f"  Target Allocation section: {targets}")

    api_keys = await page.locator('text=API Keys, text=API Configuration').count() > 0
    print(f"  API Keys section: {api_keys}")

    return True


async def test_global_chat(page: Page):
    """Test the global chat modal (Cmd+K)."""
    print("\n=== Testing Global Chat ===")

    await close_any_modals(page)
    await page.wait_for_timeout(300)

    # Open chat with keyboard shortcut
    await page.keyboard.press("Meta+k")
    await page.wait_for_timeout(500)

    # Check if modal opened
    chat_modal = page.locator('#global-chat-modal')
    is_visible = await chat_modal.is_visible()
    print(f"  Chat modal opened: {is_visible}")

    if is_visible:
        # Type a test message
        chat_input = page.locator('#global-chat-input')
        if await chat_input.count() > 0:
            await chat_input.fill("What is my portfolio value?")
            print("  Typed test message")

        # Close the modal
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)

    return True


async def test_add_position_modal(page: Page):
    """Test the Add Position modal."""
    print("\n=== Testing Add Position Modal ===")

    await close_any_modals(page)
    await page.click('button[data-tab="holdings"]', force=True)
    await page.wait_for_timeout(1000)

    # Click Add Position button
    add_btn = page.locator('button:has-text("Add Position")')
    if await add_btn.count() > 0:
        await add_btn.first.click()
        await page.wait_for_timeout(500)

        modal_visible = await page.locator('.modal:visible, #add-position-modal:visible').count() > 0
        print(f"  Add Position modal opened: {modal_visible}")

        await close_any_modals(page)

    return True


async def main():
    """Run all UI tests."""
    print("=" * 60)
    print("PORTFOLIO ANALYZER UI TESTS")
    print("=" * 60)

    # Wait for server to be ready before starting tests
    if not wait_for_server(BASE_URL, timeout=60):
        print("\nERROR: Server failed to start. Aborting tests.")
        return 1

    console_errors = []
    network_errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await context.new_page()

        # Collect console errors
        page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
        page.on("pageerror", lambda err: console_errors.append(f"Page error: {err}"))

        # Collect network errors (500s, 404s)
        page.on("response", lambda response: network_errors.append(f"{response.status} {response.url}") if response.status >= 400 else None)

        try:
            # Load the page
            print(f"\nLoading {BASE_URL}...")
            await page.goto(BASE_URL)
            await page.wait_for_timeout(3000)  # Wait for initial load

            # Check if page loaded
            title = await page.title()
            print(f"Page title: {title}")

            # Run all tests
            tests = [
                ("Dashboard", test_dashboard),
                ("Holdings", test_holdings),
                ("Analysis", test_analysis),
                ("Projections", test_projections),
                ("Taxes", test_taxes),
                ("Budget", test_budget),
                ("Settings", test_settings),
                ("Add Position Modal", test_add_position_modal),
                ("Global Chat", test_global_chat),
            ]

            passed = 0
            failed = 0

            for name, test_func in tests:
                try:
                    result = await test_func(page)
                    if result:
                        passed += 1
                        print(f"  ✓ {name} PASSED")
                    else:
                        failed += 1
                        print(f"  ✗ {name} FAILED")
                except Exception as e:
                    failed += 1
                    print(f"  ✗ {name} ERROR: {str(e)[:100]}")

            # Report results
            print("\n" + "=" * 60)
            print("TEST RESULTS")
            print("=" * 60)
            print(f"Passed: {passed}")
            print(f"Failed: {failed}")

            if console_errors:
                print(f"\n⚠ Console Errors ({len(console_errors)}):")
                for err in console_errors[:10]:
                    print(f"  - {err[:150]}")
            else:
                print("\n✓ No console errors detected!")

            if network_errors:
                print(f"\n⚠ Network Errors ({len(network_errors)}):")
                for err in set(network_errors[:10]):  # Dedupe
                    print(f"  - {err}")
            else:
                print("✓ No network errors detected!")

        finally:
            await browser.close()

    return 0 if failed == 0 and len(console_errors) == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

import asyncio
import json
import os
from playwright.async_api import async_playwright

async def get_options_for_selector(page, trigger_selector, search_term=""):
    print(f"Triggering select2: {trigger_selector}")
    trigger = await page.wait_for_selector(trigger_selector)
    await trigger.click()
    await asyncio.sleep(1.5)
    
    # Locate active search input if any
    search_input = await page.query_selector(".select2-drop-active .select2-input, input.select2-input")
    if search_input and search_term:
        await search_input.fill(search_term)
        await asyncio.sleep(1.5)
        
    # Check if there are options visible
    results = await page.query_selector_all(".select2-drop-active .select2-result-label")
    options = []
    for res in results:
        options.append(await res.inner_text())
        
    print(f"  Found {len(options)} options for {trigger_selector}: {options[:5]}")
    
    # Close dropdown
    await page.keyboard.press("Escape")
    await asyncio.sleep(1)
    return options

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Enable response monitoring to capture specific data URLs
        page.on("response", lambda r: print(f"Response: {r.url} -> Status {r.status}") if "ssb" in r.url and "get" in r.url else None)

        print("Navigating...")
        await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
        await page.wait_for_load_state("networkidle")
        
        # Select term
        term_trigger = await page.wait_for_selector("#s2id_txt_term")
        await term_trigger.click()
        await asyncio.sleep(1)
        search_input = await page.wait_for_selector(".select2-drop-active .select2-input")
        await search_input.fill("Fall 2026")
        await asyncio.sleep(1.5)
        
        results = await page.query_selector_all(".select2-drop-active .select2-result-label")
        for res in results:
            text = await res.inner_text()
            if text.strip() == "Fall 2026":
                await res.click()
                break
        await asyncio.sleep(1)
        
        go_btn = await page.wait_for_selector("#term-go")
        await go_btn.click()
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        # Advanced search
        adv_toggle = await page.wait_for_selector("#advanced-search-link")
        await adv_toggle.click()
        await asyncio.sleep(1.5)
        
        # Test filters
        # 1. College
        await get_options_for_selector(page, "#s2id_txt_college")
        # 2. Instructional Method
        await get_options_for_selector(page, "#s2id_txt_instructionalMethod")
        # 3. Campus
        await get_options_for_selector(page, "#s2id_txt_campus")
        # 4. Department
        await get_options_for_selector(page, "#s2id_txt_department")
        # 5. Schedule Type
        await get_options_for_selector(page, "#s2id_txt_scheduleType")
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

import asyncio
import json
import os
from playwright.async_api import async_playwright

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\search_verification_call.json"
captured_search_url = None
captured_search_status = None

async def handle_response(response):
    global captured_search_url, captured_search_status
    url = response.url
    if "ssb" in url.lower() or "studentregistrationssb" in url.lower():
        if not any(url.endswith(ext) for ext in [".js", ".css", ".png", ".jpg", ".woff", ".woff2", ".ico", ".svg", ".gif"]):
            print(f"Captured response: {response.request.method} {url} -> Status {response.status}")
    if "searchResults/searchResults" in url:
        captured_search_url = url
        captured_search_status = response.status
        print(f"Captured Target Search Call: {url} -> Status {response.status}")

async def select_select2_option(page, container_selector, search_text, expected_option_text):
    print(f"Selecting select2: {container_selector} -> {search_text}")
    container = await page.wait_for_selector(container_selector)
    choices = await container.query_selector(".select2-choices")
    is_multi = choices is not None
    
    if is_multi:
        search_input = await container.wait_for_selector("input.select2-input")
        await search_input.click()
    else:
        await container.click()
        search_input = await page.wait_for_selector(".select2-drop-active .select2-input, .select2-input")
        
    await asyncio.sleep(1)
    await search_input.fill("")
    await search_input.type(search_text)
    await asyncio.sleep(2)
    
    await page.wait_for_selector(".select2-drop-active .select2-result-label")
    results = await page.query_selector_all(".select2-drop-active .select2-result-label")
    
    print(f"Found {len(results)} options in dropdown:")
    for idx, res in enumerate(results):
        text = await res.inner_text()
        print(f"  Option {idx}: '{text}'")
        
    # 1. Exact match
    for res in results:
        text = await res.inner_text()
        if text.strip().lower() == expected_option_text.lower():
            print(f"Clicking exact match option: '{text}'")
            await res.click()
            await asyncio.sleep(1)
            return True
            
    # 2. Substring match
    for res in results:
        text = await res.inner_text()
        if expected_option_text.lower() in text.lower() or text.lower() in expected_option_text.lower():
            print(f"Clicking substring match option: '{text}'")
            await res.click()
            await asyncio.sleep(1)
            return True
            
    if results:
        text = await results[0].inner_text()
        print(f"Falling back to option: '{text}'")
        await results[0].click()
        await asyncio.sleep(1)
        return True
    return False

async def main():
    global captured_search_url, captured_search_status
    async with async_playwright() as p:
        print("Launching browser...")
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        page.on("response", handle_response)
        
        print("1. Term selection...")
        await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
        await page.wait_for_load_state("networkidle")
        
        await select_select2_option(page, "#s2id_txt_term", "Fall 2026", "Fall 2026")
        
        go_btn = await page.wait_for_selector("#term-go")
        await go_btn.click()
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        print("2. Search Page - Fill Basic Criteria First...")
        # Subject: ACC (Accounting)
        await select_select2_option(page, "#s2id_txt_subject", "ACC", "Accounting")
        
        # Course Number: 11
        print("Filling course number...")
        await page.fill("#txt_courseNumber", "11")
        
        print("3. Toggling Advanced Search...")
        adv_toggle = await page.wait_for_selector("#advanced-search-link")
        await adv_toggle.click()
        await asyncio.sleep(2)
        
        # Campus: Hawaii Community College
        await select_select2_option(page, "#s2id_txt_campus", "Hawaii", "Hawaii Community College")
        
        # Keywords
        print("Filling keywords...")
        await page.fill("#txt_keywordlike", "1")
        await page.fill("#txt_keywordall", "1")
        await page.fill("#txt_keywordany", "1")
        await page.fill("#txt_keywordexact", "1")
        await page.fill("#txt_keywordwithout", "1")
        
        # Level: Select Level
        await select_select2_option(page, "#s2id_txt_level", "Credit", "Credit")
        
        # Instructional Method: Distance - Completely Online
        await select_select2_option(page, "#s2id_txt_instructionalMethod", "Distance", "Distance - Completely Online")
        
        # Duration unit value
        print("Filling duration and credits...")
        await page.fill("#txt_durationunit_value", "1")
        
        # Course Title
        await page.fill("#txt_courseTitle", "1")
        
        # Course number range
        await page.fill("#txt_course_number_range", "1")
        await page.fill("#txt_course_number_range_to", "1")
        
        # Credit hour range
        await page.fill("#txt_credithourlow", "1")
        await page.fill("#txt_credithourhigh", "1")
        
        # Checkboxes (meeting days)
        print("Checking day checkboxes...")
        for i in range(7):
            checkbox = await page.wait_for_selector(f"#chk_include_{i}")
            is_checked = await checkbox.is_checked()
            if not is_checked:
                await checkbox.click()
                
        # Time ranges
        print("Selecting time dropdowns...")
        await page.select_option("#select_start_hour", "11")
        await page.select_option("#select_start_min", "55")
        await page.select_option("#select_start_ampm", "AM")
        await page.select_option("#select_end_hour", "12")
        await page.select_option("#select_end_min", "40")
        await page.select_option("#select_end_ampm", "PM")
        
        # Open only
        print("Checking open only checkbox...")
        open_only = await page.wait_for_selector("#chk_open_only")
        if not await open_only.is_checked():
            await open_only.click()
            
        print("4. Executing search...")
        search_go = await page.wait_for_selector("#search-go")
        await search_go.click()
        
        # Wait for results or timeout
        await asyncio.sleep(5)
        
        # Take a screenshot to visually verify
        screenshot_path = r"C:\Users\Ethan\.gemini\antigravity\brain\8c504a74-aa2d-45b9-8716-e651aab8f231\param_verification_results.png"
        await page.screenshot(path=screenshot_path)
        print(f"Screenshot saved to {screenshot_path}")
        
        # Save verification details to JSON
        verification_data = {
            "search_url": captured_search_url,
            "status": captured_search_status
        }
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            json.dump(verification_data, f, indent=2)
            
        print(f"Verification details saved to {LOG_FILE}")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

import asyncio
import json
import os
import re
from playwright.async_api import async_playwright

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"
SCREENSHOT_FILE = r"C:\Users\Ethan\.gemini\antigravity\brain\8c504a74-aa2d-45b9-8716-e651aab8f231\results.png"
captured_calls = []

def log_request_response(request, response_data, status, headers):
    try:
        post_data = request.post_data
        if post_data:
            try:
                post_data = json.loads(post_data)
            except Exception:
                pass
    except Exception:
        post_data = None

    url = request.url
    if "ssb" in url.lower() or "studentregistrationssb" in url.lower():
        if any(url.endswith(ext) for ext in [".js", ".css", ".png", ".jpg", ".woff", ".woff2", ".ico", ".svg", ".gif"]):
            return

        call_info = {
            "method": request.method,
            "url": url,
            "request_headers": dict(request.headers),
            "request_payload": post_data,
            "status": status,
            "response_headers": dict(headers),
            "response_body": response_data
        }
        captured_calls.append(call_info)
        print(f"Captured: {request.method} {url} -> Status {status}")

async def handle_response(response):
    request = response.request
    body = ""
    try:
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                body = await response.json()
            except Exception:
                body = await response.text()
        elif "text" in content_type or "xml" in content_type:
            body = await response.text()
    except Exception:
        # Ignore read errors for redirect/aborted requests, but still log the metadata
        pass
    
    try:
        log_request_response(request, body, response.status, response.headers)
    except Exception as e:
        print(f"Error logging response: {e}")

async def save_captured_calls():
    print(f"Saving {len(captured_calls)} captured calls to {LOG_FILE}...")
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(captured_calls, f, indent=2)
    print("Logs saved successfully.")

async def select_select2_option(page, container_selector, search_text, expected_option_text):
    print(f"Opening select2: {container_selector}")
    container = await page.wait_for_selector(container_selector)
    choices = await container.query_selector(".select2-choices")
    is_multi = choices is not None
    
    await container.click()
    await asyncio.sleep(1)
    
    if is_multi:
        search_input = await container.wait_for_selector("input.select2-input")
    else:
        search_input = await page.wait_for_selector(".select2-drop-active .select2-input, .select2-input")
        
    print(f"Typing '{search_text}' in search input...")
    await search_input.fill("")
    await search_input.type(search_text)
    await asyncio.sleep(2)
    
    await page.wait_for_selector(".select2-drop-active .select2-result-label")
    results = await page.query_selector_all(".select2-drop-active .select2-result-label")
    
    print(f"Found {len(results)} options in dropdown:")
    for idx, res in enumerate(results):
        text = await res.inner_text()
        print(f"  Option {idx}: '{text}'")
        
    for res in results:
        text = await res.inner_text()
        if text.strip().lower() == expected_option_text.lower():
            print(f"Clicking exact match option: '{text}'")
            await res.click()
            await asyncio.sleep(1)
            return True
            
    for res in results:
        text = await res.inner_text()
        if expected_option_text.lower() in text.lower() or text.lower() in expected_option_text.lower():
            print(f"Clicking partial/contains match option: '{text}'")
            await res.click()
            await asyncio.sleep(1)
            return True
            
    if results:
        text = await results[0].inner_text()
        print(f"Target not found. Clicking first option as fallback: '{text}'")
        await results[0].click()
        await asyncio.sleep(1)
        return True
        
    print("No options found, pressing Escape to close dropdown.")
    await page.keyboard.press("Escape")
    await asyncio.sleep(1)
    return False

async def main():
    async with async_playwright() as p:
        print("Launching browser...")
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-web-security"]
        )
        context = await browser.new_context()
        page = await context.new_page()

        # Listen to responses
        page.on("response", handle_response)

        try:
            # 1. Navigate to termSelection
            print("Navigating to termSelection page...")
            await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(3)

            # Select Term "Fall 2026"
            success = await select_select2_option(page, "#s2id_txt_term", "Fall 2026", "Fall 2026")
            if not success:
                print("Trying Fall 2025...")
                await select_select2_option(page, "#s2id_txt_term", "Fall 2025", "Fall 2025")

            # Click Go
            go_btn = await page.wait_for_selector("#term-go")
            print("Clicking Go button...")
            await go_btn.click()
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(3)

            # 2. Basic Search Page
            print("Current URL:", page.url)
            
            # Select Subject: ICS
            await select_select2_option(page, "#s2id_txt_subject", "ICS", "Information& Computer Sciences")
            
            # Type Course Number: 111
            print("Typing course number '111'...")
            course_num_input = await page.wait_for_selector("#txt_courseNumber")
            await course_num_input.fill("111")
            await asyncio.sleep(1)
            
            # Click search-go
            search_go = await page.wait_for_selector("#search-go")
            print("Clicking search-go...")
            await search_go.click()
            
            # Wait for some time to let results load
            print("Waiting for results table to load...")
            await asyncio.sleep(5)
            
            # Take screenshot of the results page
            print(f"Taking screenshot of results page and saving to {SCREENSHOT_FILE}...")
            os.makedirs(os.path.dirname(SCREENSHOT_FILE), exist_ok=True)
            await page.screenshot(path=SCREENSHOT_FILE)
            
            # --- SCRAPE ADDITIONAL INTERACTABLE ELEMENTS ---
            # Click the instructor email link to trigger contactCard retrieval
            instructor_link = await page.wait_for_selector("a.email")
            print("Clicking instructor link to trigger contactCard retrieval...")
            await instructor_link.click()
            await asyncio.sleep(3)
            
            # Close the contact card popup by pressing Escape
            await page.keyboard.press("Escape")
            await asyncio.sleep(1)

            # Click the course title link to open details modal
            title_link = await page.wait_for_selector("a.section-details-link")
            print("Clicking course title link to open details modal...")
            await title_link.click()
            await asyncio.sleep(3)

            # List of tab texts to click in the modal to trigger sub-requests
            tab_texts = [
                "Class Details",
                "Bookstore Links",
                "Course Description",
                "Syllabus",
                "Attributes",
                "Restrictions",
                "Instructor/Meeting Times",
                "Enrollment/Waitlist",
                "Corequisites",
                "Prerequisites",
                "Cross Listed Courses",
                "Linked Sections",
                "Fees",
                "Catalog"
            ]

            for tab_text in tab_texts:
                tab_link = await page.query_selector(f"a:has-text('{tab_text}'), li a:has-text('{tab_text}')")
                if tab_link:
                    print(f"Clicking modal tab: '{tab_text}'...")
                    await tab_link.click()
                    await asyncio.sleep(2)
                else:
                    print(f"Could not find modal tab: '{tab_text}'")

            # Close details modal
            print("Closing details modal...")
            await page.keyboard.press("Escape")
            await asyncio.sleep(1)
            # ------------------------------------------------

            # Find the "Search Again" button and click it to perform the advanced search
            back_btn = await page.wait_for_selector("#search-again-button")
            print("Clicking 'Search Again' button...")
            await back_btn.click()
            await asyncio.sleep(3)

            # Toggle Advanced Search
            adv_toggle = await page.wait_for_selector("#advanced-search-link")
            print("Clicking Advanced Search toggle...")
            await adv_toggle.click()
            await asyncio.sleep(2)

            # Clear course number
            course_num_input = await page.wait_for_selector("#txt_courseNumber")
            await course_num_input.fill("")
            await asyncio.sleep(1)

            # Campus: Manoa (University of Hawaii at Manoa)
            await select_select2_option(page, "#s2id_txt_campus", "Manoa", "Manoa")
            
            # Instructional Method: Distance - Completely Online
            await select_select2_option(page, "#s2id_txt_instructionalMethod", "Distance", "Distance - Completely Online")

            # Click Search Go
            search_go = await page.wait_for_selector("#search-go")
            print("Clicking search-go for advanced search...")
            await search_go.click()
            
            # Wait for results
            print("Waiting for advanced search results...")
            await asyncio.sleep(5)
            
            # Take screenshot of advanced search results
            await page.screenshot(path=SCREENSHOT_FILE.replace("results.png", "advanced_results.png"))
            print("Advanced Search results loaded. Done.")

        except Exception as e:
            print(f"Execution error: {e}")
            raise e
        finally:
            # Always save captured calls
            await save_captured_calls()
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

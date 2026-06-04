import asyncio
import json
import os
import urllib.parse
from playwright.async_api import async_playwright

VERIFICATION_REPORT = r"C:\Users\Ethan\.gemini\antigravity\scratch\verification_report.json"

# Tracked endpoints map
endpoints_to_verify = {
    "1. Page Load (termSelection)": "/ssb/term/termSelection",
    "2. Get Terms (getTerms)": "/ssb/classSearch/getTerms",
    "3. Set Active Term (term/search)": "/ssb/term/search",
    "4. Transition Search Page (classSearch)": "/ssb/classSearch/classSearch",
    "5. Autocomplete Subjects (get_subject)": "/ssb/classSearch/get_subject",
    "6. Autocomplete Campuses (get_campus)": "/ssb/classSearch/get_campus",
    "7. Autocomplete Instructional Methods (get_instructionalMethod)": "/ssb/classSearch/get_instructionalMethod",
    "8. Autocomplete Attributes (get_attribute)": "/ssb/classSearch/get_attribute",
    "9. Autocomplete Levels (get_level)": "/ssb/classSearch/get_level",
    "10. Autocomplete Buildings (get_building)": "/ssb/classSearch/get_building",
    "11. Autocomplete Colleges (get_college)": "/ssb/classSearch/get_college",
    "12. Autocomplete Departments (get_department)": "/ssb/classSearch/get_department",
    "13. Autocomplete Schedule Types (get_scheduleType)": "/ssb/classSearch/get_scheduleType",
    "14. Autocomplete Parts of Term (get_partOfTerm)": "/ssb/classSearch/get_partOfTerm",
    "15. Autocomplete Sessions (get_session)": "/ssb/classSearch/get_session",
    "16. Class Search Query (searchResults)": "/ssb/searchResults/searchResults",
    "17. Contact Card Data (retrieveData)": "/ssb/contactCard/retrieveData",
    "18. Modal: Class Details (getClassDetails)": "/ssb/searchResults/getClassDetails",
    "19. Modal: Bookstore Links (getSectionBookstoreDetails)": "/ssb/searchResults/getSectionBookstoreDetails",
    "20. Modal: Course Description (getCourseDescription)": "/ssb/searchResults/getCourseDescription",
    "21. Modal: Syllabus (getSyllabus)": "/ssb/searchResults/getSyllabus",
    "22. Modal: Attributes (getSectionAttributes)": "/ssb/searchResults/getSectionAttributes",
    "23. Modal: Restrictions (getRestrictions)": "/ssb/searchResults/getRestrictions",
    "24. Modal: Enrollment Details (getEnrollmentInfo)": "/ssb/searchResults/getEnrollmentInfo",
    "25. Modal: Corequisites (getCorequisites)": "/ssb/searchResults/getCorequisites",
    "26. Modal: Prerequisites (getSectionPrerequisites)": "/ssb/searchResults/getSectionPrerequisites",
    "27. Modal: Cross Listed (getXlstSections)": "/ssb/searchResults/getXlstSections",
    "28. Modal: Linked Sections (getLinkedSections)": "/ssb/searchResults/getLinkedSections",
    "29. Modal: Course Fees (getFees)": "/ssb/searchResults/getFees",
    "30. Modal: Catalog details (getSectionCatalogDetails)": "/ssb/searchResults/getSectionCatalogDetails",
    "31. Modal: Faculty Schedules (getFacultyMeetingTimes)": "/ssb/searchResults/getFacultyMeetingTimes"
}

verification_results = {label: {"path": path, "status": "Not Hit", "method": None, "url": None} for label, path in endpoints_to_verify.items()}

async def handle_response(response):
    url = response.url
    parsed = urllib.parse.urlparse(url)
    path = parsed.path
    method = response.request.method
    
    for label, target_path in endpoints_to_verify.items():
        if target_path in path:
            verification_results[label]["status"] = f"{response.status} OK" if response.status == 200 else f"HTTP {response.status}"
            verification_results[label]["method"] = method
            verification_results[label]["url"] = url
            print(f"VERIFIED: '{label}' -> {method} {path} -> Status {response.status}")

async def select_select2_option(page, container_selector, search_text, expected_option_text):
    print(f"Selecting select2: {container_selector} -> '{search_text}'")
    container = await page.wait_for_selector(container_selector)
    choices = await container.query_selector(".select2-choices")
    is_multi = choices is not None
    
    if is_multi:
        search_input = await container.wait_for_selector("input.select2-input")
        await search_input.click()
    else:
        await container.click()
        search_input = await page.wait_for_selector(".select2-drop-active .select2-input, .select2-input")
        
    await asyncio.sleep(0.5)
    await search_input.fill("")
    await search_input.type(search_text)
    await asyncio.sleep(1.5)
    
    await page.wait_for_selector(".select2-drop-active .select2-result-label")
    results = await page.query_selector_all(".select2-drop-active .select2-result-label")
    
    # 1. Exact match check
    for res in results:
        text = await res.inner_text()
        if text.strip().lower() == expected_option_text.lower():
            print(f"Clicked exact option matching '{expected_option_text}': '{text}'")
            await res.click()
            await asyncio.sleep(0.5)
            return True
            
    # 2. Substring match check
    for res in results:
        text = await res.inner_text()
        if expected_option_text.lower() in text.lower() or text.lower() in expected_option_text.lower():
            print(f"Clicked substring option matching '{expected_option_text}': '{text}'")
            await res.click()
            await asyncio.sleep(0.5)
            return True
            
    if results:
        text = await results[0].inner_text()
        print(f"Clicked fallback option: '{text}'")
        await results[0].click()
        await asyncio.sleep(0.5)
        return True
    
    await page.keyboard.press("Escape")
    return False

async def trigger_autocomplete_only(page, container_selector, search_text):
    print(f"Triggering Autocomplete lookup: {container_selector} with '{search_text}'")
    container = await page.wait_for_selector(container_selector)
    choices = await container.query_selector(".select2-choices")
    is_multi = choices is not None
    
    if is_multi:
        search_input = await container.wait_for_selector("input.select2-input")
        await search_input.click()
    else:
        await container.click()
        search_input = await page.wait_for_selector(".select2-drop-active .select2-input, .select2-input")
        
    await asyncio.sleep(0.5)
    await search_input.fill("")
    await search_input.type(search_text)
    await asyncio.sleep(2) # Wait for XHR callback to complete
    
    # Clear the text box so it doesn't pollute the search form
    await search_input.fill("")
    await asyncio.sleep(0.5)
    
    # Close it without selecting anything
    await page.keyboard.press("Escape")
    await asyncio.sleep(1)

async def main():
    async with async_playwright() as p:
        print("Launching browser...")
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Listen to network responses
        page.on("response", handle_response)
        
        try:
            # 1. Page Load
            print("1. Loading term selection page...")
            await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
            await page.wait_for_load_state("networkidle")
            
            # 2. getTerms
            print("2. Opening term select dropdown...")
            await select_select2_option(page, "#s2id_txt_term", "Fall 2026", "Fall 2026")
            
            # 3 & 4. term/search POST & classSearch GET
            print("3. Clicking term submit button...")
            go_btn = await page.wait_for_selector("#term-go")
            await go_btn.click()
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(2)
            
            # 5. Autocomplete Subjects (Select ICS)
            print("4. Selecting Subject (ICS)...")
            await select_select2_option(page, "#s2id_txt_subject", "ICS", "Information& Computer Sciences")
            
            # Course Number (111)
            print("5. Filling Course Number (111)...")
            await page.fill("#txt_courseNumber", "111")
            
            # Toggle Advanced Search to trigger other autocompletes
            print("6. Toggling Advanced Search panel...")
            adv_toggle = await page.wait_for_selector("#advanced-search-link")
            await adv_toggle.click()
            await asyncio.sleep(2)
            
            # Trigger autocomplete dropdown queries systematically but do NOT select options
            # 6. get_campus
            await trigger_autocomplete_only(page, "#s2id_txt_campus", "Manoa")
            
            # 7. get_instructionalMethod
            await trigger_autocomplete_only(page, "#s2id_txt_instructionalMethod", "Distance")
            
            # 8. get_attribute
            await trigger_autocomplete_only(page, "#s2id_txt_attribute", "Writing")
            
            # 9. get_level
            await trigger_autocomplete_only(page, "#s2id_txt_level", "Graduate")
            
            # 10. get_building
            await trigger_autocomplete_only(page, "#s2id_txt_building", "POST")
            
            # 11. get_college
            await trigger_autocomplete_only(page, "#s2id_txt_college", "Natural")
            
            # 12. get_department
            await trigger_autocomplete_only(page, "#s2id_txt_department", "Information")
            
            # 13. get_scheduleType
            await trigger_autocomplete_only(page, "#s2id_txt_scheduleType", "Lecture")
            
            # 14. get_partOfTerm
            await trigger_autocomplete_only(page, "#s2id_txt_partOfTerm", "Full")
            
            # 15. get_session
            await trigger_autocomplete_only(page, "#s2id_txt_session", "Day")
            
            # 16. Search results
            print("7. Executing search query...")
            search_go = await page.wait_for_selector("#search-go")
            await search_go.click()
            await asyncio.sleep(5) # Wait for table to render
            
            # Let's take a screenshot to make sure we see the table
            screenshot_path = r"C:\Users\Ethan\.gemini\antigravity\brain\8c504a74-aa2d-45b9-8716-e651aab8f231\verification_search_results.png"
            await page.screenshot(path=screenshot_path)
            print(f"Results screenshot saved to {screenshot_path}")
            
            # 17. Contact Card GET retrieveData
            print("8. Clicking instructor link to load contact card...")
            try:
                instructor_link = await page.wait_for_selector("a.email", timeout=10000)
                await instructor_link.click()
                await asyncio.sleep(2.5)
                await page.keyboard.press("Escape")
                await asyncio.sleep(1)
            except Exception as e:
                print(f"Could not find or click instructor email link (a.email): {e}")
                err_screenshot = r"C:\Users\Ethan\.gemini\antigravity\brain\8c504a74-aa2d-45b9-8716-e651aab8f231\verification_no_instructor_error.png"
                await page.screenshot(path=err_screenshot)
                print(f"Error screenshot saved to {err_screenshot}")
            
            # 18. Course Details Modal Sub-endpoints
            print("9. Clicking course title to open details modal...")
            try:
                title_link = await page.wait_for_selector("a.section-details-link", timeout=10000)
                await title_link.click()
                await asyncio.sleep(2.5)
                
                # Loop through modal tabs
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
                        print(f"Clicking details modal tab: '{tab_text}'")
                        await tab_link.click()
                        await asyncio.sleep(1.5)
                
                print("10. Closing details modal...")
                await page.keyboard.press("Escape")
                await asyncio.sleep(1)
            except Exception as e:
                print(f"Could not find or open details modal: {e}")
            
            print("Verification Sequence Completed.")
            
        except Exception as e:
            print(f"Verification Error: {e}")
        finally:
            # Print report
            print("\n--- FINAL VERIFICATION REPORT ---")
            print("| Endpoint Label | Path Pattern | Method | Verification Status |")
            print("| :--- | :--- | :--- | :--- |")
            for label, details in verification_results.items():
                print(f"| {label} | `{details['path']}` | {details['method']} | **{details['status']}** |")
                
            # Save report to JSON
            with open(VERIFICATION_REPORT, "w", encoding="utf-8") as f:
                json.dump(verification_results, f, indent=2)
            print(f"\nVerification JSON saved to {VERIFICATION_REPORT}")
            
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

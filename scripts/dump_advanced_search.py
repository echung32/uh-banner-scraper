import asyncio
from playwright.async_api import async_playwright

async def select_select2_option(page, container_selector, search_text, expected_option_text):
    container = await page.wait_for_selector(container_selector)
    await container.click()
    await asyncio.sleep(1)
    search_input = await page.wait_for_selector(".select2-drop-active .select2-input")
    await search_input.fill(search_text)
    await asyncio.sleep(1.5)
    results = await page.query_selector_all(".select2-drop-active .select2-result-label")
    for res in results:
        text = await res.inner_text()
        if expected_option_text.lower() in text.lower():
            await res.click()
            await asyncio.sleep(1)
            return True
    if results:
        await results[0].click()
        await asyncio.sleep(1)
    return False

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        print("Navigating and selecting term...")
        await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
        await page.wait_for_load_state("networkidle")
        
        await select_select2_option(page, "#s2id_txt_term", "Fall 2026", "Fall 2026")
        
        go_btn = await page.wait_for_selector("#term-go")
        await go_btn.click()
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        print("Toggling Advanced Search...")
        adv_toggle = await page.wait_for_selector("#advanced-search-link")
        await adv_toggle.click()
        await asyncio.sleep(2)
        
        # Dump HTML to file
        content = await page.content()
        with open(r"C:\Users\Ethan\.gemini\antigravity\scratch\search_page.html", "w", encoding="utf-8") as f:
            f.write(content)
        print("Search page HTML dumped.")
        
        # Analyze select2 containers (divs with id starting with s2id_)
        select2_divs = await page.query_selector_all("div[id^='s2id_']")
        print(f"Found {len(select2_divs)} select2 containers:")
        for idx, div in enumerate(select2_divs):
            div_id = await div.get_attribute("id")
            # Try to get the input placeholder or label text
            label_text = ""
            label_el = await page.query_selector(f"label[for='{div_id.replace('s2id_', '')}']")
            if label_el:
                label_text = await label_el.inner_text()
            print(f"  Select2 {idx}: id={div_id}, label='{label_text}'")
            
        # Let's check inputs and selects
        inputs = await page.query_selector_all("input")
        print(f"Found {len(inputs)} inputs:")
        for idx, inp in enumerate(inputs):
            inp_id = await inp.get_attribute("id")
            inp_name = await inp.get_attribute("name")
            inp_type = await inp.get_attribute("type")
            print(f"  Input {idx}: id={inp_id}, name={inp_name}, type={inp_type}")
            
        selects = await page.query_selector_all("select")
        print(f"Found {len(selects)} selects:")
        for idx, sel in enumerate(selects):
            sel_id = await sel.get_attribute("id")
            sel_name = await sel.get_attribute("name")
            print(f"  Select {idx}: id={sel_id}, name={sel_name}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

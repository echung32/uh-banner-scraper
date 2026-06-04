import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        print("Navigating to termSelection...")
        await page.goto("https://www.sis.hawaii.edu:9234/StudentRegistrationSsb/ssb/term/termSelection?mode=search")
        await page.wait_for_load_state("networkidle")
        
        cookies = await context.cookies()
        print("Cookies after navigation:")
        for cookie in cookies:
            print(f"  Name: {cookie['name']}")
            print(f"  Value: {cookie['value']}")
            print(f"  Domain: {cookie['domain']}")
            print(f"  Path: {cookie['path']}")
            print(f"  Secure: {cookie['secure']}")
            print(f"  HttpOnly: {cookie['httpOnly']}")
            print("-" * 30)
            
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

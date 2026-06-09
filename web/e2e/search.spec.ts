import { test, expect, type Page } from "@playwright/test";

// These tests drive the real Astro SSR app against a seeded local D1 (see
// e2e/global-setup.ts) — searches are served from the database, not the live
// SIS. The Banner-facing ingestion path (incl. the resetDataForm regression
// guard) is covered separately in ingest.spec.ts.

/** Reads the "Showing X–Y of N sections" summary into the section count N. */
async function totalSections(page: Page): Promise<number> {
  const summary = page.getByText(/of \d+ sections/);
  await expect(summary).toBeVisible();
  const text = (await summary.textContent()) ?? "";
  const match = /of (\d+) sections/.exec(text);
  return match ? Number(match[1]) : 0;
}

async function runSearch(page: Page, subject: string, courseNumber: string) {
  // Clear then type key-by-key so React's controlled-input onChange fires
  // reliably even when re-running a search with the same subject.
  const subjectInput = page.getByLabel("Subject");
  await subjectInput.fill("");
  await subjectInput.pressSequentially(subject);

  const courseInput = page.getByLabel("Course Number");
  await courseInput.fill("");
  if (courseNumber) await courseInput.pressSequentially(courseNumber);

  const searchButton = page.getByRole("button", { name: "Search", exact: true });
  await expect(searchButton).toBeEnabled();
  await searchButton.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The term <select> is populated from the mock's getTerms; wait for the app.
  await expect(page.getByLabel("Subject")).toBeVisible();
});

test("loads the course search page with a populated term", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Course Search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Term" })).toContainText("Fall 2026");
});

test("subject search returns matching sections", async ({ page }) => {
  await runSearch(page, "ICS", "");
  // The mock catalog has 6 ICS sections total.
  expect(await totalSections(page)).toBe(6);
  await expect(page.getByRole("cell", { name: "ICS 111" }).first()).toBeVisible();
});

test("course number filter narrows the results", async ({ page }) => {
  // First search: subject only.
  await runSearch(page, "ICS", "");
  expect(await totalSections(page)).toBe(6);

  // Add a course-number filter — served by the SQL WHERE clause.
  await runSearch(page, "ICS", "111");
  await expect(page.getByText(/of 2 sections/)).toBeVisible();
  expect(await totalSections(page)).toBe(2);

  // Every visible course cell should be ICS 111.
  const courseCells = page.getByRole("cell", { name: "ICS 111" });
  await expect(courseCells).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "ICS 311" })).toHaveCount(0);

  // Clearing the course number widens the results again.
  await runSearch(page, "ICS", "");
  await expect(page.getByText(/of 6 sections/)).toBeVisible();
});

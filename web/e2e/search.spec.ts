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

/** Picks an option from one of the form's selects by combobox + option label. */
async function selectOption(page: Page, combobox: string, label: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
const selectCampus = (page: Page, label: string) => selectOption(page, "Campus", label);

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

test("campus filter defaults to UH Manoa and widens to all campuses", async ({ page }) => {
  // Default campus is UH Manoa, so only the 6 Manoa ICS sections show — the
  // Hilo section is hidden — and the column reflects it.
  await runSearch(page, "ICS", "");
  expect(await totalSections(page)).toBe(6);
  await expect(
    page.getByRole("cell", { name: "University of Hawaii at Manoa" }).first()
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "University of Hawaii at Hilo" })
  ).toHaveCount(0);

  // Widen to all campuses → the Hilo section appears (7 total).
  await selectCampus(page, "All Campuses");
  await runSearch(page, "ICS", "");
  await expect(page.getByText(/of 7 sections/)).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "University of Hawaii at Hilo" })
  ).toBeVisible();
});

test("college filter narrows results to the selected academic college", async ({ page }) => {
  // Default campus (Manoa): 6 ICS sections across courses 111/141/211 (Natural
  // Sciences) and 311 (Engineering, per the seeded catalog).
  await runSearch(page, "ICS", "");
  expect(await totalSections(page)).toBe(6);

  // Filter to College of Natural Sciences → excludes the 2 ICS 311 sections.
  await selectOption(page, "College", "College of Natural Sciences");
  await runSearch(page, "ICS", "");
  await expect(page.getByText(/of 4 sections/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "ICS 311" })).toHaveCount(0);

  // Switch to College of Engineering → only the 2 ICS 311 sections.
  await selectOption(page, "College", "College of Engineering");
  await runSearch(page, "ICS", "");
  await expect(page.getByText(/of 2 sections/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "ICS 311" })).toHaveCount(2);
});

test("expanding a section row shows catalog, lazily-fetched detail, and instructor", async ({
  page,
}) => {
  await runSearch(page, "ICS", "");
  expect(await totalSections(page)).toBe(6);

  // The first row is ICS 111 §001 (CRN 10001, tiebreak by crn). Click it to
  // expand the details panel.
  await page.getByRole("cell", { name: "ICS 111" }).first().click();

  // Catalog facts come from the seeded `course` row (read path, D1).
  await expect(
    page.getByText("College of Natural Sciences").last()
  ).toBeVisible();

  // Instructor card comes from the seeded `instructor` row (read path, D1). The
  // title is panel-only (the table column shows just the name), so it's a clean
  // signal the card rendered.
  await expect(page.getByText("Associate Professor")).toBeVisible();

  // Section detail is NOT seeded — it's fetched live from the mock SIS on first
  // view and stored (lazy cache-on-miss). The mock serves a $50 fee and marks
  // CRN 10001 cross-listed with 10002.
  await expect(page.getByText("$50.00")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("10002", { exact: true })).toBeVisible();

  // Collapsing hides the panel again.
  await page.getByRole("cell", { name: "ICS 111" }).first().click();
  await expect(page.getByText("Associate Professor")).toHaveCount(0);
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

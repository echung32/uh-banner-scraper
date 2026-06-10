# Prerequisites Formatting

## Problem

Banner's `getSectionPrerequisites` endpoint returns structured prerequisite logic as an HTML fragment containing a `<pre>` block with a specific text grammar: optional category labels, a summary line (`Prerequisites:X`), and parenthesized alternative groups connected by `or`/`and` operators. The existing ingestion parser (`parsePrerequisites` in `web/src/lib/sis/parse/text.ts`) correctly flattens this to plain text preserving line breaks, but the UI rendered it verbatim — showing bare `(` / `)` characters on their own lines, the word `or` floating alone, and unindented condition lines.

## Stored text format

After HTML → plain text conversion, prerequisites look like:

```
Area Prerequisites
Prerequisites:ICS 141 Completed w/C grade
(
Course or Test: Information& Computer Sciences 141
Minimum Grade of C
May not be taken concurrently.
)
or
(
Course or Test: Information& Computer Sciences 141
Minimum Grade of C
May not be taken concurrently.
)
```

Simple courses (no groups) look like:
```
Prerequisites:ICS 211 Completed w/C grade
```

## Decision: parse at render time, no DB changes

The plain text stored in `course.prerequisites` is correct and complete. Improving the display is a pure UI concern — no DB migration, no re-ingestion, no API surface change needed.

Changing to a structured JSON storage format was considered but rejected: it would require a new migration, a full re-ingestion pass for all terms, changes to `parsePrerequisites`, `upsert.ts`, and the `CourseCatalog` API type — all for cosmetic rendering.

Cheerio was also considered for HTML parsing but is not applicable here: the stored data is already plain text. Cheerio is only useful for DOM traversal of HTML; the plain-text tokenizer is the right tool.

## Implementation

**`web/src/components/SectionDetails.tsx`** — all changes in one file.

### Tokenizer: `parsePrereqText(raw: string): PrereqToken[]`

A small state-machine over the `\n`-split lines. Recognises four token types:

| Token kind | Trigger | Example |
|---|---|---|
| `label` | any other non-empty line | `"Area Prerequisites"` |
| `simple` | line matching `/^(Prerequisites\|Test Score\|Corequisite):/i` | `"Prerequisites:ICS 141 Completed w/C grade"` |
| `group` | lines between `(` and `)` | the conditions inside a group |
| `op` | line is exactly `or` or `and` | `"or"` |

### Renderer: `PrereqDisplay({ text })`

- **No groups found** → strip `Prerequisites:` prefix and render as a single `<p>`.
- **Groups present** → render structured:
  - `label` tokens: small muted `<p>` (`text-xs text-muted-foreground`)
  - `simple` tokens: medium-weight `<p>` with prefix stripped
  - `op` tokens: horizontal rule with the operator word centered in muted caps
  - `group` tokens: bordered rounded `<div>` with one `<p>` per condition line

### Usage

Replaces the `<p className="whitespace-pre-line">` in both the Prerequisites and Corequisites sections of `SectionDetails.tsx`.

## Files changed

- `web/src/components/SectionDetails.tsx` — add `parsePrereqText`, `PrereqDisplay`; replace two `whitespace-pre-line` usages

No other files touched.

## Verification

1. `cd web && yarn build` — type-checks the component
2. `yarn dev` — open ICS 241 (Discrete Math) details panel: should show bordered group cards with OR dividers
3. Open ICS 311 details panel: should show a single clean line without the `Prerequisites:` prefix
4. Course with no prerequisites: section must remain hidden (null guard unchanged)
5. `yarn test -g "course"` — read-path e2e tests still pass

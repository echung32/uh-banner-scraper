# Scripts Documentation: UH SIS API Automation & Diagnostic Tools

This directory contains the automation, verification, and reverse engineering diagnostic scripts used to map the University of Hawaii Student Information System (SSB9 Banner) search interface endpoints.

---

## 1. Core Automation & Test Suites

### `verify_all_endpoints.py`
- **Purpose**: The primary verification test suite. It runs a sequential session validation using Playwright, dynamically interacting with the UI to trigger all 31 endpoints in order. It handles cookies, CSRF token updates, autocompletes, contact cards, and modals.
- **Dependencies**: Playwright
- **Key Output**: Generates `scripts/verification_report.json` containing the status of all 31 endpoints and prints a markdown status table.

### `scrape_banner.py`
- **Purpose**: Core capture script. It launches a headless browser, performs a basic course search (ICS 111, Fall 2026), and clicks on course title detail links and instructor email links to capture all API traffic.
- **Key Output**: Intercepts and dumps request/response pairs into `scripts/intercepted_calls.json`.

### `confirm_search_params.py`
- **Purpose**: Verifies advanced search form validation. It programmatically sets all 38 query parameters in the UI (including keywords, campuses, meeting days, credits, time boundaries, and dropdowns) and clicks search.
- **Key Output**: Saves a visual screenshot of the results page to `docs/images/param_verification_results.png`.

---

## 2. Reverse Engineering & Cookie Diagnostics

### `find_tokens.py`
- **Purpose**: Analyzes the HTML load states of the term selection and search pages to identify where CSRF `synchronizerToken`s are injected (`Token_A` and `Token_B`).

### `get_session_cookies.py`
- **Purpose**: Logs active session cookies (`JSESSIONID` and F5 BIG-IP load balancer stickiness cookies) established during browser handshakes.

### `inspect_cookies.py`
- **Purpose**: Parses intercepted headers to confirm cookie propagation rules across different phases of the session lifecycle.

### `print_lifecycle.py`
- **Purpose**: Evaluates network logs to print the sequence of transitions from term selection to search results.

---

## 3. Log Inspection & JSON Diagnostic Tools

These utility scripts analyze local data from `scripts/intercepted_calls.json` without sending requests to the live UH server:

- **`inspect_logs.py`**: A general diagnostic utility to query, search, and pretty-print intercepted requests and response headers from the log file.
- **`inspect_schemas.py`**: Analyzes the JSON responses of autocomplete endpoints, generating schema templates and listing dictionary keys.
- **`inspect_details.py`**: Focuses on details modal endpoints (`/ssb/searchResults/...`), dumping response body structures and classifying them as JSON or HTML blocks.
- **`inspect_details_top.py`**: Extracts high-level structures and headers specifically for course details endpoints.
- **`inspect_term_search.py`**: Isolates and debugs the headers, cookies, and payload for the `POST /ssb/term/search` endpoint.
- **`inspect_contact_card.py`**: Dumps the request parameters and JSON schema returned by the instructor `/contactCard/retrieveData` query.
- **`inspect_college_response.py`**: Focuses on `/get_college` and checks why certain college query criteria yield empty results.
- **`dump_advanced_search.py`**: Inspects and writes the DOM elements of the advanced search drawer to local files for selector mapping.

---

## 4. Helper and Validation Utilities

### `validate_openapi.py`
- **Purpose**: Formally parses the generated `openapi.yaml` specification using Python's PyYAML library to ensure compliance with the OpenAPI 3.1.0 specification structure.

### `test_filters.py`
- **Purpose**: A scratch testing script used to verify Select2 autocomplete filters and validate dynamic list changes.

import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

for idx, call in enumerate(calls):
    if "term/search" in call["url"] or "termSelection" in call["url"]:
        print(f"Call [{idx}]: {call['method']} {call['url']}")
        print(f"Request Headers: {call['request_headers']}")
        print(f"Request Payload: {call['request_payload']}")
        print(f"Response Status: {call['status']}")
        print(f"Response Headers: {call['response_headers']}")
        print("-" * 50)

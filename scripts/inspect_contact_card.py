import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

for idx, call in enumerate(calls):
    if "contactCard/retrieveData" in call["url"]:
        print(f"Call [{idx}]: {call['url']}")
        print(json.dumps(call["response_body"], indent=2))
        break

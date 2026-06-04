import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

endpoints_top = [
    "contactCard/retrieveData",
    "getClassDetails",
    "getSectionBookstoreDetails",
    "getCourseDescription"
]

for ep in endpoints_top:
    print(f"\n==========================================")
    print(f"Checking endpoint matching: {ep}")
    print(f"==========================================")
    for idx, call in enumerate(calls):
        if ep in call["url"]:
            print(f"Call [{idx}]: {call['method']} {call['url']}")
            print(f"Request Payload: {call['request_payload']}")
            print(f"Response Status: {call['status']}")
            body = call["response_body"]
            if isinstance(body, dict):
                print(f"Response Type: Dict. Keys: {list(body.keys())}")
                print(f"Response Data Snippet: {json.dumps(body, indent=2)[:800]}")
            elif isinstance(body, list):
                print(f"Response Type: List of size {len(body)}.")
                if body:
                    print(f"First item keys: {list(body[0].keys()) if isinstance(body[0], dict) else 'Non-dict'}")
                print(f"Response Data Snippet: {str(body)[:800]}")
            else:
                print(f"Response Type: String. Snippet: {str(body)[:800]}")
            break

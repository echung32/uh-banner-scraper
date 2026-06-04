import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

print("Checking cookies in all calls:")
for idx, call in enumerate(calls):
    url = call["url"]
    # Look for Cookie or Set-Cookie in headers
    req_cookies = []
    res_cookies = []
    
    for k, v in call["request_headers"].items():
        if k.lower() == "cookie":
            req_cookies.append(v)
            
    for k, v in call["response_headers"].items():
        if k.lower() == "set-cookie":
            res_cookies.append(v)
            
    if req_cookies or res_cookies:
        print(f"Call [{idx}] {call['method']} {url}:")
        if req_cookies:
            print(f"  Request Cookie: {req_cookies}")
        if res_cookies:
            print(f"  Response Set-Cookie: {res_cookies}")
            
# Also check if there's any JSESSIONID in any call
has_jsessionid = False
for idx, call in enumerate(calls):
    for k, v in call["request_headers"].items():
        if "jsessionid" in v.lower():
            has_jsessionid = True
    for k, v in call["response_headers"].items():
        if "jsessionid" in v.lower():
            has_jsessionid = True

print(f"Contains JSESSIONID? {has_jsessionid}")

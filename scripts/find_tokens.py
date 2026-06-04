import json
import re

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

token1 = "32bccfbc-90e2-4369-8dd0-373376c49d83"
token2 = "afc55f1f-892d-418d-9e42-d425f9a20261"

print(f"Searching for Token 1: {token1}")
for idx, call in enumerate(calls):
    body = str(call["response_body"])
    if token1 in body:
        print(f"  Found in call [{idx}] {call['method']} {call['url']} response body!")
        # Print matching context
        pos = body.find(token1)
        print("   ", body[max(0, pos-100):min(len(body), pos+150)])

print(f"\nSearching for Token 2: {token2}")
for idx, call in enumerate(calls):
    body = str(call["response_body"])
    if token2 in body:
        print(f"  Found in call [{idx}] {call['method']} {call['url']} response body!")
        pos = body.find(token2)
        print("   ", body[max(0, pos-100):min(len(body), pos+150)])

# Let's inspect Set-Cookie headers in more detail
print("\n--- Set-Cookie and Cookie Headers ---")
for idx, call in enumerate(calls):
    req_headers = call["request_headers"]
    res_headers = call["response_headers"]
    
    cookies_sent = req_headers.get("Cookie", req_headers.get("cookie", ""))
    cookies_rcvd = res_headers.get("Set-Cookie", res_headers.get("set-cookie", ""))
    
    if cookies_sent or cookies_rcvd:
        print(f"Call [{idx}] {call['method']} {call['url']}:")
        if cookies_sent:
            print(f"  Sent: {cookies_sent}")
        if cookies_rcvd:
            print(f"  Rcvd: {cookies_rcvd}")

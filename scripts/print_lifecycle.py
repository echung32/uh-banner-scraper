import json
import urllib.parse
import re

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

print(f"Total calls: {len(calls)}")

print("\n--- REQUEST LIFECYCLE ORDER ---")
for idx, call in enumerate(calls):
    url_parsed = urllib.parse.urlparse(call["url"])
    path = url_parsed.path
    query = url_parsed.query
    print(f"{idx + 1}. {call['method']} {path}")
    if query:
        print(f"   Query: {query}")
    if call["request_payload"]:
        print(f"   Payload: {call['request_payload']}")
    
    # Check headers for cookies and tokens
    req_headers = call["request_headers"]
    cookie_header = req_headers.get("Cookie", req_headers.get("cookie", ""))
    if cookie_header:
        # Just print cookie names for privacy
        cookies = [c.split("=")[0].strip() for c in cookie_header.split(";")]
        print(f"   Cookies sent: {cookies}")
        
    res_headers = call["response_headers"]
    set_cookie = res_headers.get("Set-Cookie", res_headers.get("set-cookie", ""))
    if set_cookie:
        print(f"   Set-Cookie: {[c.split(';')[0] for c in set_cookie.split(',') if 'JSESSIONID' in c]}")
        
    # Check if there is synchronizerToken or other CSRF tokens in request/response headers or body
    for k, v in req_headers.items():
        if "token" in k.lower() or "xsrf" in k.lower() or "csrf" in k.lower():
            print(f"   CSRF Header Sent: {k} = {v}")
            
    for k, v in res_headers.items():
        if "token" in k.lower() or "xsrf" in k.lower() or "csrf" in k.lower():
            print(f"   CSRF Header Rcvd: {k} = {v}")
            
    # If the response is HTML, check if we have a synchronizerToken hidden input
    if isinstance(call["response_body"], str) and "synchronizerToken" in call["response_body"]:
        # Find token value
        matches = re.findall(r'name="synchronizerToken"\s+value="([^"]+)"', call["response_body"])
        if matches:
            print(f"   Found synchronizerToken in HTML body: {matches}")

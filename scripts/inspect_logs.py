import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

def main():
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print("Error reading log file:", e)
        return

    print(f"Total intercepted calls: {len(data)}")
    for idx, call in enumerate(data):
        url = call["url"]
        method = call["method"]
        status = call["status"]
        print(f"[{idx}] {method} {url} -> Status {status}")
        
        # Let's inspect specific responses
        if "getTerms" in url:
            print("  Terms list response:")
            body = call["response_body"]
            if isinstance(body, list):
                for term in body[:5]:
                    print(f"    - code: {term.get('code')}, desc: {term.get('description')}")
            else:
                print("    ", str(body)[:200])
                
        elif "get_subject" in url and "searchTerm=ICS" in url:
            print("  Subject ICS response:")
            print("    ", str(call["response_body"])[:300])
            
        elif "get_college" in url:
            print("  College response:")
            body = call["response_body"]
            if isinstance(body, list):
                for college in body[:10]:
                    print(f"    - code: {college.get('code')}, desc: {college.get('description')}")
            else:
                print("    ", str(body)[:200])
                
        elif "searchResults" in url:
            print("  Search Results response preview:")
            body = call["response_body"]
            if isinstance(body, dict):
                print(f"    - success: {body.get('success')}, totalCount: {body.get('totalCount')}")
                data_list = body.get("data", [])
                print(f"    - number of items returned: {len(data_list)}")
                if data_list:
                    print("    - First result keys:", list(data_list[0].keys()))
                    print("    - First result sample courseTitle:", data_list[0].get("courseTitle"))
                    print("    - First result sample subjectDescription:", data_list[0].get("subjectDescription"))
                    print("    - First result sample faculty:", data_list[0].get("faculty"))
                    print("    - First result sample meetingsFaculty:", data_list[0].get("meetingsFaculty"))
            else:
                print("    ", str(body)[:400])

if __name__ == "__main__":
    main()

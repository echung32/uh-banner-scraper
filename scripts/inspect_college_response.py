import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    data = json.load(f)

print("Call [15] (empty search):")
print(json.dumps(data[15]["response_body"], indent=2))

print("\nCall [16] (search 'Natural'):")
print(json.dumps(data[16]["response_body"], indent=2))

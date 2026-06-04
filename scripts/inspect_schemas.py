import json

LOG_FILE = r"C:\Users\Ethan\.gemini\antigravity\scratch\intercepted_calls.json"

with open(LOG_FILE, "r", encoding="utf-8") as f:
    calls = json.load(f)

def print_schema(label, data_obj):
    print(f"\n=== Schema for {label} ===")
    if isinstance(data_obj, list):
        print(f"List of {len(data_obj)} items. First item type: {type(data_obj[0])}")
        if data_obj:
            print_schema_dict("Item in list", data_obj[0])
    elif isinstance(data_obj, dict):
        print_schema_dict("Dictionary", data_obj)
    else:
        print(f"Data type: {type(data_obj)} - value sample: {str(data_obj)[:100]}")

def print_schema_dict(label, d, indent="  "):
    for k, v in d.items():
        if isinstance(v, dict):
            print(f"{indent}- {k} (Object):")
            print_schema_dict(k, v, indent + "    ")
        elif isinstance(v, list):
            item_type = type(v[0]).__name__ if v else "Unknown"
            print(f"{indent}- {k} (List of {item_type}s)")
            if v and isinstance(v[0], dict):
                print(f"{indent}  [Properties of first item]:")
                print_schema_dict(f"{k} item", v[0], indent + "    ")
        else:
            print(f"{indent}- {k} ({type(v).__name__}): sample='{str(v)[:60]}'")

# Find getTerms
for idx, call in enumerate(calls):
    if "getTerms" in call["url"] and "searchTerm=Fall" in call["url"]:
        print_schema("getTerms", call["response_body"])
        break

# Find get_subject
for idx, call in enumerate(calls):
    if "get_subject" in call["url"] and "searchTerm=ICS" in call["url"]:
        print_schema("get_subject", call["response_body"])
        break

# Find get_campus
for idx, call in enumerate(calls):
    if "get_campus" in call["url"] and "searchTerm=Manoa" in call["url"]:
        print_schema("get_campus", call["response_body"])
        break

# Find get_instructionalMethod
for idx, call in enumerate(calls):
    if "get_instructionalMethod" in call["url"] and "searchTerm=Distance" in call["url"]:
        print_schema("get_instructionalMethod", call["response_body"])
        break

# Find searchResults
for idx, call in enumerate(calls):
    if "searchResults/searchResults" in call["url"]:
        print_schema("searchResults", call["response_body"])
        break

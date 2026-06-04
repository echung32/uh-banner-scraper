import yaml
import sys

OPENAPI_FILE = r"C:\Users\Ethan\Documents\antigravity\radiant-rutherford\openapi.yaml"

def main():
    try:
        with open(OPENAPI_FILE, "r", encoding="utf-8") as f:
            content = yaml.safe_load(f)
        print("Success: openapi.yaml is valid YAML!")
        print("OpenAPI version:", content.get("openapi"))
        print("API title:", content.get("info", {}).get("title"))
        print("Paths defined:", list(content.get("paths", {}).keys()))
    except Exception as e:
        print("Error validating openapi.yaml:", e)
        sys.exit(1)

if __name__ == "__main__":
    main()

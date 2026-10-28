"""Run Unravel's routing checks against index.html.

Usage:  pip install playwright && playwright install chromium
        python tests/run_eval.py            (from the repo root)
Exits with code 1 if any check fails, so it can block a deploy.
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
cases = json.loads((root / "tests" / "questions.json").read_text())["questions"]
fails = 0
with sync_playwright() as p:
    page = p.chromium.launch().new_page()
    page.goto((root / "index.html").as_uri())
    page.wait_for_function("typeof window.unravelDebug === 'function'")
    for c in cases:
        r = page.evaluate("q => window.unravelDebug(q)", c["q"])
        kind, problems = r["plan"]["kind"], []
        if c["kind"] != "any" and kind != c["kind"]:
            problems.append(f"expected {c['kind']}, got {kind}")
        if c.get("notKind") and kind == c["notKind"]:
            problems.append(f"must not be {kind}")
        if c.get("topic") and kind == "curated" and r["topic"] != c["topic"]:
            problems.append(f"expected topic {c['topic']}, got {r['topic']}")
        for pid in c.get("mustFind", []):
            if pid not in r["ids"]:
                problems.append(f"passage {pid} not found")
        mark = "PASS" if not problems else "FAIL"
        fails += bool(problems)
        print(f"{mark}  {kind:11} {c['q'][:70]}" + ("" if not problems else "\n      " + "; ".join(problems)))
print(f"\n{len(cases) - fails}/{len(cases)} passed")
sys.exit(1 if fails else 0)

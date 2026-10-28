"""Run Unravel's routing checks against index.html.

Usage:  pip install playwright && playwright install chromium
        python tests/run_eval.py            (from the repo root)
Exits with code 1 if any check fails, so it can block a deploy.
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((root / "tests" / "questions.json").read_text())
cases = data["questions"]
keep = data.get("must_not_change", [])
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
        comp = r["plan"].get("companionTopic")
        if c.get("topic") and comp != c["topic"]:
            problems.append(f"expected companion {c['topic']}, got {comp}")
        if "open" in c and r.get("open") != c["open"]:
            problems.append(f"expected open={c['open']}, got {r.get('open')}")
        for pid in c.get("mustFind", []):
            if pid not in r["ids"]:
                problems.append(f"passage {pid} not found")
        mark = "PASS" if not problems else "FAIL"
        fails += bool(problems)
        print(f"{mark}  {kind:11} {c['q'][:70]}" + ("" if not problems else "\n      " + "; ".join(problems)))
    for q in keep:
        r = page.evaluate("q => window.unravelDebug(q)", q)
        bad = bool(r.get("changed"))
        fails += bad
        print(f"{'FAIL' if bad else 'PASS'}  unchanged   {q[:70]}" + (f"\n      changed {r['changed']}" if bad else ""))
total = len(cases) + len(keep)
print(f"\n{total - fails}/{total} passed")
sys.exit(1 if fails else 0)

# Unravel

A Zcash docs copilot. Every fact links to the passage it came from, and anything Unravel adds on its own is labeled as an explanation.

## Structure

| Path | What it is |
|---|---|
| `index.html` | The site: hero, curated answers, search, diagrams |
| `api/answer.js` | Serverless function that answers typed questions with the Claude API and citations |
| `lib/corpus.js` | The passage corpus the function reads (snapshot 27 Oct 2026) |

## How typed questions are answered

1. The page ranks passages from the corpus and sends the question plus the top passage ids to `/api/answer`.
2. The function sends only those passages to the model.
   - Groq: the model returns JSON with passage ids on every sentence, and the page checks each sentence (numbers must appear in the passage, wording must match).
   - Claude: passages go in as `search_result` blocks with citations enabled, and only cited text becomes fact.
3. Anything without a valid citation is shown as unverified explanation.
4. If the passages don't answer a Zcash or crypto question, the page sends it with `mode: "web"`:
   - Groq's built-in `browser_search` tool (on `openai/gpt-oss-120b`) searches the web and lists the pages it found. URLs the search didn't return are dropped.
   - A second call writes the usual cited JSON answer from those pages, and the page checks every sentence against them. The answer is labelled "From the web".
   - If web search isn't available (plan limits, outage, no results), the model answers from its own knowledge. The page labels it "General answer, not checked" and shows no sources.
5. Questions that aren't about Zcash or crypto get "Outside Unravel's scope" and never reach the model.
6. Misspelled words are corrected against the corpus vocabulary first ("Showing results for ..."), with a link to search the original wording.

## Answer format

Typed answers come back as structured JSON (see `richRules()` in both `index.html` and `api/answer.js`, which must stay in sync):

| Field | Shown as | Checked |
|---|---|---|
| `short`, `how` | Short answer, How it works | Each sentence must cite a passage; numbers must appear in it; wording must match |
| `numbers` | Key numbers table | Every number must appear in the cited passage |
| `visual` | One of timeline, steps, compare, tiles, bars | Each item must cite a passage; uncited or mismatched items are drawn dashed |
| `impact`, `explanation` | Explanation box | Labeled as written by Unravel |
| `related` | Ask next buttons | |

"Go deeper" sends up to 12 passages and asks for a longer answer.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | One of these two | | Free Groq key from console.groq.com. Answers are checked in the browser. |
| `ANTHROPIC_API_KEY` | One of these two | | Claude API key from console.anthropic.com. Uses built-in citations, and wins if both are set. |
| `UNRAVEL_MODEL` | No | `openai/gpt-oss-120b` (Groq) or `claude-sonnet-5-5` (Claude) | Model used for answers |
| `UNRAVEL_PER_MINUTE` | No | `6` | Questions per visitor per minute (per server instance) |
| `UNRAVEL_PER_DAY` | No | `60` | Questions per visitor per day (per server instance) |

Without either key the site still works: curated answers and passage search run in the browser.

## Keep costs safe

Groq's free tier has a shared daily limit; when it runs out, visitors see a friendly message and the matching passages. If you switch to Claude, set a monthly spend limit in the Anthropic Console. The built-in rate limits are best-effort only.

## Tests

`tests/questions.json` lists questions with the routing each must get: a curated answer, the AI model with specific passages found, or an honest "not covered". It includes beginner, developer, scenario-style and off-topic questions.

```
pip install playwright && playwright install chromium
python tests/run_eval.py
```

The runner exits with an error if any check fails. Run it before every push, and add a new case whenever a real question is answered badly.

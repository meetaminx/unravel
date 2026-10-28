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
4. If the passages don't answer the question, the model says so and the page shows "Not covered".

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

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
2. The function sends only those passages to Claude as `search_result` blocks with citations enabled.
3. Sentences Claude cites become "From the docs". Anything uncited is shown as unverified explanation.
4. If the passages don't answer the question, Claude replies `NOT_COVERED` and the page says so.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | | Claude API key from console.anthropic.com |
| `UNRAVEL_MODEL` | No | `claude-sonnet-5-5` | Model used for answers |
| `UNRAVEL_PER_MINUTE` | No | `6` | Questions per visitor per minute (per server instance) |
| `UNRAVEL_PER_DAY` | No | `60` | Questions per visitor per day (per server instance) |

Without `ANTHROPIC_API_KEY` the site still works: curated answers and passage search run in the browser.

## Keep costs safe

Set a monthly spend limit in the Anthropic Console. The built-in rate limits are best-effort only.

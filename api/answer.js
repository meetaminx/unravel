// Unravel answer endpoint.
// POST /api/answer  { question: string, ids: string[] }  ->  { verified, explanation, gaps, provider, model }
// GET  /api/answer  ->  { configured: boolean, provider }
//
// The browser picks the best passages (ids) from the corpus and sends only their ids.
// Two providers are supported; the first one with a key set is used:
//   1. Claude (ANTHROPIC_API_KEY): passages go in as search_result blocks with citations
//      enabled, and Claude's cited text blocks become "From the docs" sentences.
//   2. Groq free tier (GROQ_API_KEY): an open model returns JSON with a passage id on every
//      sentence. The browser then checks each sentence against its passage (numbers must
//      appear, wording must match) before showing it as fact.
// Anything written without a valid citation is never shown as fact.

import { PASSAGES, SOURCES, SNAPSHOT } from "../lib/corpus.js";

export const maxDuration = 60;

const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
const GROQ_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai") + "/v1/chat/completions";
const PROVIDER = () => process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GROQ_API_KEY ? "groq" : null;
const MODEL_FOR = p => process.env.UNRAVEL_MODEL || (p === "claude" ? "claude-sonnet-5-5" : "openai/gpt-oss-120b");
const MAX_IDS = 12;
const MAX_Q = 300;
const BY_ID = new Map(PASSAGES.map(p => [p.id, p]));
const TIER = { Spec: "Spec", Official: "Official docs", Implementation: "Implementation", Proposal: "Proposal", Secondary: "Secondary" };

// ---- best-effort protection (per server instance) ----
const hits = new Map();          // ip -> [timestamps]
const cache = new Map();         // key -> { at, body }
const PER_MIN = +(process.env.UNRAVEL_PER_MINUTE || 6);
const PER_DAY = +(process.env.UNRAVEL_PER_DAY || 60);
const CACHE_MS = 60 * 60 * 1000;

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 86400000);
  const lastMin = list.filter(t => now - t < 60000).length;
  if (lastMin >= PER_MIN || list.length >= PER_DAY) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return false;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function GET() {
  const p = PROVIDER();
  return json({ configured: !!p, provider: p, model: p ? MODEL_FOR(p) : null, snapshot: SNAPSHOT });
}

const SYSTEM = `You are Unravel, a documentation assistant for Zcash developers and newcomers.
Answer only from the search results provided. Do not use outside knowledge for facts.
Write plainly and explain jargon in a few words. Never use em dashes.

Reply in this exact structure:
1. The answer: 2 to 6 short sentences. Every sentence must be supported by the search results. Copy numbers, block heights and method names exactly as the results write them.
2. A line that starts with "EXPLANATION:" followed by at most 80 words of plain background, an analogy or practical advice that the results do not state directly. Leave it out if there is nothing useful to add.
3. Only if results conflict, or a result marked (Secondary) or (Proposal) is the only support for a key point, a line that starts with "GAPS:" saying so in one or two sentences.

If the search results do not answer the question, reply with only one line: "NOT_COVERED:" followed by one sentence naming what is missing. Do not guess.`;

// Shared with richRules() in index.html. Keep the two in sync.
function richRules(deep) {
  return `You are Unravel, a documentation assistant for Zcash developers and newcomers.
Answer only from the numbered passages. Never use outside knowledge for facts. Write plainly, explain jargon in a few words, and never use em dashes.
The question may describe the reader's own situation. If it does, speak to that situation directly in "short" and give practical next steps in "how", still citing a passage for every fact. Ignore personal details that do not change the answer.

Return one JSON object with these fields:
- "short": 1 or 2 sentences that answer the question directly.
- "how": ${deep ? "6 to 10" : "3 to 6"} sentences that explain how it works, in a logical order, connecting what the passages say.
- "numbers": up to ${deep ? 8 : 4} key figures from the passages: {"label": short name, "value": copied exactly as written, "cites": [...]}. Empty list if none.
- "visual": the one visual that best explains the answer, or null. Choose:
  "timeline" for events over time or block height: "items":[{"when":"...","label":"...","cites":[...]}], 2 to 7 items in order;
  "steps" for a process: "items":[{"label":"at most 6 words","detail":"one short sentence","cites":[...]}], 3 to 6 items;
  "compare" for differences between two things: "columns":["A","B"], "items":[{"label":"...","values":["a","b"],"cites":[...]}], 2 to 6 rows;
  "tiles" for 2 to 4 headline figures: "items":[{"value":"...","label":"...","cites":[...]}];
  "bars" for 2 to 6 numeric values in one unit: "unit":"...", "items":[{"label":"...","value":0,"cites":[...]}].
  Always include "type" and a "title" of at most 8 words. Every item must cite the passage its facts come from.
- "impact": at most 60 words on what this means in practice for the reader.
- "explanation": at most 60 words of background or an analogy the passages do not state. "" if nothing useful.
- "related": 3 short follow-up questions a reader might ask next.
- "gaps": one or two sentences if passages conflict or only a SECONDARY or PROPOSAL passage supports a key point, otherwise "".
- "not_covered": if the passages do not answer the question, one sentence naming what is missing, with "short", "how", "numbers" empty and "visual" null. Otherwise "".

Each sentence in "short" and "how" is {"text":"...","cites":["b11"]} listing the passage ids it relies on. Copy numbers, heights, dates and method names exactly as the passages write them. Do not merge facts into a claim no single passage supports.`;
}

const VTYPES = ["timeline", "steps", "compare", "tiles", "bars"];
const str = (x, n) => clean(String(x == null ? "" : x)).trim().slice(0, n);
const citesOf = (x, ids) => [...new Set((Array.isArray(x?.cites) ? x.cites : []).map(String))].filter(id => ids.includes(id));

export function sanitize(parsed, ids) {
  const sents = a => (Array.isArray(a) ? a : []).filter(v => v && typeof v.text === "string" && v.text.trim()).slice(0, 12).map(v => ({ text: str(v.text, 400), cites: citesOf(v, ids) }));
  let short = sents(parsed.short), how = sents(parsed.how);
  if (!short.length && !how.length) how = sents(parsed.verified);
  const unmatched = [...short, ...how].filter(v => !v.cites.length);
  short = short.filter(v => v.cites.length); how = how.filter(v => v.cites.length);
  const numbers = (Array.isArray(parsed.numbers) ? parsed.numbers : []).filter(n => n && n.label && n.value != null).slice(0, 8)
    .map(n => ({ label: str(n.label, 60), value: str(n.value, 60), cites: citesOf(n, ids) }));
  let visual = null;
  const v = parsed.visual;
  if (v && typeof v === "object" && VTYPES.includes(v.type)) {
    const items = (Array.isArray(v.items) ? v.items : []).slice(0, 8).map(it => ({
      when: str(it?.when, 40), label: str(it?.label, 90), detail: str(it?.detail, 160),
      value: v.type === "bars" ? Number(it?.value) : str(it?.value, 40),
      values: Array.isArray(it?.values) ? it.values.slice(0, 2).map(x => str(x, 60)) : [],
      cites: citesOf(it, ids)
    })).filter(it => it.label || it.value);
    const okBars = v.type !== "bars" || items.every(it => Number.isFinite(it.value));
    if (items.length >= 2 && okBars) visual = { type: v.type, title: str(v.title, 80), unit: str(v.unit, 20), columns: Array.isArray(v.columns) ? v.columns.slice(0, 2).map(c => str(c, 30)) : [], items };
  }
  const related = (Array.isArray(parsed.related) ? parsed.related : []).map(r => str(r, 120)).filter(r => r.length > 5).slice(0, 3);
  return {
    short, how, numbers, visual, related, unmatched,
    impact: str(parsed.impact, 600), explanation: str(parsed.explanation, 600),
    gaps: str(parsed.gaps, 400), notCovered: str(parsed.not_covered, 300)
  };
}

async function askGroq(question, ids, key, model, deep) {
  const passages = ids.map(id => {
    const p = BY_ID.get(id), s = SOURCES[p.s] || { t: p.s, tier: "Secondary" };
    return `[${id}] (${String(s.tier).toUpperCase()}) ${s.t} / ${p.sec}: ${p.x}`;
  }).join("\n\n");
  const base = {
    model,
    temperature: 0.2,
    max_completion_tokens: deep ? 4000 : 2800,
    messages: [
      { role: "system", content: richRules(deep) + "\n\nReply with only the JSON object." },
      { role: "user", content: `Question: ${question}\n\nPassages:\n${passages}` }
    ]
  };
  // Prefer JSON mode with light reasoning; drop options one at a time if the model rejects them.
  const attempts = [
    { ...base, response_format: { type: "json_object" }, reasoning_effort: "low" },
    { ...base, response_format: { type: "json_object" } },
    base
  ];
  let res, data;
  for (const body of attempts) {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(50000)
    });
    data = await res.json().catch(() => null);
    if (res.ok || res.status !== 400) break;
  }
  if (!res.ok) return { error: res.status, type: data?.error?.type || data?.error?.code || "", message: data?.error?.message };
  const raw = data?.choices?.[0]?.message?.content || "";
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || typeof parsed !== "object") return { error: 502, type: "invalid_json" };
  return { out: { ...sanitize(parsed, ids), checked: "browser", model: data.model || model } };
}

function splitSentences(text) {
  return text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [text];
}

function searchResult(p) {
  const s = SOURCES[p.s] || { t: p.s, tier: "Secondary" };
  return {
    type: "search_result",
    source: "kb://" + p.id,
    title: `${s.t} · ${p.sec} (${TIER[s.tier] || s.tier})`,
    content: splitSentences(p.x).map(t => ({ type: "text", text: t })),
    citations: { enabled: true }
  };
}

const clean = t => t.replace(/\*\*/g, "").replace(/—/g, ", ").replace(/\s+/g, " ");

// Turn Claude's content blocks (some carrying citations) into the page's answer shape.
export function shape(content, ids) {
  const out = { verified: [], unmatched: [], explanation: "", gaps: "", notCovered: "" };
  let section = "answer";
  let cur = null;
  const flush = () => { if (cur) { cur.text = clean(cur.text).trim(); if (cur.text) (cur.cites.length ? out.verified : out.unmatched).push(cur); cur = null; } };
  for (const b of content || []) {
    if (b.type !== "text") continue;
    let text = b.text || "";
    const cites = [...new Set((b.citations || []).map(c => String(c.source || "").replace(/^kb:\/\//, "")).filter(id => ids.includes(id)))];
    // Section markers can appear inside any block.
    const parts = text.split(/(NOT_COVERED:|EXPLANATION:|GAPS:)/);
    for (const part of parts) {
      if (part === "NOT_COVERED:") { flush(); section = "notCovered"; continue; }
      if (part === "EXPLANATION:") { flush(); section = "explanation"; continue; }
      if (part === "GAPS:") { flush(); section = "gaps"; continue; }
      if (section !== "answer") { out[section] += part; continue; }
      if (cites.length) {
        if (cur && !cur.cites.length && cur.text.trim().length < 25) { cur.text += part; cur.cites = cites; }
        else if (cur && cur.cites.length && !/[.!?]\s*$/.test(cur.text)) { cur.text += part; cur.cites = [...new Set([...cur.cites, ...cites])]; }
        else { flush(); cur = { text: part, cites }; }
      } else {
        if (cur && (part.trim().length < 25 || !/[.!?]\s*$/.test(cur.text))) cur.text += part;
        else { flush(); cur = { text: part, cites: [] }; }
      }
      // close an item at the end of a sentence
      if (cur && /[.!?]\s*$/.test(cur.text) && cur.cites.length) flush();
    }
  }
  flush();
  for (const k of ["explanation", "gaps", "notCovered"]) out[k] = clean(out[k]).trim();
  out.unmatched = out.unmatched.filter(u => /[a-z]{3}/i.test(u.text) && u.text.length > 20);
  return out;
}

export async function POST(request) {
  const provider = PROVIDER();
  if (!provider) return json({ code: "not_configured", message: "The answer service is not set up yet." }, 503);
  const key = provider === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.GROQ_API_KEY;
  const MODEL = MODEL_FOR(provider);

  // Same-site callers only (light protection; the real limit is your Anthropic spend limit).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json({ code: "forbidden", message: "Cross-site requests are not allowed." }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ code: "bad_request", message: "Send JSON." }, 400); }
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, MAX_Q) : "";
  const deep = body?.depth === "deep";
  const original = typeof body?.original === "string" ? body.original.trim().slice(0, MAX_Q) : "";
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))].filter(id => BY_ID.has(id)).slice(0, MAX_IDS) : [];
  if (question.length < 3) return json({ code: "bad_request", message: "Ask a question of at least 3 characters." }, 400);
  if (!ids.length) return json({ code: "no_passages", message: "No passages were selected for this question." }, 400);

  const ckey = question.toLowerCase() + "|" + (deep ? "deep|" : "") + ids.join(",");
  const hit = cache.get(ckey);
  if (hit && Date.now() - hit.at < CACHE_MS) return json({ ...hit.body, cached: true });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return json({ code: "rate_limited", message: "Too many questions in a short time. Wait a minute and try again." }, 429, { "retry-after": "60" });

  if (provider === "groq") {
    let r;
    try { r = await askGroq(question + (original && original !== question ? `\n(The reader typed: ${original})` : ""), ids, key, MODEL, deep); }
    catch { return json({ code: "upstream_error", message: "The answer service did not respond. Try again." }, 502); }
    if (r.error) {
      console.error("groq_error", r.error, r.type, r.message);
      if (r.error === 429) return json({ code: "rate_limited", message: "Today's free answer limit is used up, or the service is busy. Try again later." }, 429);
      if (r.type === "invalid_json") return json({ code: "invalid_json", message: "The answer came back in a format Unravel couldn't check." }, 502);
      return json({ code: "upstream_error", message: "The answer service returned an error." }, 502);
    }
    const out = { ...r.out, provider, snapshot: SNAPSHOT };
    cache.set(ckey, { at: Date.now(), body: out });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return json(out);
  }

  const payload = {
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [...ids.map(id => searchResult(BY_ID.get(id))), { type: "text", text: "Question: " + question }]
    }]
  };

  let res, data;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000)
    });
    data = await res.json();
  } catch (e) {
    return json({ code: "upstream_error", message: "The answer service did not respond. Try again." }, 502);
  }
  if (!res.ok) {
    const type = data?.error?.type || "";
    const status = res.status === 429 || type === "rate_limit_error" ? 429 : res.status === 529 || type === "overloaded_error" ? 503 : 502;
    const message = status === 429 ? "The answer service is busy. Wait a minute and try again." : status === 503 ? "The answer service is overloaded. Try again shortly." : "The answer service returned an error.";
    console.error("anthropic_error", res.status, type, data?.error?.message);
    return json({ code: status === 429 ? "rate_limited" : "upstream_error", message }, status);
  }

  const shaped = shape(data.content, ids);
  const out = { ...shaped, checked: "citations", provider, model: data.model || MODEL, stop: data.stop_reason, snapshot: SNAPSHOT };
  cache.set(ckey, { at: Date.now(), body: out });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return json(out);
}

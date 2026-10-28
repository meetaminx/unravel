// Unravel answer endpoint.
// POST /api/answer  { question: string, ids: string[] }  ->  { verified, explanation, gaps, model }
// GET  /api/answer  ->  { configured: boolean }
//
// The browser picks the best passages (ids) from the corpus. This function sends only
// those passages to the Claude API as search_result blocks with citations enabled,
// then turns Claude's cited text blocks into "From the docs" sentences. Anything Claude
// writes without a citation is never shown as fact.

import { PASSAGES, SOURCES, SNAPSHOT } from "../lib/corpus.js";

export const maxDuration = 60;

const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
const MODEL = process.env.UNRAVEL_MODEL || "claude-sonnet-5-5";
const MAX_IDS = 8;
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
  return json({ configured: !!process.env.ANTHROPIC_API_KEY, model: MODEL, snapshot: SNAPSHOT });
}

const SYSTEM = `You are Unravel, a documentation assistant for Zcash developers and newcomers.
Answer only from the search results provided. Do not use outside knowledge for facts.
Write plainly and explain jargon in a few words. Never use em dashes.

Reply in this exact structure:
1. The answer: 2 to 6 short sentences. Every sentence must be supported by the search results. Copy numbers, block heights and method names exactly as the results write them.
2. A line that starts with "EXPLANATION:" followed by at most 80 words of plain background, an analogy or practical advice that the results do not state directly. Leave it out if there is nothing useful to add.
3. Only if results conflict, or a result marked (Secondary) or (Proposal) is the only support for a key point, a line that starts with "GAPS:" saying so in one or two sentences.

If the search results do not answer the question, reply with only one line: "NOT_COVERED:" followed by one sentence naming what is missing. Do not guess.`;

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
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ code: "not_configured", message: "The answer service is not set up yet." }, 503);

  // Same-site callers only (light protection; the real limit is your Anthropic spend limit).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json({ code: "forbidden", message: "Cross-site requests are not allowed." }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ code: "bad_request", message: "Send JSON." }, 400); }
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, MAX_Q) : "";
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))].filter(id => BY_ID.has(id)).slice(0, MAX_IDS) : [];
  if (question.length < 3) return json({ code: "bad_request", message: "Ask a question of at least 3 characters." }, 400);
  if (!ids.length) return json({ code: "no_passages", message: "No passages were selected for this question." }, 400);

  const ckey = question.toLowerCase() + "|" + ids.join(",");
  const hit = cache.get(ckey);
  if (hit && Date.now() - hit.at < CACHE_MS) return json({ ...hit.body, cached: true });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return json({ code: "rate_limited", message: "Too many questions in a short time. Wait a minute and try again." }, 429, { "retry-after": "60" });

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
  const out = { ...shaped, model: data.model || MODEL, stop: data.stop_reason, snapshot: SNAPSHOT };
  cache.set(ckey, { at: Date.now(), body: out });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return json(out);
}

// app/api/curator-note/route.ts
//
// Server-side only: takes a compact summary of the world's own computed
// stats (never the raw table, never the API key) and asks Gemini for one
// plain, factual insight grounded only in the numbers we send.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CACHE_TTL_MS = 3 * 60 * 1000;

let cache: { signature: string; note: string; expires: number } | null = null;

function buildPrompt(facts: unknown): string {
  return `You analyze usage data for Infinite Terra, a shared world where users add terrain, buildings, animals, weather cells, vegetation, and drawn clouds.

Given this JSON summary, return ONE short insight. Prefer comparing themes, mood labels, recent pace vs average, densest spots, or what type dominates.

DATA:
${JSON.stringify(facts, null, 2)}

Rules:
- 1 sentence, max 25 words
- Use concrete numbers or labels from the data (counts, mood labels, weather conditions, pace)
- Sound like a product analytics blurb, not a novel
- You may mention paletteMoodLabel or weatherMood as factual tone signals when present
- No metaphors, no poetry, no "world feels...", no "continues to", no quotes
- No markdown or emoji
- If sparse, say: Not enough data yet.`;
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ note: null, reason: 'not_configured' });
  }

  let facts: unknown;
  try {
    facts = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const signature = JSON.stringify(facts);
  const now = Date.now();
  if (cache && cache.signature === signature && cache.expires > now) {
    return NextResponse.json({ note: cache.note, cached: true });
  }

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(facts) }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 120,
          // gemini-2.5-flash "thinks" by default; that can eat the whole
          // token budget before writing anything. Off for short insights.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ note: null, reason: `gemini_${res.status}` });
    }

    const data = await res.json();
    const text: unknown = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const note = typeof text === 'string' ? text.trim() : null;
    if (note) cache = { signature, note, expires: now + CACHE_TTL_MS };
    return NextResponse.json({ note });
  } catch {
    return NextResponse.json({ note: null, reason: 'request_failed' });
  }
}

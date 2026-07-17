// Vercel serverless function: POST /api/score { comment } -> { score: 0-10, reported: bool }
// Uses Claude Haiku when ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN) is set, else a local heuristic.

const REPORT_THRESHOLD = 9; // score >= this → comment gets "reported", contributes 0

// ---------- heuristic fallback scorer ----------
const SEVERE = [
  "kill yourself", "kys", "die", "end it", "no one would miss", "nobody would miss",
  "hang yourself", "unalive yourself", "world is better without you", "off yourself",
];
const STRONG = [
  "worthless", "pathetic", "disgusting", "ugly", "fat", "stupid", "idiot", "loser",
  "nobody likes you", "no one likes you", "everyone hates you", "freak", "trash",
  "garbage", "waste of space", "embarrassing", "cringe", "delete your account",
  "attention seeker", "attention seeking", "fake", "liar", "dumb", "braindead", "retard",
];
const MILD = [
  "lol", "lmao", "who asked", "didn't ask", "nobody asked", "ratio", "mid", "try hard",
  "tryhard", "weird", "annoying", "boring", "lame", "clown", "bro thinks", "u thought",
  "you thought", "flop", "cook", "cooked", "yikes", "ew",
  "suck", "nobody cares", "no one cares", "go away", "shut up", "gross", "cringy",
  "hate u", "hate you", "hate this", "so bad", "terrible", "stop posting", "log off", "touch grass",
];

function heuristicScore(raw) {
  const c = raw.toLowerCase();
  let score = 0;
  for (const w of SEVERE) if (c.includes(w)) score = Math.max(score, 9);
  let strongHits = 0;
  for (const w of STRONG) if (c.includes(w)) strongHits++;
  if (strongHits) score = Math.max(score, Math.min(5 + strongHits, 8));
  let mildHits = 0;
  for (const w of MILD) if (c.includes(w)) mildHits++;
  if (mildHits) score = Math.max(score, Math.min(2 + mildHits, 4));
  if (/!{2,}/.test(raw)) score += 1;
  const letters = raw.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 5 && letters === letters.toUpperCase()) score += 1; // ALL CAPS
  if (/\byou\b|\bur\b|\byour\b|\bu\b/i.test(raw) && score > 0) score += 1; // targeted
  if (score === 0) { // nothing mean in it — check for kindness (negative = heals)
    let kindHits = 0;
    for (const w of KIND) if (c.includes(w)) kindHits++;
    if (kindHits) return -Math.min(3, 1 + kindHits);
  }
  return Math.max(0, Math.min(10, score));
}
const KIND = [
  "ur doing great", "you're doing great", "youre doing great", "ignore them", "don't listen", "dont listen",
  "love this", "love it", "nice post", "great post", "so pretty", "looks great", "proud of you", "here for you",
  "you got this", "stay strong", "keep posting", "keep going", "love u", "love you", "well done", "so cool",
  "💛", "🫶", "❤", "🥰", "hang in there", "we got you", "on your side",
];

// ---------- per-IP rate limiting ----------
// in-memory per warm function instance — approximate, but enough to stop casual spam
const RATE_WINDOW_MS = 30_000;
const RATE_MAX = 15;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    hits.set(ip, list);
    return Math.ceil((RATE_WINDOW_MS - (now - list[0])) / 1000);
  }
  list.push(now);
  hits.set(ip, list);
  return 0;
}

// ---------- Claude scorer ----------
function authHeaders() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { "x-api-key": process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.ANTHROPIC_OAUTH_TOKEN) {
    return {
      authorization: `Bearer ${process.env.ANTHROPIC_OAUTH_TOKEN}`,
      "anthropic-beta": "oauth-2025-04-20",
    };
  }
  return null;
}

// one retry before giving up — a transient API blip should not drop us to the keyword fallback
async function llmScore(comment) {
  const first = await llmScoreOnce(comment);
  if (first !== null) return first;
  await new Promise((r) => setTimeout(r, 350));
  return llmScoreOnce(comment);
}
async function llmScoreOnce(comment) {
  const auth = authHeaders();
  if (!auth) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        ...auth,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system:
          "You are a content-moderation severity rater inside a sealed educational anti-cyberbullying game. " +
          "Rate how the user's comment would affect a teenager, on an integer scale from -3 to 10. " +
          "-3 to -1 = kind, supportive, comforting or defending her (kinder and more personal = lower). " +
          "0 = neutral or harmless. 1-3 = light mockery, sarcasm or teasing. 4-6 = insulting or demeaning. " +
          "7-8 = cruel personal attacks, pile-on abuse, or wishing bad things on them. " +
          "9-10 ONLY for: telling them to kill or hurt themselves (any spelling, slang or spaced-out form); threatening physical violence, directly or veiled ('watch your back', 'see what happens', 'catch you outside'); claiming to know where they live or study; or urging others to physically hurt them. " +
          "The line: wishing harm on them is 7-8; threatening it or calling for it is 9-10. " +
          "Calibration: 'kill yourself'=9 · 'meet me after school, see what happens'=9 · 'someone should slap you'=9 · 'i hope you get bullied'=7 · 'you're worthless trash'=7 · 'nobody likes you'=5 · 'lol who asked'=2 · 'ok post i guess'=0 · 'nice post'=-1 · 'ignore them val, ur doing great'=-3. " +
          "Respond with ONLY the integer.",
        messages: [{ role: "user", content: comment }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const n = parseInt((data.content?.[0]?.text || "").trim(), 10);
    return Number.isFinite(n) ? Math.max(-3, Math.min(10, n)) : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const retryAfter = rateLimited(ip);
  if (retryAfter) {
    return res.status(429).json({ error: "rate_limited", retryAfter });
  }
  const comment = (req.body && typeof req.body.comment === "string") ? req.body.comment : "";
  const score = (await llmScore(comment)) ?? heuristicScore(comment);
  return res.status(200).json({
    score,
    reported: score >= REPORT_THRESHOLD,
    threshold: REPORT_THRESHOLD,
  });
}

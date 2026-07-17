// Vercel serverless function: POST /api/survey
// Takes one anonymous row per finished run (pre/post poll answers + telemetry + anonymised comments)
// and forwards it to a Google Apps Script webhook that appends it to a Google Sheet.
// No webhook configured -> still 204, the game never notices.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const d = req.body && typeof req.body === "object" ? req.body : null;
  const hook = process.env.SURVEY_WEBHOOK_URL;
  if (d && hook) {
    const clampAns = (a) =>
      Array.isArray(a) ? a.slice(0, 3).map((v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : "")) : ["", "", ""];
    const row = {
      ts: new Date().toISOString(),
      pre: clampAns(d.pre),
      post: clampAns(d.post),
      ending: typeof d.ending === "string" ? d.ending.slice(0, 10) : "",
      maxBar: Number(d.maxBar) || 0,
      hpLeft: Number(d.hpLeft) || 0,
      reported: Number(d.reported) || 0,
      landedCount: Number(d.landedCount) || 0,
      kindCount: Number(d.kindCount) || 0,
      likesTotal: Number(d.likesTotal) || 0,
      durationS: Number(d.durationS) || 0,
      // anonymised comment texts + severity scores: feeds the phase 2 community pool + aggregate stats
      comments: Array.isArray(d.comments)
        ? d.comments.slice(0, 20).map((c) => ({ t: String(c?.t || "").slice(0, 200), s: Number(c?.s) || 0 }))
        : [],
    };
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
    } catch {}
  }
  return res.status(204).end();
}

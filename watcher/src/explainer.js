// Pluggable explainer. It writes a plain-language explanation of the evidence.
// It NEVER changes the score: the score comes from the deterministic rules.
// If NEAR_AI_API_KEY is set, NEAR AI Cloud (OpenAI-compatible) writes the text.

const NEAR_AI_URL = process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1';
const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V3.1';

export function templateExplainer({ req, result }) {
  const top = [...result.rawSignals].sort((a, b) => b.weight - a.weight).filter((s) => s.weight > 0).slice(0, 3);
  if (!top.length) return `Nothing unusual about request #${req.id}. Score ${result.score}.`;
  return `Request #${req.id} scored ${result.score}/100 (confidence ${result.confidence}%). Main reasons: ${top
    .map((s) => s.detail.toLowerCase())
    .join('; ')}. This is a recommendation only; the owner or guardians decide.`;
}

export async function nearAiExplainer({ req, result }) {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return null;
  const body = {
    model: NEAR_AI_MODEL,
    temperature: 0,
    max_tokens: 160,
    messages: [
      { role: 'system', content: 'You explain treasury risk evidence in two short plain sentences. Never change the score. No advice to move funds.' },
      { role: 'user', content: JSON.stringify({ request: { id: req.id, asset: req.asset, to: req.to, amount: req.amount }, score: result.score, signals: result.rawSignals }) },
    ],
  };
  const r = await fetch(`${NEAR_AI_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`NEAR AI ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || null;
}

export async function explain(input) {
  try {
    const t = await nearAiExplainer(input);
    if (t) return { provider: `near-ai:${NEAR_AI_MODEL}`, text: t };
  } catch (e) {
    console.warn('explainer fallback:', e.message);
  }
  return { provider: 'template', text: templateExplainer(input) };
}

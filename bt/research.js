// Online research for adjustments: sends the Strategy Builder's position summary to Claude with the web
// search tool, which looks up published adjustment techniques for that structure and situation and
// answers with ranked, concrete adjustments plus the sources it used.
//
// Needs Anthropic API credentials (ANTHROPIC_API_KEY in .env, or an `ant auth login` profile).
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You help a trader manage a Nifty 50 index options position (NSE, weekly/monthly expiries, European, cash-settled).
You are given the current position, market state and the adjustments the app's rule engine already suggests.
Use web search to find well-established, published adjustment techniques for this exact structure and situation
(e.g. from tastylive, Option Alpha, Sensibull, Zerodha Varsity, CBOE, Opstra and experienced traders), then answer.

Answer in Markdown, concise, with these sections:
1. **Situation** — two or three sentences: what is threatened and why (tested side, delta, time to expiry, IV, support/resistance).
2. **Best adjustments** — 3 to 5 ranked options. For each: the exact orders using strikes from the given chain
   (e.g. "Buy back 24600 CE, sell 24700 CE"), what it does to risk/reward and Greeks, and when it is preferable.
   Include "do nothing / exit" when that is the better choice.
3. **Rules of thumb** — short bullets of the management rules your sources agree on (profit taking, stop, timing).
Keep it practical and specific to this position. Cite sources inline. Note that this is analysis, not investment advice.`;

function createResearch({ logError }) {
  let client = null;
  const cache = new Map();

  function getClient() {
    if (!client) client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth token / ant profile
    return client;
  }

  async function research(summary) {
    if (!summary || typeof summary !== 'string') throw new Error('Nothing to research — add a position first');
    const key = summary.slice(0, 4000);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60_000) return { ...hit.result, cached: true };

    const messages = [{ role: 'user', content: `Position and market right now:\n\n${key}\n\nFind and recommend the best adjustments.` }];
    let response;
    try {
      // The server may pause a long web-search turn; resume it a few times.
      for (let i = 0; i < 4; i++) {
        response = await getClient().beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          system: SYSTEM,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
          messages,
        });
        if (response.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: response.content });
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key is invalid — check ANTHROPIC_API_KEY in .env');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic API rate limit reached — try again in a minute');
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
      if (/api key|apiKey|authentication/i.test(e.message || '')) throw new Error('Online research needs an Anthropic API key: add ANTHROPIC_API_KEY=... to .env and restart the server');
      throw e;
    }
    if (response.stop_reason === 'refusal') throw new Error('The research request was declined');

    const text = [];
    const sources = new Map();
    for (const b of response.content) {
      if (b.type === 'text') {
        text.push(b.text);
        for (const c of b.citations || []) if (c.url) sources.set(c.url, c.title || c.url);
      } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url && !sources.has(r.url)) sources.set(r.url, r.title || r.url);
      }
    }
    const result = { text: text.join(''), sources: [...sources].map(([url, title]) => ({ url, title })).slice(0, 15), model: response.model, at: Date.now() };
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return result;
  }

  return { research: (s) => research(s).catch((e) => { logError('research', e); throw e; }) };
}

module.exports = { createResearch };

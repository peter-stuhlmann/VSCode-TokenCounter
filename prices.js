// Theoretische API-Preise in USD pro 1 Mio. Tokens (Anthropic-API, Stand siehe
// PRICES_AS_OF; Quelle: https://platform.claude.com/docs/en/about-claude/pricing).
// Mit dem Claude-Abo zahlst du nicht pro Token – das hier dient nur zum Vergleichen.
// Reihenfolge ist wichtig: spezifischere Präfixe zuerst.
const TABLE = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, fast: 2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, fast: 2 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, fast: 2 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }], // Cache-Read 0,05×
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-3-7-sonnet', { input: 3, output: 15, cacheRead: 0.3 }],
  [
    'claude-haiku-5-5',
    {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      // Prompts über 100K Tokens kosten mehr
      above: { tokens: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 },
    },
  ],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25, cacheRead: 0.03 }],
];

const CACHE_WRITE_5M = 1.25; // × Input-Preis
const CACHE_WRITE_1H = 2;
const WEB_SEARCH_USD = 0.01; // $10 pro 1.000 Suchen
const US_ONLY = 1.1; // inference_geo "us" (nur USA) kostet das 1,1-Fache

// Eigene Preise aus der Einstellung tokenTracker.prices brauchen mindestens Zahlen
// für input und output (cacheRead ist optional, sonst 0,1 × input). Unvollständige
// Angaben würden sonst stillschweigend $0 ergeben – dann lieber die Tabelle nehmen.
const validOverride = (p) => p && Number.isFinite(p.input) && Number.isFinite(p.output) && (p.cacheRead === undefined || Number.isFinite(p.cacheRead));

function lookup(model, overrides = {}) {
  const id = model.replace(/\[.*\]$/, ''); // z. B. "claude-opus-5-5[1m]"
  if (validOverride(overrides[id])) return overrides[id];
  for (const [prefix, p] of TABLE) if (id.startsWith(prefix)) return p;
  return null;
}

// Kosten einer einzelnen API-Antwort in USD, oder null wenn das Modell unbekannt ist.
function costOf(model, u, overrides) {
  const p = lookup(model, overrides);
  if (!p) return null;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const cw1h = Math.min(cw, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const tier = p.above && input + cw + cr > p.above.tokens ? p.above : p;
  const fast = (u.speed === 'fast' ? p.fast || 1 : 1) * (u.inference_geo === 'us' ? US_ONLY : 1);
  const usd =
    (input * tier.input +
      output * tier.output +
      (cw - cw1h) * tier.input * CACHE_WRITE_5M +
      cw1h * tier.input * CACHE_WRITE_1H +
      cr * (tier.cacheRead ?? tier.input * 0.1)) /
    1e6;
  return usd * fast + (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
}

// Datum der letzten Prüfung gegen die offizielle Preisseite (JJJJ-MM-TT)
const PRICES_AS_OF = '2026-10-16';

module.exports = { costOf, PRICES_AS_OF };

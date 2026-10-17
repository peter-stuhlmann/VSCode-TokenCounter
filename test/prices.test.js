const { test } = require('node:test');
const assert = require('node:assert/strict');
const { costOf } = require('../prices');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const usage = (u) => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u });
const M = 1e6;

test('Opus 5.5: Input, Output, Cache-Write 5 min / 1 h, Cache-Read', () => {
  const u = usage({
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_1h_input_tokens: 1000 },
    cache_read_input_tokens: 10000,
  });
  // 1000×4 + 2000×20 + 2000×4×1,25 + 1000×4×2 + 10000×0,20
  near(costOf('claude-opus-5-5', u), (4000 + 40000 + 10000 + 8000 + 2000) / M);
});

test('Präfixe: Opus 5 wird nicht als Opus 5.5 berechnet', () => {
  near(costOf('claude-opus-5', usage({ input_tokens: M })), 5);
  near(costOf('claude-opus-5-5', usage({ input_tokens: M })), 4);
  near(costOf('claude-fable-5', usage({ cache_read_input_tokens: M })), 1);
  near(costOf('claude-fable-5-1', usage({ cache_read_input_tokens: M })), 0.25);
});

test('Suffixe wie [1m] und Datumsversionen', () => {
  near(costOf('claude-opus-5-5[1m]', usage({ output_tokens: M })), 20);
  near(costOf('claude-sonnet-4-5-20250929', usage({ output_tokens: M })), 15);
});

test('Fast Mode kostet bei Opus 5.5, Opus 5 und Opus 4.8 das Doppelte', () => {
  near(costOf('claude-opus-5-5', usage({ output_tokens: M, speed: 'fast' })), 40);
  near(costOf('claude-opus-5-5', usage({ output_tokens: M, speed: 'standard' })), 20);
  near(costOf('claude-opus-5', usage({ input_tokens: M, speed: 'fast' })), 10);
  near(costOf('claude-opus-4-8', usage({ output_tokens: M, speed: 'fast' })), 50);
});

test('Cache-Read: 0,05× bei Opus 5.5 und Sonnet 5.5, 0,025× bei Fable 5.1, sonst 0,1×', () => {
  const read = (m) => costOf(m, usage({ cache_read_input_tokens: M }));
  near(read('claude-opus-5-5'), 0.2);
  near(read('claude-sonnet-5-5'), 0.1);
  near(read('claude-sonnet-5'), 0.2);
  near(read('claude-fable-5-1'), 0.25);
  near(read('claude-opus-4-8'), 0.5);
});

test('Verarbeitung nur in den USA (inference_geo "us") kostet das 1,1-Fache', () => {
  near(costOf('claude-opus-5-5', usage({ output_tokens: M, inference_geo: 'us' })), 22);
  near(costOf('claude-opus-5-5', usage({ output_tokens: M, inference_geo: 'global' })), 20);
});

test('Haiku 5.5: höherer Preis über 100K Tokens Prompt', () => {
  near(costOf('claude-haiku-5-5', usage({ input_tokens: 100000, output_tokens: M })), 0.01 + 0.5);
  near(costOf('claude-haiku-5-5', usage({ input_tokens: 60000, cache_read_input_tokens: 50000, output_tokens: M })), 0.03 + 0.0025 + 2.5);
});

test('Websuche: $10 pro 1.000 Suchen', () => {
  near(costOf('claude-opus-5-5', usage({ server_tool_use: { web_search_requests: 3 } })), 0.03);
});

test('unbekanntes Modell -> null, eigene Preise per Einstellung', () => {
  assert.equal(costOf('gpt-irgendwas', usage({ output_tokens: M })), null);
  near(costOf('claude-neu', usage({ output_tokens: M }), { 'claude-neu': { input: 1, output: 3, cacheRead: 0.1 } }), 3);
  // Einstellung schlägt die eingebaute Tabelle
  near(costOf('claude-opus-5-5', usage({ output_tokens: M }), { 'claude-opus-5-5': { input: 1, output: 9 } }), 9);
});

test('unvollständige eigene Preise werden ignoriert statt $0 zu ergeben', () => {
  // nur output angegeben -> Tabelle gilt
  near(costOf('claude-opus-5-5', usage({ input_tokens: M }), { 'claude-opus-5-5': { output: 9 } }), 4);
  // unbekanntes Modell mit unvollständigem Preis -> unbepreist (null), nicht 0
  assert.equal(costOf('claude-x', usage({ output_tokens: M }), { 'claude-x': { output: 10 } }), null);
  assert.equal(costOf('claude-x', usage({ output_tokens: M }), { 'claude-x': { input: '3', output: 10 } }), null);
});

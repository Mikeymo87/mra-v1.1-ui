const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResults, parseClaudeSearchMessage, extractJsonArray, providerOrder, PROVIDER_LABEL } = require('../webTools');

test('providerOrder: Google first, then Jina, then Claude; only configured ones', () => {
  assert.deepEqual(providerOrder({ ANTHROPIC_API_KEY: 'a' }), ['claude']);
  assert.deepEqual(providerOrder({ JINA_API_KEY: 'j', ANTHROPIC_API_KEY: 'a' }), ['jina', 'claude']);
  assert.deepEqual(providerOrder({ GOOGLE_CSE_KEY: 'g', GOOGLE_CSE_ID: 'x', JINA_API_KEY: 'j', ANTHROPIC_API_KEY: 'a' }), ['google', 'jina', 'claude']);
  assert.deepEqual(providerOrder({ GOOGLE_CSE_KEY: 'g' }), [], 'Google needs both key and id');
  assert.equal(PROVIDER_LABEL.claude, 'Claude Web Search');
});

test('normalizeResults: https only, dedupe by URL, description falls back to title, limit', () => {
  const out = normalizeResults([
    { title: 'A', url: 'https://a.com/', description: 'desc a' },
    { title: 'A again', url: 'https://A.com', description: 'dup' },
    { title: 'B', url: 'http://b.org/page', description: '' },
    { title: 'bad', url: 'ftp://x', description: 'no' },
    { title: '', url: 'https://c.net' },
    { title: 'D', url: 'https://d.io' },
  ], 3);
  assert.deepEqual(out, [
    { title: 'A', url: 'https://a.com/', description: 'desc a' },
    { title: 'B', url: 'http://b.org/page', description: 'B' },
    { title: 'https://c.net', url: 'https://c.net', description: 'https://c.net' },
  ]);
});

const fixture = {
  content: [
    { type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'q' } },
    { type: 'web_search_tool_result', tool_use_id: 'x', content: [
      { type: 'web_search_result', title: 'Baptist Health opens new ER', url: 'https://example.com/er', page_age: 'September 20, 2026', encrypted_content: 'zzz' },
      { type: 'web_search_result', title: 'Second', url: 'https://example.com/two', encrypted_content: 'zzz' },
    ] },
    { type: 'text', text: 'Here you go:\n[{"title":"Baptist Health opens new ER","url":"https://example.com/er/","description":"New freestanding ER in Doral."},{"title":"Second","url":"https://example.com/two","description":"Coverage of the same opening."}]' },
  ],
};

test('parseClaudeSearchMessage: titles/urls from tool block, descriptions from JSON text', () => {
  const { results, error } = parseClaudeSearchMessage(fixture);
  assert.equal(error, null);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.com/er');
  assert.equal(results[0].description, 'New freestanding ER in Doral.');
  assert.equal(results[1].description, 'Coverage of the same opening.');
  assert.equal(results[0].page_age, 'September 20, 2026', 'tool-block metadata kept');
});

test('parseClaudeSearchMessage: error object on the tool result is surfaced', () => {
  const { results, error } = parseClaudeSearchMessage({ content: [
    { type: 'web_search_tool_result', tool_use_id: 'x', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'nothing' },
  ] });
  assert.equal(results.length, 0);
  assert.match(error, /max_uses_exceeded/);
});

test('parseClaudeSearchMessage: unparseable model text still yields tool-block results', () => {
  const { results } = parseClaudeSearchMessage({ content: [
    fixture.content[1],
    { type: 'text', text: 'Sorry, here is [not json' },
  ] });
  assert.equal(results.length, 2);
  assert.equal(results[0].description, '');
  assert.equal(normalizeResults(results)[0].description, 'Baptist Health opens new ER', 'normalize fills description from title');
});

test('extractJsonArray: structured-output object, bare array, fenced, embedded, garbage', () => {
  assert.equal(extractJsonArray('{"results":[{"url":"https://a"}]}').length, 1);
  assert.equal(extractJsonArray('[{"url":"https://a"},{"url":"https://b"}]').length, 2);
  assert.equal(extractJsonArray('```json\n[{"url":"https://a"}]\n```').length, 1);
  assert.equal(extractJsonArray('Here you go: [{"url":"https://a"}] done').length, 1);
  assert.deepEqual(extractJsonArray('see [this](https://x) and [that](https://y)'), []);
});

test('parseClaudeSearchMessage: model picks lead, unpicked tool results follow', () => {
  const { results } = parseClaudeSearchMessage({ content: [
    { type: 'web_search_tool_result', tool_use_id: 'x', content: [
      { type: 'web_search_result', title: 'Noise', url: 'https://noise.com' },
      { type: 'web_search_result', title: 'Signal', url: 'https://signal.com' },
    ] },
    { type: 'text', text: '{"results":[{"title":"Signal","url":"https://signal.com","description":"the one"}]}' },
  ] });
  assert.deepEqual(results.map(r => r.url), ['https://signal.com', 'https://noise.com']);
  assert.equal(results[0].description, 'the one');
});

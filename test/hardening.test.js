import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, refreshClientId, resolveMedia } from '../src/index.js';

const storage = new Map();
globalThis.gopeed = {
  logger: { debug() {}, info() {}, warn() {} },
  storage: { get: (k) => storage.get(k), set: (k, v) => storage.set(k, v), remove: (k) => storage.delete(k) },
  settings: {},
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => body });

test('sanitize: dot-only and dot-led names cannot escape or hide', () => {
  assert.equal(sanitize('..'), 'track');
  assert.equal(sanitize('.'), 'track');
  assert.equal(sanitize('...'), 'track');
  assert.equal(sanitize('../../etc'), '-..-etc');
  assert.equal(sanitize('. .hidden'), 'hidden');
  assert.equal(sanitize('.mix 2024'), 'mix 2024');
});

test('sanitize: blank and control characters', () => {
  assert.equal(sanitize('   '), 'track');
  assert.equal(sanitize(undefined), 'track');
  assert.equal(sanitize('a\nb\tc\u0000'), 'abc');
  assert.equal(sanitize('Dark Techno: Vol. 2?'), 'Dark Techno- Vol. 2-');
});

test('refreshClientId: parallel 403s share one extraction', async () => {
  let pageFetches = 0;
  globalThis.fetch = async (url) => {
    if (url === 'https://soundcloud.com') {
      pageFetches++;
      return ok('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>');
    }
    return ok('x={client_id:"NEWCLIENTID0123456789abcd"}');
  };
  const ids = await Promise.all(Array.from({ length: 8 }, () => refreshClientId('OLDCLIENTID0123456789abcd')));
  assert.equal(pageFetches, 1);
  assert.ok(ids.every((id) => id === 'NEWCLIENTID0123456789abcd'));

  // A later rejection of the fresh id triggers a new extraction
  await refreshClientId('NEWCLIENTID0123456789abcd');
  assert.equal(pageFetches, 2);
});

test('resolveMedia: honours the re-resolve limit', async () => {
  const aacOnly = {
    title: 't',
    permalink_url: 'https://soundcloud.com/a/t',
    media: { transcodings: [{ preset: 'aac_160k', url: 'u', format: { protocol: 'hls', mime_type: 'audio/mp4' } }] },
  };
  let resolves = 0;
  globalThis.fetch = async () => {
    resolves++;
    return ok(aacOnly);
  };
  await resolveMedia(aacOnly, 'id', 'progressive', true, 1);
  assert.equal(resolves, 1);

  resolves = 0;
  await resolveMedia(aacOnly, 'id', 'progressive', true);
  assert.equal(resolves, 3);

  resolves = 0;
  await resolveMedia(aacOnly, 'id', 'auto', true);
  assert.equal(resolves, 0);
});

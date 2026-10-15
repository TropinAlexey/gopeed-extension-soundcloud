import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { expandShortUrl, canonicalFromHtml } from '../src/index.js';

const SHORT = 'https://on.soundcloud.com/2iQZMwo9IQ8wLY3vf9';
const FULL = 'https://soundcloud.com/ilaytsa/crashout';
const SHARED = `${FULL}?si=34a274925508434c9b3a072edf87967b&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing`;

globalThis.gopeed = { logger: { debug() {}, info() {}, warn() {} } };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Fake fetch: `manual` answers the manual-redirect request, `follow` the default one
function mockFetch({ manual, follow }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(init.redirect || 'follow');
    const handler = init.redirect === 'manual' ? manual : follow;
    if (!handler) throw new Error('unexpected request');
    return handler(url);
  };
  return calls;
}

const response = ({ status = 200, location = null, url = '', body = '' }) => ({
  status,
  ok: status >= 200 && status < 300,
  url,
  headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
  text: async () => body,
});

test('expandShortUrl: leaves full URLs untouched without any request', async () => {
  mockFetch({});
  assert.equal(await expandShortUrl(SHARED), SHARED);
  assert.equal(await expandShortUrl('https://soundcloud.com/a/sets/b'), 'https://soundcloud.com/a/sets/b');
});

test('expandShortUrl: uses the Location header and strips share tracking', async () => {
  const calls = mockFetch({ manual: () => response({ status: 302, location: SHARED }) });
  assert.equal(await expandShortUrl(SHORT), FULL);
  assert.deepEqual(calls, ['manual']);
});

test('expandShortUrl: falls back to the final response URL when manual redirect is unsupported', async () => {
  mockFetch({
    manual: () => {
      throw new Error('redirect mode not supported');
    },
    follow: () => response({ url: SHARED }),
  });
  assert.equal(await expandShortUrl(SHORT), FULL);
});

test('expandShortUrl: falls back to the canonical link when the response URL is unknown', async () => {
  mockFetch({
    manual: () => response({ status: 200 }),
    follow: () => response({ url: SHORT, body: `<html><link rel="canonical" href="${FULL}"></html>` }),
  });
  assert.equal(await expandShortUrl(SHORT), FULL);
});

test('expandShortUrl: keeps secret-link tokens in the path', async () => {
  const secret = 'https://soundcloud.com/user/track/s-AbCdEf123';
  mockFetch({ manual: () => response({ status: 302, location: `${secret}?si=x&utm_source=clipboard` }) });
  assert.equal(await expandShortUrl(SHORT), secret);
});

test('expandShortUrl: reports dead short links', async () => {
  mockFetch({ manual: () => response({ status: 404 }), follow: () => response({ status: 404 }) });
  await assert.rejects(expandShortUrl('https://on.soundcloud.com/nope'), /invalid or expired/);
});

test('canonicalFromHtml: reads og:url when there is no canonical link', () => {
  assert.equal(canonicalFromHtml(`<meta property="og:url" content="${FULL}">`), FULL);
  assert.equal(canonicalFromHtml('<html></html>'), null);
});

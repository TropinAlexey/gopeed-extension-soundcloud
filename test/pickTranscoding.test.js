import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTranscoding } from '../src/index.js';

const t = (protocol, mime_type) => ({ format: { protocol, mime_type } });

const mpeg = t('progressive', 'audio/mpeg');
const progressiveOther = t('progressive', 'audio/wav');
const hlsAac = t('hls', 'audio/mp4; codecs="aac"');
const hlsOpus = t('hls', 'audio/opus');

test('pickTranscoding: empty/missing input returns null', () => {
  assert.equal(pickTranscoding([], 'progressive'), null);
  assert.equal(pickTranscoding(undefined, 'progressive'), null);
});

test('pickTranscoding: progressive prefers mpeg progressive over others', () => {
  assert.equal(pickTranscoding([hlsAac, progressiveOther, mpeg], 'progressive'), mpeg);
});

test('pickTranscoding: progressive falls back to any progressive, then hls aac, then first', () => {
  assert.equal(pickTranscoding([hlsAac, progressiveOther], 'progressive'), progressiveOther);
  assert.equal(pickTranscoding([hlsAac, hlsOpus], 'progressive'), hlsAac);
  assert.equal(pickTranscoding([hlsOpus], 'progressive'), hlsOpus);
});

test('pickTranscoding: hls_aac prefers hls aac over progressive', () => {
  assert.equal(pickTranscoding([progressiveOther, hlsAac], 'hls_aac'), hlsAac);
  assert.equal(pickTranscoding([progressiveOther, hlsOpus], 'hls_aac'), progressiveOther);
  assert.equal(pickTranscoding([hlsOpus], 'hls_aac'), hlsOpus);
});

test('pickTranscoding: auto/unknown quality prefers progressive, then hls aac, then first', () => {
  assert.equal(pickTranscoding([hlsAac, progressiveOther], 'auto'), progressiveOther);
  assert.equal(pickTranscoding([hlsOpus, hlsAac], 'auto'), hlsAac);
  assert.equal(pickTranscoding([hlsOpus], 'unknown-quality'), hlsOpus);
});

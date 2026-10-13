import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTranscoding, rankTranscodings } from '../src/index.js';

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

test('pickTranscoding: auto/unknown quality prefers hls aac (best quality), then progressive, then first', () => {
  assert.equal(pickTranscoding([progressiveOther, hlsAac], 'auto'), hlsAac);
  assert.equal(pickTranscoding([hlsOpus, progressiveOther], 'auto'), progressiveOther);
  assert.equal(pickTranscoding([hlsOpus], 'unknown-quality'), hlsOpus);
});

// Real-world transcoding sets captured from api-v2 /resolve (Oct 2026)
const fmp4 = 'audio/mp4; codecs="mp4a.40.2"';
const tp = (protocol, mime_type, preset, snipped = false) => ({ format: { protocol, mime_type }, preset, snipped });
const aac160 = tp('hls', fmp4, 'aac_160k');
const aac96 = tp('hls', fmp4, 'aac_96k');
const abr = tp('hls', 'audio/mpegurl', 'abr_sq');
const hlsMp3 = tp('hls', 'audio/mpeg', 'mp3_1_0');
const progMp3 = tp('progressive', 'audio/mpeg', 'mp3_1_0');

test('pickTranscoding: HLS-only fMP4 track picks aac_160k regardless of order', () => {
  for (const quality of ['progressive', 'hls_aac', 'auto']) {
    assert.equal(pickTranscoding([aac160, aac96, abr], quality), aac160);
    assert.equal(pickTranscoding([abr, aac96, aac160], quality), aac160);
  }
});

test('pickTranscoding: adaptive abr_sq master playlist is never picked', () => {
  assert.equal(pickTranscoding([abr], 'progressive'), null);
});

test('pickTranscoding: legacy track — progressive prefers mp3, hls_aac/auto prefer aac', () => {
  const set = [aac160, aac96, abr, hlsMp3, progMp3];
  assert.equal(pickTranscoding(set, 'progressive'), progMp3);
  assert.equal(pickTranscoding(set, 'hls_aac'), aac160);
  assert.equal(pickTranscoding(set, 'auto'), aac160);
});

test('pickTranscoding: progressive prefers HLS mp3 over AAC when progressive is absent', () => {
  assert.equal(pickTranscoding([aac160, hlsMp3], 'progressive'), hlsMp3);
});

test('rankTranscodings: full fallback order, adaptive excluded', () => {
  const set = [abr, aac96, hlsMp3, aac160, progMp3];
  assert.deepEqual(rankTranscodings(set, 'auto'), [aac160, aac96, progMp3, hlsMp3]);
  assert.deepEqual(rankTranscodings(set, 'progressive'), [progMp3, hlsMp3, aac160, aac96]);
  assert.deepEqual(rankTranscodings(undefined, 'auto'), []);
});

test('pickTranscoding: without HLS support only progressive is eligible', () => {
  assert.equal(pickTranscoding([aac160, aac96, abr], 'progressive', { hls: false }), null);
  assert.equal(pickTranscoding([aac160, hlsMp3, progMp3], 'hls_aac', { hls: false }), progMp3);
});

test('pickTranscoding: full-length beats a snipped preview, preview is the last resort', () => {
  const previewProg = tp('progressive', 'audio/mpeg', 'mp3_1_0', true);
  assert.equal(pickTranscoding([previewProg, aac96], 'progressive'), aac96);
  assert.equal(pickTranscoding([previewProg], 'progressive'), previewProg);
});

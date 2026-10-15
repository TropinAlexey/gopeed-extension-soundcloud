const RESOLVE_URL = 'https://api-v2.soundcloud.com/resolve';
const CLIENT_ID_CACHE_KEY = 'sc_client_id';
// Fallback client_id — updated periodically, used if auto-extraction fails
const FALLBACK_CLIENT_ID = '3zaZfWDfnerez7S2gCmLG26KC2e2Q5zy';

// ── Client ID ─────────────────────────────────────────────────────────────────

async function getClientId() {
  const manual = gopeed.settings.clientId;
  if (manual && manual.trim()) return manual.trim();

  const cached = gopeed.storage.get(CLIENT_ID_CACHE_KEY);
  if (cached) return cached;

  try {
    return await extractClientId();
  } catch (e) {
    gopeed.logger.warn(`Auto-extraction failed, using fallback client_id: ${e.message}`);
    return FALLBACK_CLIENT_ID;
  }
}

async function extractClientId() {
  gopeed.logger.info('Extracting SoundCloud client_id...');

  const html = await fetch('https://soundcloud.com').then((r) => r.text());

  const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
    (m) => m[1]
  );

  if (scriptUrls.length === 0) {
    throw new Error('Could not find SoundCloud script URLs');
  }

  for (const url of scriptUrls.slice(-5).reverse()) {
    try {
      const js = await fetch(url).then((r) => r.text());
      // Try multiple patterns SoundCloud uses across versions
      const match =
        js.match(/[,{(]client_id:"([a-zA-Z0-9]{20,40})"/) ||
        js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,40})"/) ||
        js.match(/"client_id"\s*:\s*"([a-zA-Z0-9]{20,40})"/);
      if (match) {
        const id = match[1];
        gopeed.storage.set(CLIENT_ID_CACHE_KEY, id);
        gopeed.logger.info(`Extracted client_id: ${id}`);
        return id;
      }
    } catch (e) {
      gopeed.logger.warn(`Failed to parse script ${url}: ${e.message}`);
    }
  }

  throw new Error(
    'Could not extract client_id. Set it manually in extension settings.\n' +
      'Find it at: https://soundcloud.com → DevTools → Network → filter "client_id"'
  );
}

// ── SoundCloud API ────────────────────────────────────────────────────────────

// 403s from parallel playlist workers arrive together: share one re-extraction per rejected id
let clientIdRefresh = null;

function refreshClientId(rejectedId) {
  if (!clientIdRefresh || clientIdRefresh.rejectedId !== rejectedId) {
    clientIdRefresh = { rejectedId, promise: extractClientId().catch(() => FALLBACK_CLIENT_ID) };
  }
  return clientIdRefresh.promise;
}

const sleep = (ms) => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
const TRANSIENT_RETRIES = 2;

async function scGet(url, clientId, { _retried = false, _attempt = 0 } = {}) {
  const sep = url.includes('?') ? '&' : '?';
  let res;
  try {
    res = await fetch(`${url}${sep}client_id=${clientId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  } catch (e) {
    if (_attempt < TRANSIENT_RETRIES) {
      gopeed.logger.warn(`Network error (${e.message}), retrying...`);
      await sleep(1000 * (_attempt + 1));
      return scGet(url, clientId, { _retried, _attempt: _attempt + 1 });
    }
    throw e;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      gopeed.storage.remove(CLIENT_ID_CACHE_KEY);

      if (!_retried) {
        // Re-extract fresh client_id and retry once automatically
        gopeed.logger.warn(`client_id rejected (${res.status}), re-extracting and retrying...`);
        const freshId = await refreshClientId(clientId);
        return scGet(url, freshId, { _retried: true, _attempt });
      }

      throw new Error(
        `SoundCloud denied access (${res.status}) even with a fresh client_id — the track may be ` +
          'region-restricted, or set client_id manually in extension settings.'
      );
    }
    // api-v2 occasionally answers 404/429/5xx for perfectly valid resources — retry before giving up
    const transient = res.status === 404 || res.status === 429 || res.status >= 500;
    if (transient && _attempt < TRANSIENT_RETRIES) {
      gopeed.logger.warn(`SoundCloud API ${res.status}, retrying...`);
      await sleep(1000 * (_attempt + 1));
      return scGet(url, clientId, { _retried, _attempt: _attempt + 1 });
    }
    if (res.status === 404) throw new Error('Track not found or is private');
    throw new Error(`SoundCloud API error ${res.status} for: ${url}`);
  }

  return res.json();
}

async function resolveUrl(url, clientId) {
  return scGet(`${RESOLVE_URL}?url=${encodeURIComponent(url)}`, clientId);
}

// ── Short links ───────────────────────────────────────────────────────────────

const SHORT_LINK_RE = /^https?:\/\/on\.soundcloud\.com\//i;
const FULL_LINK_RE = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^?#]+/i;

const isShortLink = (url) => SHORT_LINK_RE.test(url || '');

// Full soundcloud.com URL without the share-tracking query (?si=…&utm_…)
function cleanFullUrl(url) {
  const match = (url || '').match(FULL_LINK_RE);
  return match ? match[0] : null;
}

function canonicalFromHtml(html) {
  const tag =
    html.match(/<link[^>]+rel="canonical"[^>]*>/i)?.[0] || html.match(/<meta[^>]+property="og:url"[^>]*>/i)?.[0] || '';
  return cleanFullUrl(tag.match(/(?:href|content)="([^"]+)"/i)?.[1]);
}

// on.soundcloud.com/<code> is a 302 to the full URL; api-v2 /resolve answers 404 for it.
// Gopeed's fetch differs between versions, so try the Location header, then the final
// response URL, then the page's canonical link.
async function expandShortUrl(url) {
  if (!isShortLink(url)) return url;

  try {
    const res = await fetch(url, { redirect: 'manual' });
    await res.body?.cancel?.();
    const full = cleanFullUrl(res.headers.get('location'));
    if (full) return full;
  } catch (e) {
    gopeed.logger.debug(`Manual redirect failed for ${url}: ${e.message}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new Error(`Short link ${url} is invalid or expired (HTTP ${res.status})`);
  }
  const full = (isShortLink(res.url) ? null : cleanFullUrl(res.url)) || canonicalFromHtml(await res.text());
  if (!full) throw new Error(`Could not expand short link ${url}`);
  return full;
}

async function getStreamUrl(transcodingUrl, clientId, trackAuthorization) {
  const url = trackAuthorization
    ? `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}track_authorization=${encodeURIComponent(trackAuthorization)}`
    : transcodingUrl;
  const data = await scGet(url, clientId);
  if (!data.url) throw new Error(`No URL in transcoding response: ${JSON.stringify(data)}`);
  return data.url;
}

// Gopeed got a native HLS protocol (m3u8 → one merged file) in v2.0.0-beta.3 —
// the same release that introduced `gopeed.host`, so its presence is the feature flag.
function supportsHls() {
  return typeof gopeed !== 'undefined' && !!gopeed.host;
}

// ── Transcoding selection ─────────────────────────────────────────────────────

const mime = (t) => t.format?.mime_type || '';
const isHls = (t) => t.format?.protocol === 'hls';
const isProgressive = (t) => t.format?.protocol === 'progressive';
const isMpegProgressive = (t) => isProgressive(t) && mime(t).includes('mpeg');
// SoundCloud labels AAC either as `audio/mp4; codecs="mp4a.40.2"` (fMP4) or `audio/aac`
const isHlsAac = (t) => isHls(t) && /aac|mp4a|audio\/mp4/.test(mime(t));
const isHlsMpeg = (t) => isHls(t) && mime(t).includes('audio/mpeg');
// `abr_*` presets are adaptive master playlists (`audio/mpegurl`) — the stream endpoint 404s on them
const isAdaptive = (t) => mime(t).includes('mpegurl') || (t.preset || '').startsWith('abr');

const isMp3 = (t) => mime(t).includes('audio/mpeg');

// Priority list per quality setting; first matching predicate wins, then any usable transcoding.
//   progressive — prefer MP3 (progressive, then HLS MP3), AAC only as a fallback
//   hls_aac / auto — best quality: AAC 160 kbps, which every track has nowadays
const QUALITY_PRIORITY = {
  progressive: [isMpegProgressive, isProgressive, isHlsMpeg, isHlsAac],
  hls_aac: [isHlsAac, isMpegProgressive, isProgressive, isHlsMpeg],
  auto: [isHlsAac, isMpegProgressive, isProgressive, isHlsMpeg],
};

// "aac_160k" → 160; unknown presets rank lowest
const bitrate = (t) => Number((t.preset || '').match(/(\d+)k/)?.[1] || 0);

// All usable transcodings, best first for the given quality setting.
function rankTranscodings(transcodings, quality = gopeed.settings.quality || 'auto', { hls = true } = {}) {
  if (!transcodings || transcodings.length === 0) return [];

  let candidates = transcodings.filter((t) => t?.format && !isAdaptive(t) && (hls || !isHls(t)));
  // Snipped = 30s preview (Go+ tracks); only fall back to it when nothing full-length exists
  const full = candidates.filter((t) => !t.snipped);
  if (full.length > 0) candidates = full;

  const priority = QUALITY_PRIORITY[quality] || QUALITY_PRIORITY.auto;
  const rank = (t) => {
    const i = priority.findIndex((predicate) => predicate(t));
    return i === -1 ? priority.length : i;
  };
  // Stable sort: by priority group, then higher bitrate first, then API order
  return candidates
    .map((t, i) => ({ t, i }))
    .sort((x, y) => rank(x.t) - rank(y.t) || bitrate(y.t) - bitrate(x.t) || x.i - y.i)
    .map(({ t }) => t);
}

function pickTranscoding(transcodings, quality, options) {
  return rankTranscodings(transcodings, quality, options)[0] || null;
}

function extFromMime(mimeType) {
  if (!mimeType) return '.mp3';
  if (mimeType.includes('mpeg')) return '.mp3';
  if (mimeType.includes('aac') || mimeType.includes('mp4')) return '.m4a';
  if (mimeType.includes('opus') || mimeType.includes('ogg')) return '.ogg';
  return '.mp3';
}

// Titles are author-controlled: a playlist named ".." would otherwise become a folder one level
// above the download dir (Gopeed's own SafeFilename keeps dots), and "   " an empty name.
function sanitize(name) {
  const clean = (name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/^[\s.]+/, '')
    .trim();
  return clean || 'track';
}

// ── Track resolution ──────────────────────────────────────────────────────────

// api-v2 returns a random subset of transcodings per request (progressive MP3 shows up
// in roughly every other response), so re-resolve a few times when the wanted format is missing.
// Playlists get a single retry so hundreds of tracks don't multiply into a 429 storm.
const MEDIA_RERESOLVES = 3;
const PLAYLIST_MEDIA_RERESOLVES = 1;

async function resolveMedia(track, clientId, quality, hls, maxReresolves = MEDIA_RERESOLVES) {
  const wantsMp3 = quality === 'progressive' || !hls;
  for (let attempt = 0; ; attempt++) {
    const ranked = rankTranscodings(track.media?.transcodings, quality, { hls });
    const satisfied = ranked.length > 0 && (!wantsMp3 || isMp3(ranked[0]));
    if (satisfied || attempt >= maxReresolves || !track.permalink_url) return { track, ranked };
    gopeed.logger.info(`Track "${track.title}": preferred format missing, re-resolving (${attempt + 1}/${maxReresolves})`);
    try {
      track = await resolveUrl(track.permalink_url, clientId);
    } catch (e) {
      return { track, ranked };
    }
  }
}

async function buildFileFromTrack(track, clientId, { maxReresolves } = {}) {
  if (track.policy === 'BLOCK') {
    throw new Error(`Track "${track.title}" is not available in your region`);
  }

  const quality = gopeed.settings.quality || 'auto';
  const hls = supportsHls();
  const resolved = await resolveMedia(track, clientId, quality, hls, maxReresolves);
  track = resolved.track;

  if (resolved.ranked.length === 0) {
    if (!hls && rankTranscodings(track.media?.transcodings, quality, { hls: true }).length > 0) {
      throw new Error(
        `Track "${track.title}" is only available as an HLS stream. ` +
          'Update Gopeed to v2.0.0-beta.3 or newer — it downloads HLS natively.'
      );
    }
    throw new Error(`No streamable format for: ${track.title}`);
  }

  // A listed transcoding is not always servable — fall through to the next best one
  let transcoding;
  let streamUrl;
  let lastError;
  for (const candidate of resolved.ranked) {
    try {
      streamUrl = await getStreamUrl(candidate.url, clientId, track.track_authorization);
      transcoding = candidate;
      break;
    } catch (e) {
      lastError = e;
      gopeed.logger.warn(`Track "${track.title}": ${candidate.preset} unavailable (${e.message}), trying next format`);
    }
  }
  if (!transcoding) throw lastError;

  gopeed.logger.info(
    `Track "${track.title}" → protocol=${transcoding.format.protocol} preset=${transcoding.preset} mime=${transcoding.format.mime_type}`
  );
  if (transcoding.snipped) {
    gopeed.logger.warn(`Track "${track.title}": only a 30s preview is available (Go+ / region restricted)`);
  }

  const ext = extFromMime(transcoding.format.mime_type);

  // Format: "Artist - Title.mp3"  e.g. "YAYATI - The greatest final.mp3"
  const artist = track.publisher_metadata?.artist || track.user?.permalink || track.user?.username || '';
  const prefix = artist ? `${sanitize(artist)} - ` : '';
  const suffix = transcoding.snipped ? ' (preview)' : '';
  return {
    name: `${prefix}${sanitize(track.title)}${suffix}${ext}`,
    req: {
      url: streamUrl,
    },
  };
}

// Playlists only embed full data for the first few tracks; the rest are stubs
// `{id, kind, policy, monetization_model}` that must be fetched by id.
const TRACKS_BATCH_SIZE = 50;

async function hydrateTracks(tracks, clientId) {
  const stubIds = tracks.filter((t) => !t.media).map((t) => t.id);
  const byId = new Map();
  for (let i = 0; i < stubIds.length; i += TRACKS_BATCH_SIZE) {
    const ids = stubIds.slice(i, i + TRACKS_BATCH_SIZE).join(',');
    try {
      const batch = await scGet(`https://api-v2.soundcloud.com/tracks?ids=${ids}`, clientId);
      for (const t of batch) byId.set(t.id, t);
    } catch (e) {
      gopeed.logger.warn(`Failed to fetch tracks batch: ${e.message}`);
    }
  }
  return tracks.map((t) => (t.media ? t : byId.get(t.id) || t));
}

const PLAYLIST_CONCURRENCY = 8;

// Promise.all with at most `limit` tasks in flight; results keep input order
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Main event ────────────────────────────────────────────────────────────────

// ponytail: guard lets this module be imported in tests without a live `gopeed` global
if (typeof gopeed !== 'undefined') {
  gopeed.events.onResolve(async (ctx) => {
    if (!gopeed.storage.get('chrome_ext_notified')) {
      gopeed.storage.set('chrome_ext_notified', true);
      gopeed.logger.info(
        '💡 Tip: install the SoundCloud→Gopeed Chrome extension for one-click downloads directly on SoundCloud pages: ' +
          'https://chromewebstore.google.com/detail/dibaaanimijeognedjonhifkigceppbh'
      );
    }

    const clientId = await getClientId();
    const url = await expandShortUrl(ctx.req.url);
    if (url !== ctx.req.url) gopeed.logger.info(`Short link ${ctx.req.url} → ${url}`);
    const data = await resolveUrl(url, clientId);

    gopeed.logger.info(`Resolved kind=${data.kind} title="${data.title}"`);

    if (data.kind === 'track') {
      const file = await buildFileFromTrack(data, clientId);
      ctx.res = {
        name: sanitize(data.title),
        files: [file],
      };
      return;
    }

    if (data.kind === 'playlist') {
      const tracks = await hydrateTracks(data.tracks || [], clientId);
      const results = await mapLimit(tracks, PLAYLIST_CONCURRENCY, async (track) => {
        // Still a stub (deleted/private track missing from the batch) — last try by permalink
        if (!track.media && track.permalink_url) {
          try {
            track = await resolveUrl(track.permalink_url, clientId);
          } catch (e) {
            gopeed.logger.warn(`Skipping stub track ${track.id}: ${e.message}`);
            return null;
          }
        }

        try {
          return await buildFileFromTrack(track, clientId, { maxReresolves: PLAYLIST_MEDIA_RERESOLVES });
        } catch (e) {
          gopeed.logger.warn(`Skipping track "${track.title || track.id}": ${e.message}`);
          return null;
        }
      });
      const files = results.filter(Boolean);

      if (files.length < tracks.length) {
        gopeed.logger.warn(`Playlist "${data.title}": ${files.length}/${tracks.length} tracks downloadable`);
      }

      if (files.length === 0) {
        throw new Error('No downloadable tracks found in playlist');
      }

      ctx.res = {
        name: sanitize(data.title),
        files,
      };
      return;
    }

    throw new Error(`Unsupported SoundCloud resource type: ${data.kind}`);
  });
}

export { pickTranscoding, rankTranscodings, expandShortUrl, canonicalFromHtml, sanitize, refreshClientId, resolveMedia };

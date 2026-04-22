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

async function scGet(url, clientId, { _retried = false } = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}client_id=${clientId}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      gopeed.storage.remove(CLIENT_ID_CACHE_KEY);

      if (!_retried) {
        // Re-extract fresh client_id and retry once automatically
        gopeed.logger.warn(`client_id rejected (${res.status}), re-extracting and retrying...`);
        const freshId = await extractClientId().catch(() => FALLBACK_CLIENT_ID);
        return scGet(url, freshId, { _retried: true });
      }

      throw new Error('client_id invalid even after re-extraction. Set it manually in extension settings.');
    }
    if (res.status === 404) throw new Error('Track not found or is private');
    throw new Error(`SoundCloud API error ${res.status} for: ${url}`);
  }

  return res.json();
}

async function resolveUrl(url, clientId) {
  return scGet(`${RESOLVE_URL}?url=${encodeURIComponent(url)}`, clientId);
}

async function getStreamUrl(transcodingUrl, clientId) {
  const data = await scGet(transcodingUrl, clientId);
  if (!data.url) throw new Error(`No URL in transcoding response: ${JSON.stringify(data)}`);
  return data.url;
}

// ── Transcoding selection ─────────────────────────────────────────────────────

function pickTranscoding(transcodings) {
  if (!transcodings || transcodings.length === 0) return null;

  const quality = gopeed.settings.quality || 'progressive';

  if (quality === 'progressive') {
    return (
      transcodings.find((t) => t.format.protocol === 'progressive' && t.format.mime_type.includes('mpeg')) ||
      transcodings.find((t) => t.format.protocol === 'progressive') ||
      transcodings.find((t) => t.format.protocol === 'hls' && t.format.mime_type.includes('aac')) ||
      transcodings[0]
    );
  }

  if (quality === 'hls_aac') {
    return (
      transcodings.find((t) => t.format.protocol === 'hls' && t.format.mime_type.includes('aac')) ||
      transcodings.find((t) => t.format.protocol === 'progressive') ||
      transcodings[0]
    );
  }

  // auto: progressive → hls aac → anything
  return (
    transcodings.find((t) => t.format.protocol === 'progressive') ||
    transcodings.find((t) => t.format.protocol === 'hls' && t.format.mime_type.includes('aac')) ||
    transcodings[0]
  );
}

function extFromMime(mimeType) {
  if (!mimeType) return '.mp3';
  if (mimeType.includes('mpeg')) return '.mp3';
  if (mimeType.includes('aac') || mimeType.includes('mp4')) return '.m4a';
  if (mimeType.includes('opus') || mimeType.includes('ogg')) return '.ogg';
  return '.mp3';
}

function sanitize(name) {
  return (name || 'track').replace(/[/\\?%*:|"<>]/g, '-').trim();
}

// ── Track resolution ──────────────────────────────────────────────────────────

async function buildFileFromTrack(track, clientId) {
  const transcodings = track.media?.transcodings;
  const transcoding = pickTranscoding(transcodings);

  if (!transcoding) {
    throw new Error(`No streamable format for: ${track.title}`);
  }

  gopeed.logger.info(
    `Track "${track.title}" → protocol=${transcoding.format.protocol} mime=${transcoding.format.mime_type}`
  );

  const streamUrl = await getStreamUrl(transcoding.url, clientId);
  const ext = extFromMime(transcoding.format.mime_type);

  // Format: "Artist - Title.mp3"  e.g. "YAYATI - The greatest final.mp3"
  const artist = track.user?.username || track.user?.permalink || '';
  const prefix = artist ? `${sanitize(artist)} - ` : '';
  return {
    name: `${prefix}${sanitize(track.title)}${ext}`,
    req: {
      url: streamUrl,
    },
  };
}

// ── Main event ────────────────────────────────────────────────────────────────

gopeed.events.onResolve(async (ctx) => {
  if (!gopeed.storage.get('chrome_ext_notified')) {
    gopeed.storage.set('chrome_ext_notified', true);
    gopeed.logger.info(
      '💡 Tip: install the SoundCloud→Gopeed Chrome extension for one-click downloads directly on SoundCloud pages: ' +
        'https://chromewebstore.google.com/detail/soundcloud-gopeed/jnlfajhpbkonkfcndefbkdmpifcmlonf'
    );
  }

  const clientId = await getClientId();
  const data = await resolveUrl(ctx.req.url, clientId);

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
    const tracks = data.tracks || [];
    const files = [];

    for (let i = 0; i < tracks.length; i++) {
      let track = tracks[i];

      // Playlist may contain stub tracks without media — resolve them individually
      if (!track.media) {
        try {
          track = await resolveUrl(track.permalink_url, clientId);
        } catch (e) {
          gopeed.logger.warn(`Skipping stub track "${track.title}": ${e.message}`);
          continue;
        }
      }

      try {
        const file = await buildFileFromTrack(track, clientId);
        files.push(file);
      } catch (e) {
        gopeed.logger.warn(`Skipping track "${track.title}": ${e.message}`);
      }
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

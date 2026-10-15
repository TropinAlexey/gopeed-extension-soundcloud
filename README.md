# Gopeed SoundCloud Extension

Download tracks and playlists from SoundCloud directly via [Gopeed](https://gopeed.com).

## Requirements

- [Gopeed](https://gopeed.com) **v2.0.0-beta.3+** (recommended) — downloads SoundCloud's HLS streams natively and merges them into a single `.m4a`
- Gopeed v1.6.0+ still works, but only for tracks that SoundCloud serves as progressive MP3 — most tracks are now HLS-only

## Installation

In Gopeed → **Extensions** → **Manual Install**, paste:

```
https://github.com/TropinAlexey/gopeed-extension-soundcloud
```

## Usage

Go to any SoundCloud URL, click track name, press button "Download":
<img width="478" height="57" alt="image" src="https://github.com/user-attachments/assets/981dfd5c-5611-44aa-a7a3-66839be7d3d8" />

The extension resolves the audio stream automatically and starts the download.

Supported links: tracks, playlists/albums (`soundcloud.com`, `www.`, `m.`), secret links (`…/s-XXXX`) and short share links from the SoundCloud app (`https://on.soundcloud.com/XXXX`).

**File naming:** `Artist - Title.m4a` (or `.mp3`)  
Example: `yayati - The greatest final.m4a`

Go+ tracks that SoundCloud only exposes as a 30-second preview are saved with a ` (preview)` suffix — uncheck them in the file list if you don't want them.

## Browser button

Install **[soundcloud-gopeed-button](https://github.com/TropinAlexey/soundcloud-gopeed-button)** — a Chrome extension that adds a native **Download** button directly on SoundCloud pages.

Once installed, clicking the button sends the current track or playlist URL to Gopeed automatically.

## Settings

| Setting | Default | Description |
|---|---|---|
| **Client ID** | *(auto)* | SoundCloud `client_id`. Leave empty for auto-detection. If auto-detection fails, find it in DevTools → Network on soundcloud.com and filter by `client_id`. |
| **Quality** | Best quality | `auto` — AAC 160 kbps `.m4a` (available for every track). `progressive` — prefer MP3 128 kbps, fall back to AAC when SoundCloud doesn't offer MP3. `hls_aac` — same as `auto`, kept for compatibility. |

## How it works

1. Expands `on.soundcloud.com` short links to the full URL (share tracking like `?si=…&utm_…` is dropped), then resolves it via the public `api-v2.soundcloud.com` API
2. Extracts `client_id` automatically from SoundCloud's page scripts (cached in local storage)
3. Selects the best audio transcoding for the chosen quality (adaptive `abr_*` playlists and 30s previews are skipped when a full-length stream exists)
4. Fetches the signed CDN stream URL and passes it to Gopeed — an `.m3u8` playlist is downloaded by Gopeed's native HLS engine and merged into one file
5. Playlists: tracks that SoundCloud returns as stubs are fetched in batches, all tracks are resolved in parallel

**Note:** SoundCloud's stream links are signed and expire about 2 hours after resolving. For very large playlists keep Gopeed's concurrent task limit reasonably high so every task starts within that window; a task that fails with 403 can be fixed by re-adding the URL.

## License

MIT

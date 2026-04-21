# Gopeed SoundCloud Extension

Download tracks and playlists from SoundCloud directly via [Gopeed](https://gopeed.com).

## Requirements

- [Gopeed](https://gopeed.com) v1.6.0+

## Installation

In Gopeed → **Extensions** → **Manual Install**, paste:

```
https://github.com/TropinAlexey/gopeed-extension-soundcloud
```

## Usage

Go to any SoundCloud URL, click track name, press button "Download":
<img width="478" height="57" alt="image" src="https://github.com/user-attachments/assets/981dfd5c-5611-44aa-a7a3-66839be7d3d8" />

The extension resolves the audio stream automatically and starts the download.

**File naming:** `permalink - Title.mp3`  
Example: `yayati - The greatest final.mp3`

## Browser button (optional)

Install **[soundcloud-gopeed-button](https://github.com/TropinAlexey/soundcloud-gopeed-button)** — a Chrome extension that adds a native **Download** button directly on SoundCloud pages.

Once installed, clicking the button sends the current track or playlist URL to Gopeed automatically.

![SoundCloud Download button](https://raw.githubusercontent.com/TropinAlexey/gopeed-extension-soundcloud/main/screenshot.png)

## Settings

| Setting | Default | Description |
|---|---|---|
| **Client ID** | *(auto)* | SoundCloud `client_id`. Leave empty for auto-detection. If auto-detection fails, find it in DevTools → Network on soundcloud.com and filter by `client_id`. |
| **Quality** | Progressive MP3 | `progressive` — direct MP3 download (best). `hls_aac` — HLS AAC 160 kbps. `auto` — progressive first, then HLS. |

## How it works

1. Resolves the SoundCloud URL via the public `api-v2.soundcloud.com` API
2. Extracts `client_id` automatically from SoundCloud's page scripts (cached in local storage)
3. Selects the best audio transcoding (progressive MP3 preferred)
4. Fetches the actual CDN stream URL and passes it to Gopeed

## Build from source

```bash
npm install
npm run build   # outputs dist/index.js
```

## License

MIT

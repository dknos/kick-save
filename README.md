# kick-save

Download Kick.com VODs, clips, and live streams. Capture chat. View multiple streams in a grid.

**~5 MB** portable binary — no runtime, no install. Just download and run.

## Features

- **Browse & download VODs** — list a channel's past broadcasts, multi-select, download in parallel
- **Download clips** — browse and batch-download channel clips
- **Record live streams** — capture a live broadcast as it happens
- **Time range clipping** — download only a portion (e.g. `2:35:35-3:00:35`)
- **Quality selection** — 720p60, 480p30, 360p30, 160p30
- **Chat capture** — save chat messages to `.txt` and `.json` alongside the video
- **Multi-stream viewer** — open multiple live streams in a grid (GridPlayer/mpv/VLC)
- **Portable exe** — single file, no install required (Windows + Linux)

## Quick Start

### Windows
Download `kick-save.exe` from [Releases](../../releases), then:
```
kick-save.exe                              # interactive mode
kick-save.exe kick.com/channel             # browse channel
kick-save.exe kick.com/user/videos/UUID    # direct VOD download
kick-save.exe URL -t 2:35:35-3:00:35      # time range clip
kick-save.exe URL -q 480p30 -c            # 480p + chat capture
```

### From source
```bash
git clone https://github.com/dknos/kick-save.git
cd kick-save
go build -ldflags="-s -w" -o kick-save .
```

### Cross-compile
```bash
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o kick-save.exe .
```

## Requirements

- **ffmpeg** — auto-downloaded on first run, or install manually and add to PATH
- **curl** — built into Windows 10+, pre-installed on Linux/macOS
- **GridPlayer/mpv/VLC** (optional) — for multi-stream viewing

## Usage

### Interactive mode
```
$ kick-save

  ╔═══════════════════════════════════════════╗
  ║         KICK STREAM SAVER v2.0.0          ║
  ║   VODs · Clips · Live · Chat · Multi      ║
  ╚═══════════════════════════════════════════╝

  1  Browse channel (VODs, clips, live)
  2  Enter direct VOD/clip URL
  3  Multi-stream viewer
  4  Quit
```

### CLI flags
| Flag | Description | Default |
|------|-------------|---------|
| `-q` | Video quality | `720p60` |
| `-o` | Output directory | `.` |
| `-t` | Time range (`H:MM:SS-H:MM:SS`) | full |
| `-c` | Capture chat | off |
| `-m3u8` | Direct m3u8 URL (skip extraction) | — |
| `-v` | Show version | — |

### Time range examples
```
kick-save URL -t 0:30:00-1:00:00      # 30 min clip starting at 30m
kick-save URL -t 2:35:35-3:00:35      # 25 min clip
kick-save URL -t 10:00-15:00          # 5 min clip (MM:SS)
```

### Multi-stream viewer
Watch and optionally record multiple channels simultaneously:
```
  ? Channels to watch: channel1, channel2, channel3
  ? Video player: GridPlayer
  ? Also record these streams? y
```

## Building

### Release (GitHub Actions)
Push a version tag to trigger the build:
```bash
git tag v2.0.0
git push origin v2.0.0
```
Windows + Linux binaries appear in GitHub Releases automatically.

### Local
```bash
go build -ldflags="-s -w" -o kick-save .
```

## How it works

1. **Cloudflare bypass** — uses system `curl` (Schannel TLS on Windows) for browser-like TLS fingerprint
2. **m3u8 extraction** — finds the HLS playlist URL from the Kick page HTML or API
3. **Parallel download** — downloads HLS segments 8 at a time via `curl`
4. **Remux** — `ffmpeg` concatenates segments into a clean `.mp4` with `faststart`
5. **Chat** — connects to Kick's Pusher WebSocket for real-time chat capture

## License

MIT

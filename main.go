package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const version = "2.0.0"

var (
	flagQuality = flag.String("q", "720p60", "Video quality (720p60, 480p30, 360p30, 160p30)")
	flagOutput  = flag.String("o", ".", "Output directory")
	flagTime    = flag.String("t", "", "Time range (e.g. 2:35:35-3:00:35)")
	flagChat    = flag.Bool("c", false, "Capture chat")
	flagM3U8    = flag.String("m3u8", "", "Direct m3u8 URL (skip extraction)")
	flagVersion = flag.Bool("v", false, "Show version")
)

var reader = bufio.NewReader(os.Stdin)

// ── UI helpers ────────────────────────────────────────────────────────────

const (
	cReset  = "\033[0m"
	cBold   = "\033[1m"
	cRed    = "\033[31m"
	cGreen  = "\033[32m"
	cYellow = "\033[33m"
	cCyan   = "\033[36m"
	cGray   = "\033[90m"
)

func banner() {
	fmt.Println(cGreen + cBold + `
  ╔═══════════════════════════════════════════╗
  ║         KICK STREAM SAVER v` + version + `          ║
  ║   VODs · Clips · Live · Chat · Multi      ║
  ╚═══════════════════════════════════════════╝` + cReset)
	fmt.Println()
}

func log(msg string)    { fmt.Println(cGray + "  " + msg + cReset) }
func logOk(msg string)  { fmt.Println(cGreen + "  ✓ " + msg + cReset) }
func logErr(msg string) { fmt.Println(cRed + "  ✗ " + msg + cReset) }

func prompt(label string) string {
	fmt.Print(cCyan + "  ? " + cReset + label + " ")
	text, _ := reader.ReadString('\n')
	return strings.TrimSpace(text)
}

func promptDefault(label, def string) string {
	if def != "" {
		fmt.Printf("%s  ? %s%s [%s] ", cCyan, cReset, label, def)
	} else {
		fmt.Printf("%s  ? %s%s ", cCyan, cReset, label)
	}
	text, _ := reader.ReadString('\n')
	text = strings.TrimSpace(text)
	if text == "" {
		return def
	}
	return text
}

func promptMenu(label string, options []string) int {
	fmt.Println()
	for i, opt := range options {
		fmt.Printf("  %s%d%s  %s\n", cCyan, i+1, cReset, opt)
	}
	for {
		s := prompt(label)
		n, err := strconv.Atoi(s)
		if err == nil && n >= 1 && n <= len(options) {
			return n - 1
		}
		fmt.Println(cRed + "  Invalid choice" + cReset)
	}
}

func promptYN(label string, def bool) bool {
	defStr := "y/N"
	if def {
		defStr = "Y/n"
	}
	s := promptDefault(fmt.Sprintf("%s (%s)", label, defStr), "")
	if s == "" {
		return def
	}
	return strings.ToLower(s[:1]) == "y"
}

func parseSelection(input string, max int) []int {
	if strings.ToLower(strings.TrimSpace(input)) == "all" {
		indices := make([]int, max)
		for i := range indices {
			indices[i] = i
		}
		return indices
	}
	seen := map[int]bool{}
	var indices []int
	for _, part := range strings.Split(input, ",") {
		part = strings.TrimSpace(part)
		if r := strings.SplitN(part, "-", 2); len(r) == 2 {
			lo, _ := strconv.Atoi(strings.TrimSpace(r[0]))
			hi, _ := strconv.Atoi(strings.TrimSpace(r[1]))
			for i := lo - 1; i < hi && i < max; i++ {
				if i >= 0 && !seen[i] {
					indices = append(indices, i)
					seen[i] = true
				}
			}
		} else {
			n, _ := strconv.Atoi(part)
			n--
			if n >= 0 && n < max && !seen[n] {
				indices = append(indices, n)
				seen[n] = true
			}
		}
	}
	return indices
}

func sanitize(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), "_")
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

func progressBar(done, total int) {
	pct := done * 100 / total
	bar := done * 30 / total
	fmt.Printf("\r  [%s%s%s%s] %d%% seg %d/%d  ",
		cGreen, strings.Repeat("█", bar), strings.Repeat("░", 30-bar), cReset, pct, done, total)
}

// ── Quality prompt ────────────────────────────────────────────────────────

func promptQuality() string {
	idx := promptMenu("Quality:", []string{
		"720p 60fps (best)",
		"480p 30fps",
		"360p 30fps",
		"160p 30fps (smallest)",
	})
	return []string{"720p60", "480p30", "360p30", "160p30"}[idx]
}

// ── Download one VOD ──────────────────────────────────────────────────────

func doDownloadVOD(slug string, vod VOD, quality string, timeRange *TimeRange, captureChat bool, chatroomID int) {
	dateStr := ""
	if len(vod.Date) >= 10 {
		dateStr = strings.ReplaceAll(vod.Date[:10], "-", "")
	}
	baseName := sanitize(fmt.Sprintf("%s-%s-%s", slug, vod.Title, dateStr))
	outputFile := filepath.Join(*flagOutput, baseName+".mp4")

	fmt.Printf("\n%s  ── %s ──%s\n", cBold, vod.Title, cReset)

	// Get m3u8
	var m3u8 string
	var err error
	if vod.Source != "" {
		m3u8 = vod.Source
	} else {
		log("Extracting stream URL...")
		m3u8, err = getVODPlayback(slug, vod.UUID)
		if err != nil {
			logErr(fmt.Sprintf("Failed: %s", err))
			return
		}
	}

	// Chat
	var chat *ChatCapture
	if captureChat && chatroomID > 0 {
		chat = newChatCapture(chatroomID, filepath.Join(*flagOutput, baseName))
		chat.OnStatus = log
		go chat.Connect()
	}

	result, err := downloadVOD(m3u8, quality, outputFile, timeRange, progressBar, log)
	fmt.Println()
	if err != nil {
		logErr(fmt.Sprintf("Download failed: %s", err))
	} else {
		logOk(fmt.Sprintf("%s (%.1f MB)", filepath.Base(outputFile), float64(result.Size)/1024/1024))
	}

	if chat != nil {
		count := chat.Stop()
		if count > 0 {
			logOk(fmt.Sprintf("Chat: %d messages saved", count))
		}
	}
}

// ── Browse channel ────────────────────────────────────────────────────────

func browseChannel(slug string) {
	if slug == "" {
		slug = prompt("Enter channel name or URL:")
		parsed := parseKickURL(slug)
		if parsed.Slug != "" {
			slug = parsed.Slug
		}
	}

	log(fmt.Sprintf("Fetching channel: %s...", slug))
	channel, err := getChannel(slug)
	if err != nil {
		logErr(fmt.Sprintf("Could not fetch channel: %s", err))
		return
	}

	for {
		fmt.Println()
		liveLabel := cGray + " (offline)" + cReset
		if channel.IsLive {
			liveLabel = fmt.Sprintf("%s ● LIVE — \"%s\" (%d viewers)%s",
				cRed+cBold, channel.StreamTitle, channel.Viewers, cReset)
		}
		fmt.Printf("%s  Channel: %s%s %s\n", cBold, slug, cReset, liveLabel)

		options := []string{}
		if channel.IsLive {
			options = append(options, cRed+"Record live stream"+cReset)
		}
		options = append(options, "Browse VODs", "Browse clips", "Multi-stream viewer", "Back")

		choice := promptMenu("Select:", options)
		offset := 0
		if !channel.IsLive {
			offset = 1
		}

		switch choice + offset {
		case 0: // Live
			doRecordLive(slug, channel)
		case 1: // VODs
			browseVODs(slug, channel)
		case 2: // Clips
			browseClips(slug)
		case 3: // Multi-viewer
			multiViewer(slug)
		case 4: // Back
			return
		}
	}
}

func browseVODs(slug string, channel *Channel) {
	log("Fetching VODs...")
	vods, err := getVODs(slug, 1)
	if err != nil {
		logErr(fmt.Sprintf("Could not fetch VODs: %s", err))
		return
	}
	if len(vods) == 0 {
		log("No VODs found.")
		return
	}

	// Print table
	fmt.Println()
	fmt.Printf("  %s#   %-46s %-12s %-17s %6s%s\n", cBold, "Title", "Duration", "Date", "Views", cReset)
	fmt.Printf("  %s─── ────────────────────────────────────────────── ──────────── ───────────────── ──────%s\n", cGray, cReset)
	for i, v := range vods {
		title := v.Title
		if len(title) > 46 {
			title = title[:46]
		}
		date := v.Date
		if len(date) > 16 {
			date = date[:16]
		}
		fmt.Printf("  %s%3d%s %-46s %-12s %-17s %6d\n",
			cCyan, i+1, cReset, title, formatDuration(float64(v.Duration)), date, v.Views)
	}
	fmt.Println()

	sel := prompt("Select VODs (e.g. 1,3,5-7 or \"all\"):")
	indices := parseSelection(sel, len(vods))
	if len(indices) == 0 {
		log("No valid selection.")
		return
	}

	fmt.Printf("\n%s  Selected %d VOD(s)%s\n", cBold, len(indices), cReset)

	// Options per VOD
	type dlJob struct {
		vod       VOD
		quality   string
		timeRange *TimeRange
		chat      bool
	}
	var jobs []dlJob

	for _, idx := range indices {
		v := vods[idx]
		fmt.Printf("\n%s  ── Options for: %s ──%s\n", cBold, v.Title, cReset)

		quality := promptQuality()
		var tr *TimeRange
		if v.Duration > 0 {
			trStr := promptDefault(fmt.Sprintf("Time range (blank = full %s, e.g. 2:35:35-3:00:35):", formatDuration(float64(v.Duration))), "")
			if trStr != "" {
				tr = parseTimeRange(trStr)
				if tr == nil {
					fmt.Println(cYellow + "  Invalid time range, downloading full video" + cReset)
				}
			}
		}
		chat := promptYN("Capture chat?", false)
		jobs = append(jobs, dlJob{v, quality, tr, chat})
	}

	fmt.Printf("\n%s  Starting %d download(s)...%s\n", cBold, len(jobs), cReset)
	success := 0
	for _, j := range jobs {
		doDownloadVOD(slug, j.vod, j.quality, j.timeRange, j.chat, channel.ChatroomID)
		success++
	}
	fmt.Printf("\n%s  Done: %d/%d completed%s\n", cBold, success, len(jobs), cReset)
}

func browseClips(slug string) {
	log("Fetching clips...")
	clips, err := getClips(slug)
	if err != nil {
		logErr(fmt.Sprintf("Could not fetch clips: %s", err))
		return
	}
	if len(clips) == 0 {
		log("No clips found.")
		return
	}

	fmt.Println()
	fmt.Printf("  %s#   %-46s %-8s %6s%s\n", cBold, "Title", "Duration", "Views", cReset)
	fmt.Printf("  %s─── ────────────────────────────────────────────── ──────── ──────%s\n", cGray, cReset)
	for i, c := range clips {
		title := c.Title
		if len(title) > 46 {
			title = title[:46]
		}
		fmt.Printf("  %s%3d%s %-46s %-8s %6d\n",
			cCyan, i+1, cReset, title, formatDuration(float64(c.Duration)), c.Views)
	}
	fmt.Println()

	sel := prompt("Select clips (e.g. 1,3,5-7 or \"all\"):")
	indices := parseSelection(sel, len(clips))
	if len(indices) == 0 {
		return
	}

	fmt.Printf("\n%s  Downloading %d clip(s)...%s\n", cBold, len(indices), cReset)
	for _, idx := range indices {
		c := clips[idx]
		if c.ClipURL == "" {
			logErr(fmt.Sprintf("No URL for: %s", c.Title))
			continue
		}
		outFile := filepath.Join(*flagOutput, sanitize(fmt.Sprintf("%s-clip-%s", slug, c.Title))+".mp4")
		log(fmt.Sprintf("Downloading: %s...", c.Title))
		if err := downloadClip(c.ClipURL, outFile, log); err != nil {
			logErr(err.Error())
		} else {
			fi, _ := os.Stat(outFile)
			sz := int64(0)
			if fi != nil {
				sz = fi.Size()
			}
			logOk(fmt.Sprintf("%s (%.1f MB)", filepath.Base(outFile), float64(sz)/1024/1024))
		}
	}
}

// ── Record live ───────────────────────────────────────────────────────────

func doRecordLive(slug string, channel *Channel) {
	quality := promptQuality()
	durStr := promptDefault("Duration (blank = until Ctrl+C, e.g. 30:00 or 1:30:00):", "")
	var dur float64
	if durStr != "" {
		dur, _ = parseTimestamp(durStr)
	}
	chat := promptYN("Capture chat?", false)

	ts := time.Now().Format("2006-01-02_15-04-05")
	baseName := sanitize(fmt.Sprintf("%s-live-%s", slug, ts))
	outputFile := filepath.Join(*flagOutput, baseName+".mp4")

	m3u8, err := getLivePlayback(slug)
	if err != nil {
		logErr(err.Error())
		return
	}

	var chatCap *ChatCapture
	if chat && channel.ChatroomID > 0 {
		chatCap = newChatCapture(channel.ChatroomID, filepath.Join(*flagOutput, baseName))
		chatCap.OnStatus = log
		go chatCap.Connect()
	}

	if err := recordLive(m3u8, quality, outputFile, dur, log); err != nil {
		logErr(err.Error())
	} else {
		fi, _ := os.Stat(outputFile)
		if fi != nil {
			logOk(fmt.Sprintf("%s (%.1f MB)", filepath.Base(outputFile), float64(fi.Size())/1024/1024))
		}
	}

	if chatCap != nil {
		count := chatCap.Stop()
		if count > 0 {
			logOk(fmt.Sprintf("Chat: %d messages saved", count))
		}
	}
}

// ── Multi-stream viewer ───────────────────────────────────────────────────

func multiViewer(initialSlug string) {
	// Detect viewers
	viewers := []struct{ name, cmd string }{}
	for _, v := range []struct{ name, cmd string }{
		{"GridPlayer", "gridplayer"},
		{"mpv", "mpv"},
		{"VLC", vlcCmd()},
		{"ffplay", "ffplay"},
	} {
		if _, err := exec.LookPath(v.cmd); err == nil {
			viewers = append(viewers, v)
		}
	}

	if len(viewers) == 0 {
		fmt.Println(cYellow + "\n  No video player found. Install GridPlayer, mpv, or VLC" + cReset)
		fmt.Println(cGray + "  GridPlayer: https://github.com/vzhd1701/gridplayer" + cReset)
		return
	}

	input := promptDefault("Channels to watch (comma-separated):", initialSlug)
	slugs := strings.Split(input, ",")

	type liveStream struct {
		slug string
		url  string
	}
	var streams []liveStream
	for _, s := range slugs {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		log(fmt.Sprintf("Checking %s...", s))
		m3u8, err := getLivePlayback(s)
		if err != nil {
			logErr(fmt.Sprintf("%s — %s", s, err))
			continue
		}
		logOk(fmt.Sprintf("%s — stream found", s))
		streams = append(streams, liveStream{s, m3u8})
	}
	if len(streams) == 0 {
		logErr("No live streams found")
		return
	}

	// Pick viewer
	viewerIdx := 0
	if len(viewers) > 1 {
		names := make([]string, len(viewers))
		for i, v := range viewers {
			names[i] = v.name
		}
		viewerIdx = promptMenu("Video player:", names)
	}
	viewer := viewers[viewerIdx]

	record := promptYN("Also record these streams?", false)

	log(fmt.Sprintf("Opening %d stream(s) in %s...", len(streams), viewer.name))

	for _, s := range streams {
		cmd := exec.Command(viewer.cmd, s.url)
		cmd.Start()
	}
	logOk(fmt.Sprintf("Opened %d stream(s)", len(streams)))

	if record {
		fmt.Printf("\n%s  Recording all streams... (Ctrl+C to stop)%s\n\n", cBold, cReset)
		for _, s := range streams {
			ts := time.Now().Format("2006-01-02_15-04-05")
			outFile := filepath.Join(*flagOutput, sanitize(fmt.Sprintf("%s-live-%s", s.slug, ts))+".mp4")
			go recordLive(s.url, *flagQuality, outFile, 0, log)
		}
		// Wait for Ctrl+C
		select {}
	}
}

func vlcCmd() string {
	if runtime.GOOS == "windows" {
		return "vlc"
	}
	return "cvlc"
}

// ── Direct URL handler ────────────────────────────────────────────────────

func handleDirectURL(rawURL string) {
	parsed := parseKickURL(rawURL)

	switch parsed.Type {
	case "channel":
		browseChannel(parsed.Slug)
	case "vod":
		quality := *flagQuality
		var tr *TimeRange
		if *flagTime != "" {
			tr = parseTimeRange(*flagTime)
		}
		vod := VOD{UUID: parsed.UUID, Title: parsed.UUID}
		doDownloadVOD(parsed.Slug, vod, quality, tr, *flagChat, 0)
	case "clip":
		outFile := filepath.Join(*flagOutput, sanitize(fmt.Sprintf("%s-clip-%s", parsed.Slug, parsed.ClipID))+".mp4")
		log(fmt.Sprintf("Downloading clip: %s", parsed.ClipID))
		clips, err := getClips(parsed.Slug)
		if err == nil {
			for _, c := range clips {
				if fmt.Sprint(c.ID) == parsed.ClipID && c.ClipURL != "" {
					downloadClip(c.ClipURL, outFile, log)
					return
				}
			}
		}
		logErr("Could not find clip URL")
	default:
		logErr(fmt.Sprintf("Unknown URL format: %s", rawURL))
	}
}

// ── Main ──────────────────────────────────────────────────────────────────

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: kick-save [flags] [url]\n\n")
		fmt.Fprintf(os.Stderr, "Kick.com stream downloader — VODs, clips, live, chat\n\n")
		fmt.Fprintf(os.Stderr, "Flags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  kick-save                              Interactive mode\n")
		fmt.Fprintf(os.Stderr, "  kick-save kick.com/channel             Browse channel\n")
		fmt.Fprintf(os.Stderr, "  kick-save URL -t 2:35:35-3:00:35       Time range clip\n")
		fmt.Fprintf(os.Stderr, "  kick-save URL -q 480p30 -c             480p + chat\n")
		fmt.Fprintf(os.Stderr, "  kick-save -m3u8 URL output.mp4         Direct m3u8\n")
	}
	flag.Parse()

	if *flagVersion {
		fmt.Printf("kick-save v%s\n", version)
		return
	}

	banner()

	// Ensure ffmpeg
	if _, err := ensureFFmpeg(log); err != nil {
		logErr(err.Error())
		os.Exit(1)
	}

	// Direct m3u8 mode
	if *flagM3U8 != "" {
		outFile := "kick-download.mp4"
		if flag.NArg() > 0 {
			outFile = flag.Arg(0)
		}
		var tr *TimeRange
		if *flagTime != "" {
			tr = parseTimeRange(*flagTime)
		}
		result, err := downloadVOD(*flagM3U8, *flagQuality, outFile, tr, progressBar, log)
		fmt.Println()
		if err != nil {
			logErr(err.Error())
			os.Exit(1)
		}
		logOk(fmt.Sprintf("%s (%.1f MB)", outFile, float64(result.Size)/1024/1024))
		return
	}

	// Direct URL
	if flag.NArg() > 0 {
		handleDirectURL(flag.Arg(0))
		return
	}

	// Interactive menu
	for {
		options := []string{
			"Browse channel (VODs, clips, live)",
			"Enter direct VOD/clip URL",
			"Multi-stream viewer",
			"Quit",
		}
		choice := promptMenu("What do you want to do?", options)

		switch choice {
		case 0:
			browseChannel("")
		case 1:
			url := prompt("Enter Kick VOD or clip URL:")
			handleDirectURL(url)
		case 2:
			multiViewer("")
		case 3:
			fmt.Println(cGray + "\n  Goodbye!\n" + cReset)
			return
		}
	}
}

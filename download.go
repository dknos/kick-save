package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// ── Parallel segment download ─────────────────────────────────────────────

func downloadSegments(segments []Segment, tmpDir string, concurrency int, onProgress func(done, total int)) ([]string, error) {
	total := len(segments)
	segFiles := make([]string, total)
	var done int64
	var firstErr error
	var errOnce sync.Once

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for i, seg := range segments {
		dest := filepath.Join(tmpDir, fmt.Sprintf("seg%06d.ts", i))
		segFiles[i] = dest

		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, url, dest string) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := curlDownload(url, dest); err != nil {
				errOnce.Do(func() { firstErr = fmt.Errorf("segment %d: %w", idx, err) })
				return
			}
			d := int(atomic.AddInt64(&done, 1))
			if onProgress != nil {
				onProgress(d, total)
			}
		}(i, seg.URL, dest)
	}
	wg.Wait()
	return segFiles, firstErr
}

// ── ffmpeg remux ──────────────────────────────────────────────────────────

func remux(segFiles []string, outputFile string, trimStart, totalDuration float64) error {
	tmpDir := filepath.Dir(segFiles[0])
	concatList := filepath.Join(tmpDir, "concat.txt")

	var lines []string
	for _, f := range segFiles {
		lines = append(lines, fmt.Sprintf("file '%s'", f))
	}
	if err := os.WriteFile(concatList, []byte(strings.Join(lines, "\n")), 0644); err != nil {
		return err
	}

	ffmpeg := findFFmpeg()
	args := []string{"-f", "concat", "-safe", "0", "-i", concatList}
	if trimStart > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", trimStart))
	}
	if totalDuration > 0 {
		args = append(args, "-t", fmt.Sprintf("%.3f", totalDuration))
	}
	args = append(args, "-c", "copy", "-movflags", "+faststart", "-y", outputFile)

	cmd := exec.Command(ffmpeg, args...)
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ── Full VOD download pipeline ────────────────────────────────────────────

type DownloadResult struct {
	Size      int64
	Duration  float64
	Qualities []Stream
}

func downloadVOD(m3u8URL, quality, outputFile string, timeRange *TimeRange, onProgress func(done, total int), onStatus func(string)) (*DownloadResult, error) {
	onStatus("Fetching stream info...")
	masterText, err := fetchM3U8(m3u8URL)
	if err != nil {
		return nil, err
	}

	segPlaylistURL := m3u8URL
	var qualities []Stream

	if strings.Contains(masterText, "#EXT-X-STREAM-INF") {
		qualities = parseMasterPlaylist(masterText, m3u8URL)
		// Pick requested quality or best
		chosen := qualities[0].URL
		for _, s := range qualities {
			if strings.Contains(s.URL, quality) {
				chosen = s.URL
				onStatus(fmt.Sprintf("Quality: %s", s.Resolution))
				break
			}
		}
		if chosen == qualities[0].URL {
			onStatus(fmt.Sprintf("Quality: %s (best)", qualities[0].Resolution))
		}
		segPlaylistURL = chosen
	}

	onStatus("Fetching segment list...")
	segText, err := fetchM3U8(segPlaylistURL)
	if err != nil {
		return nil, err
	}
	segments := parseSegmentPlaylist(segText, segPlaylistURL)
	fullDur := totalDuration(segments)
	onStatus(fmt.Sprintf("Full duration: %s (%d segments)", formatDuration(fullDur), len(segments)))

	// Apply time range
	sel := selectSegments(segments, timeRange)
	if timeRange != nil {
		onStatus(fmt.Sprintf("Time range: %s → %s (%d segments)",
			formatTimestamp(timeRange.Start), formatTimestamp(timeRange.End), len(sel.Segments)))
	}

	// Download segments
	tmpDir, err := os.MkdirTemp("", "kick-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	onStatus("Downloading segments...")
	segFiles, err := downloadSegments(sel.Segments, tmpDir, 8, onProgress)
	if err != nil {
		return nil, err
	}

	onStatus("Remuxing to MP4...")
	if err := remux(segFiles, outputFile, sel.TrimStart, sel.TotalDuration); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}

	fi, _ := os.Stat(outputFile)
	size := int64(0)
	if fi != nil {
		size = fi.Size()
	}

	dur := sel.TotalDuration
	if dur == 0 {
		dur = fullDur
	}
	return &DownloadResult{Size: size, Duration: dur, Qualities: qualities}, nil
}

// ── Live stream recording ─────────────────────────────────────────────────

func recordLive(m3u8URL, quality, outputFile string, duration float64, onStatus func(string)) error {
	// Pick quality from master
	masterText, err := fetchM3U8(m3u8URL)
	if err == nil && strings.Contains(masterText, "#EXT-X-STREAM-INF") {
		streams := parseMasterPlaylist(masterText, m3u8URL)
		for _, s := range streams {
			if strings.Contains(s.URL, quality) {
				m3u8URL = s.URL
				onStatus(fmt.Sprintf("Quality: %s", s.Resolution))
				break
			}
		}
	}

	ffmpeg := findFFmpeg()
	args := []string{
		"-user_agent", userAgent,
		"-headers", "Referer: https://kick.com/\r\n",
		"-rw_timeout", "10000000",
		"-i", m3u8URL,
	}
	if duration > 0 {
		args = append(args, "-t", fmt.Sprintf("%.0f", duration))
		onStatus(fmt.Sprintf("Recording %s → %s", formatDuration(duration), outputFile))
	} else {
		onStatus(fmt.Sprintf("Recording → %s (Ctrl+C to stop)", outputFile))
	}
	args = append(args, "-c", "copy", "-movflags", "+faststart", "-y", outputFile)

	cmd := exec.Command(ffmpeg, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ── Clip download ─────────────────────────────────────────────────────────

func downloadClip(clipURL, outputFile string, onStatus func(string)) error {
	if strings.Contains(clipURL, ".mp4") {
		onStatus("Downloading clip...")
		return curlDownload(clipURL, outputFile)
	}
	// HLS clip
	_, err := downloadVOD(clipURL, "720p60", outputFile, nil,
		func(d, t int) { fmt.Printf("\r  seg %d/%d", d, t) },
		onStatus)
	fmt.Println()
	return err
}

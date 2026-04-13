package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type Stream struct {
	Bandwidth  int
	Resolution string
	FPS        float64
	URL        string
	Label      string
}

type Segment struct {
	URL      string
	Duration float64
}

type TimeRange struct {
	Start float64
	End   float64
}

// ── Time parsing ──────────────────────────────────────────────────────────

func parseTimestamp(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	parts := strings.Split(s, ":")
	vals := make([]float64, len(parts))
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return 0, false
		}
		vals[i] = v
	}
	switch len(vals) {
	case 3:
		return vals[0]*3600 + vals[1]*60 + vals[2], true
	case 2:
		return vals[0]*60 + vals[1], true
	case 1:
		return vals[0], true
	}
	return 0, false
}

func parseTimeRange(s string) *TimeRange {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return nil
	}
	// Handle HH:MM:SS-HH:MM:SS — split on the dash between timestamps
	// Need smarter split since timestamps contain colons but not dashes
	// Try splitting on " - " first, then "-" between two timestamp-like strings
	rawParts := splitTimeRange(s)
	if len(rawParts) != 2 {
		return nil
	}
	start, ok1 := parseTimestamp(rawParts[0])
	end, ok2 := parseTimestamp(rawParts[1])
	if !ok1 || !ok2 || end <= start {
		return nil
	}
	return &TimeRange{Start: start, End: end}
}

func splitTimeRange(s string) []string {
	// Try " - " separator first
	if parts := strings.SplitN(s, " - ", 2); len(parts) == 2 {
		return parts
	}
	// Find the dash that separates two timestamps: look for pattern like NN:NN:NN-NN:NN
	re := regexp.MustCompile(`^([\d:]+)-([\d:]+)$`)
	// This is tricky — try to find a dash that's preceded by a digit and followed by a digit
	for i := len(s) - 1; i >= 1; i-- {
		if s[i] == '-' && s[i-1] >= '0' && s[i-1] <= '9' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9' {
			left := s[:i]
			right := s[i+1:]
			if _, ok := parseTimestamp(left); ok {
				if _, ok := parseTimestamp(right); ok {
					return []string{left, right}
				}
			}
		}
	}
	m := re.FindStringSubmatch(s)
	if m != nil {
		return []string{m[1], m[2]}
	}
	return nil
}

func formatDuration(sec float64) string {
	if sec <= 0 {
		return "0s"
	}
	h := int(sec) / 3600
	m := (int(sec) % 3600) / 60
	s := int(sec) % 60
	if h > 0 {
		return fmt.Sprintf("%dh %dm %ds", h, m, s)
	}
	if m > 0 {
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

func formatTimestamp(sec float64) string {
	h := int(sec) / 3600
	m := (int(sec) % 3600) / 60
	s := int(sec) % 60
	return fmt.Sprintf("%d:%02d:%02d", h, m, s)
}

// ── HLS parsing ───────────────────────────────────────────────────────────

var (
	streamInfRe = regexp.MustCompile(`#EXT-X-STREAM-INF:(.+)`)
	bandwidthRe = regexp.MustCompile(`BANDWIDTH=(\d+)`)
	resRe       = regexp.MustCompile(`RESOLUTION=(\d+x\d+)`)
	fpsRe       = regexp.MustCompile(`FRAME-RATE=([\d.]+)`)
	extinfRe    = regexp.MustCompile(`#EXTINF:([\d.]+)`)
)

func resolveURL(base, ref string) string {
	if strings.HasPrefix(ref, "http") {
		return ref
	}
	u, err := url.Parse(base)
	if err != nil {
		return ref
	}
	r, err := u.Parse(ref)
	if err != nil {
		return ref
	}
	return r.String()
}

func parseMasterPlaylist(text, baseURL string) []Stream {
	lines := strings.Split(text, "\n")
	var streams []Stream
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "#EXT-X-STREAM-INF") {
			continue
		}
		if i+1 >= len(lines) {
			break
		}
		next := strings.TrimSpace(lines[i+1])
		if next == "" || strings.HasPrefix(next, "#") {
			continue
		}
		s := Stream{URL: resolveURL(baseURL, next)}

		if m := bandwidthRe.FindStringSubmatch(line); m != nil {
			s.Bandwidth, _ = strconv.Atoi(m[1])
		}
		if m := resRe.FindStringSubmatch(line); m != nil {
			s.Resolution = m[1]
		}
		if m := fpsRe.FindStringSubmatch(line); m != nil {
			s.FPS, _ = strconv.ParseFloat(m[1], 64)
		}
		// Label from URL path
		parts := strings.Split(next, "/")
		if len(parts) >= 2 {
			s.Label = parts[len(parts)-2] // e.g. "720p60"
		}
		streams = append(streams, s)
	}
	return streams
}

func parseSegmentPlaylist(text, baseURL string) []Segment {
	lines := strings.Split(text, "\n")
	var segments []Segment
	var dur float64
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if m := extinfRe.FindStringSubmatch(line); m != nil {
			dur, _ = strconv.ParseFloat(m[1], 64)
			continue
		}
		if line != "" && !strings.HasPrefix(line, "#") {
			segments = append(segments, Segment{
				URL:      resolveURL(baseURL, line),
				Duration: dur,
			})
		}
	}
	return segments
}

func fetchM3U8(url string) (string, error) {
	return curlGet(url)
}

func totalDuration(segments []Segment) float64 {
	var total float64
	for _, s := range segments {
		total += s.Duration
	}
	return total
}

// ── Time-range segment selection ──────────────────────────────────────────

type SelectedSegments struct {
	Segments      []Segment
	TrimStart     float64
	TotalDuration float64
}

func selectSegments(segments []Segment, tr *TimeRange) SelectedSegments {
	if tr == nil {
		return SelectedSegments{Segments: segments}
	}
	var cumulative float64
	startIdx := -1
	endIdx := -1
	var trimStart float64

	for i, seg := range segments {
		segStart := cumulative
		segEnd := cumulative + seg.Duration
		if startIdx == -1 && segEnd > tr.Start {
			startIdx = i
			trimStart = tr.Start - segStart
		}
		if segStart < tr.End {
			endIdx = i
		}
		cumulative += seg.Duration
	}
	if startIdx == -1 || endIdx == -1 {
		return SelectedSegments{Segments: segments}
	}
	return SelectedSegments{
		Segments:      segments[startIdx : endIdx+1],
		TrimStart:     trimStart,
		TotalDuration: tr.End - tr.Start,
	}
}

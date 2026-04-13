package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// curlGet fetches a URL using system curl (Schannel TLS on Windows bypasses Cloudflare)
func curlGet(url string) (string, error) {
	args := []string{
		"-s", "-L", "--max-time", "30", "--compressed",
		"-H", "User-Agent: " + userAgent,
		"-H", "Accept: application/json, text/html",
		"-H", "Referer: https://kick.com/",
		"-H", "Origin: https://kick.com",
		url,
	}
	out, err := exec.Command("curl", args...).Output()
	if err != nil {
		return "", fmt.Errorf("curl failed: %w", err)
	}
	return string(out), nil
}

func curlDownload(url, dest string) error {
	curlBin := "curl"
	if runtime.GOOS == "windows" {
		curlBin = "curl.exe"
	}
	args := []string{
		"-s", "-L", "--max-time", "120", "--retry", "3",
		"-H", "User-Agent: " + userAgent,
		"-H", "Referer: https://kick.com/",
		"-H", "Origin: https://kick.com",
		url, "-o", dest,
	}
	cmd := exec.Command(curlBin, args...)
	return cmd.Run()
}

// ── API types ─────────────────────────────────────────────────────────────

type Channel struct {
	ID          int    `json:"id"`
	Slug        string `json:"slug"`
	IsLive      bool
	StreamTitle string
	ChatroomID  int
	Viewers     int
	PlaybackURL string
}

type VOD struct {
	UUID     string `json:"uuid"`
	Title    string `json:"session_title"`
	Duration int    `json:"duration"`
	Date     string `json:"created_at"`
	Views    int    `json:"views"`
	Source   string `json:"source"`
}

type Clip struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Duration int    `json:"duration"`
	Date     string `json:"created_at"`
	Views    int    `json:"view_count"`
	ClipURL  string `json:"clip_url"`
}

// ── Channel ───────────────────────────────────────────────────────────────

func getChannel(slug string) (*Channel, error) {
	body, err := curlGet("https://kick.com/api/v2/channels/" + slug)
	if err != nil {
		return nil, err
	}
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if errMsg, ok := raw["error"].(string); ok {
		return nil, fmt.Errorf("API: %s", errMsg)
	}

	ch := &Channel{Slug: slug}
	if id, ok := raw["id"].(float64); ok {
		ch.ID = int(id)
	}
	if s, ok := raw["slug"].(string); ok {
		ch.Slug = s
	}
	if ls, ok := raw["livestream"].(map[string]interface{}); ok {
		if live, ok := ls["is_live"].(bool); ok {
			ch.IsLive = live
		}
		if t, ok := ls["session_title"].(string); ok {
			ch.StreamTitle = t
		}
		if v, ok := ls["viewer_count"].(float64); ok {
			ch.Viewers = int(v)
		}
		if s, ok := ls["source"].(string); ok {
			ch.PlaybackURL = s
		}
	}
	if s, ok := raw["playback_url"].(string); ok && ch.PlaybackURL == "" {
		ch.PlaybackURL = s
	}
	if cr, ok := raw["chatroom"].(map[string]interface{}); ok {
		if id, ok := cr["id"].(float64); ok {
			ch.ChatroomID = int(id)
		}
	}
	return ch, nil
}

// ── VODs ──────────────────────────────────────────────────────────────────

func getVODs(slug string, page int) ([]VOD, error) {
	url := fmt.Sprintf("https://kick.com/api/v2/channels/%s/videos?page=%d&sort=date", slug, page)
	body, err := curlGet(url)
	if err != nil {
		return nil, err
	}

	// Try multiple response shapes
	var wrapper struct {
		Data   []VOD `json:"data"`
		Videos []VOD `json:"videos"`
	}
	if err := json.Unmarshal([]byte(body), &wrapper); err != nil {
		return nil, err
	}
	vods := wrapper.Data
	if len(vods) == 0 {
		vods = wrapper.Videos
	}
	// Fix empty titles
	for i := range vods {
		if vods[i].Title == "" {
			vods[i].Title = "Untitled"
		}
	}
	return vods, nil
}

// ── Clips ─────────────────────────────────────────────────────────────────

func getClips(slug string) ([]Clip, error) {
	url := fmt.Sprintf("https://kick.com/api/v2/channels/%s/clips?sort=view&time=all", slug)
	body, err := curlGet(url)
	if err != nil {
		return nil, err
	}

	var wrapper struct {
		Clips struct {
			Data []Clip `json:"data"`
		} `json:"clips"`
		Data []Clip `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &wrapper); err != nil {
		return nil, err
	}
	clips := wrapper.Clips.Data
	if len(clips) == 0 {
		clips = wrapper.Data
	}
	for i := range clips {
		if clips[i].Title == "" {
			clips[i].Title = "Untitled clip"
		}
		// Try alternate fields
		if clips[i].ClipURL == "" {
			// Parse raw JSON for alternate field names
			var raw map[string]interface{}
			json.Unmarshal([]byte(body), &raw)
			// Try nested
		}
	}
	return clips, nil
}

// ── m3u8 extraction ───────────────────────────────────────────────────────

var m3u8Re = regexp.MustCompile(`https://[^"'\\]*\.m3u8[^"'\\]*`)

func findM3U8InText(html string) string {
	matches := m3u8Re.FindAllString(html, -1)
	if len(matches) == 0 {
		return ""
	}
	// Clean trailing escapes
	for i := range matches {
		matches[i] = strings.TrimRight(matches[i], `\'\"`)
	}
	// Prefer stream.kick.com (VOD CDN, no token)
	for _, m := range matches {
		if strings.Contains(m, "stream.kick.com") {
			return m
		}
	}
	for _, m := range matches {
		if strings.Contains(m, "master.m3u8") {
			return m
		}
	}
	return matches[0]
}

func extractM3U8FromPage(url string) string {
	html, err := curlGet(url)
	if err != nil {
		return ""
	}
	return findM3U8InText(html)
}

func getVODPlayback(slug, uuid string) (string, error) {
	// 1. VOD listing
	vods, err := getVODs(slug, 1)
	if err == nil {
		for _, v := range vods {
			if v.UUID == uuid && v.Source != "" {
				return v.Source, nil
			}
		}
	}
	// 2. Direct video API
	body, err := curlGet("https://kick.com/api/v2/video/" + uuid)
	if err == nil {
		var raw map[string]interface{}
		if json.Unmarshal([]byte(body), &raw) == nil {
			if src, ok := raw["source"].(string); ok && src != "" {
				return src, nil
			}
		}
	}
	// 3. Page HTML extraction
	m3u8 := extractM3U8FromPage(fmt.Sprintf("https://kick.com/%s/videos/%s", slug, uuid))
	if m3u8 != "" {
		return m3u8, nil
	}
	return "", fmt.Errorf("could not find playback URL")
}

func getLivePlayback(slug string) (string, error) {
	m3u8 := extractM3U8FromPage("https://kick.com/" + slug)
	if m3u8 != "" {
		return m3u8, nil
	}
	ch, err := getChannel(slug)
	if err == nil && ch.PlaybackURL != "" {
		return ch.PlaybackURL, nil
	}
	return "", fmt.Errorf("could not find live stream URL")
}

// ── URL parsing ───────────────────────────────────────────────────────────

type ParsedURL struct {
	Type   string // "channel", "vod", "clip"
	Slug   string
	UUID   string
	ClipID string
}

var (
	vodRe  = regexp.MustCompile(`^(?:https?://)?(?:www\.)?kick\.com/([^/]+)/videos/([a-f0-9-]+)`)
	clipRe = regexp.MustCompile(`^(?:https?://)?(?:www\.)?kick\.com/([^/?]+)\?clip=(.+)`)
	chRe   = regexp.MustCompile(`^(?:https?://)?(?:www\.)?kick\.com/([^/?#]+)/?$`)
)

func parseKickURL(url string) ParsedURL {
	if m := vodRe.FindStringSubmatch(url); m != nil {
		return ParsedURL{Type: "vod", Slug: m[1], UUID: m[2]}
	}
	if m := clipRe.FindStringSubmatch(url); m != nil {
		return ParsedURL{Type: "clip", Slug: m[1], ClipID: m[2]}
	}
	if m := chRe.FindStringSubmatch(url); m != nil {
		return ParsedURL{Type: "channel", Slug: m[1]}
	}
	// Bare slug
	clean := strings.TrimPrefix(url, "https://")
	clean = strings.TrimPrefix(clean, "http://")
	clean = strings.TrimPrefix(clean, "kick.com/")
	clean = strings.TrimRight(clean, "/")
	if clean != "" && !strings.Contains(clean, "/") {
		return ParsedURL{Type: "channel", Slug: clean}
	}
	return ParsedURL{Type: "unknown", Slug: url}
}

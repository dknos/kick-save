package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func findFFmpeg() string {
	// 1. In PATH
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	// 2. In app data dir
	local := filepath.Join(appDataDir(), binaryName("ffmpeg"))
	if _, err := os.Stat(local); err == nil {
		return local
	}
	// 3. Common locations
	if runtime.GOOS == "windows" {
		for _, p := range []string{
			`C:\ffmpeg\bin\ffmpeg.exe`,
			filepath.Join(os.Getenv("USERPROFILE"), "ffmpeg", "bin", "ffmpeg.exe"),
			filepath.Join(os.Getenv("USERPROFILE"), "Downloads", "ffmpeg.exe"),
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	} else {
		for _, p := range []string{"/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
		home, _ := os.UserHomeDir()
		if p := filepath.Join(home, ".local", "bin", "ffmpeg"); fileExists(p) {
			return p
		}
	}
	return ""
}

func ensureFFmpeg(log func(string)) (string, error) {
	p := findFFmpeg()
	if p != "" {
		log(fmt.Sprintf("ffmpeg: %s", p))
		return p, nil
	}

	log("ffmpeg not found — downloading (one-time setup)...")
	dir := appDataDir()
	os.MkdirAll(dir, 0755)

	if runtime.GOOS == "windows" {
		zipURL := "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
		zipPath := filepath.Join(dir, "ffmpeg.zip")
		log("Downloading ffmpeg for Windows...")
		if err := curlDownload(zipURL, zipPath); err != nil {
			return "", fmt.Errorf("download failed: %w", err)
		}
		// Extract
		cmd := exec.Command("tar", "-xf", zipPath, "-C", dir,
			"--strip-components=2", "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe")
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("extract failed: %w", err)
		}
		os.Remove(zipPath)
		p = filepath.Join(dir, "ffmpeg.exe")
	} else {
		tarURL := "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
		tarPath := filepath.Join(dir, "ffmpeg.tar.xz")
		log("Downloading ffmpeg for Linux...")
		if err := curlDownload(tarURL, tarPath); err != nil {
			return "", fmt.Errorf("download failed: %w", err)
		}
		cmd := exec.Command("tar", "-xf", tarPath, "-C", dir,
			"--strip-components=1", "--wildcards", "*/ffmpeg")
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("extract failed: %w", err)
		}
		os.Remove(tarPath)
		p = filepath.Join(dir, "ffmpeg")
		os.Chmod(p, 0755)
	}

	if !fileExists(p) {
		return "", fmt.Errorf("ffmpeg download failed — install manually and add to PATH")
	}
	log(fmt.Sprintf("ffmpeg installed: %s", p))
	return p, nil
}

func appDataDir() string {
	if runtime.GOOS == "windows" {
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			home, _ := os.UserHomeDir()
			appdata = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appdata, "kick-save")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kick-save")
}

func binaryName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

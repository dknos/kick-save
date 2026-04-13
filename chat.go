package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var pusherKeys = []string{"32cbd69e4b950bf97679", "eb1d5f283081a78b932c"}

type ChatMessage struct {
	Timestamp string `json:"timestamp"`
	Username  string `json:"username"`
	Content   string `json:"content"`
	Color     string `json:"color,omitempty"`
	Badges    string `json:"badges,omitempty"`
}

type ChatCapture struct {
	chatroomID int
	outputBase string
	messages   []ChatMessage
	conn       *websocket.Conn
	mu         sync.Mutex
	stopped    bool
	OnStatus   func(string)
}

func newChatCapture(chatroomID int, outputBase string) *ChatCapture {
	return &ChatCapture{
		chatroomID: chatroomID,
		outputBase: outputBase,
	}
}

func (c *ChatCapture) Connect() bool {
	for _, key := range pusherKeys {
		if c.tryConnect(key) {
			return true
		}
	}
	if c.OnStatus != nil {
		c.OnStatus("Chat: could not connect")
	}
	return false
}

func (c *ChatCapture) tryConnect(appKey string) bool {
	u := url.URL{
		Scheme:   "wss",
		Host:     "ws-us2.pusher.com",
		Path:     fmt.Sprintf("/app/%s", appKey),
		RawQuery: "protocol=7&client=js&version=8.3.0&flash=false",
	}

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return false
	}

	// Wait for connection_established
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return false
	}

	var evt struct {
		Event string `json:"event"`
	}
	json.Unmarshal(msg, &evt)
	if evt.Event != "pusher:connection_established" {
		conn.Close()
		return false
	}

	// Subscribe
	sub := fmt.Sprintf(`{"event":"pusher:subscribe","data":{"auth":"","channel":"chatrooms.%d.v2"}}`, c.chatroomID)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(sub)); err != nil {
		conn.Close()
		return false
	}

	// Wait for subscription success
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err = conn.ReadMessage()
	if err != nil {
		conn.Close()
		return false
	}
	json.Unmarshal(msg, &evt)
	if evt.Event != "pusher_internal:subscription_succeeded" {
		conn.Close()
		return false
	}

	conn.SetReadDeadline(time.Time{}) // clear deadline
	c.conn = conn
	if c.OnStatus != nil {
		c.OnStatus(fmt.Sprintf("Chat: subscribed to chatroom %d", c.chatroomID))
	}

	// Start reading messages
	go c.readLoop()
	return true
}

func (c *ChatCapture) readLoop() {
	for {
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()

		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var evt struct {
			Event   string `json:"event"`
			Data    string `json:"data"`
			Channel string `json:"channel"`
		}
		if json.Unmarshal(msg, &evt) != nil {
			continue
		}

		// Handle ping
		if evt.Event == "pusher:ping" {
			c.conn.WriteMessage(websocket.TextMessage, []byte(`{"event":"pusher:pong","data":{}}`))
			continue
		}

		// Chat message
		if strings.Contains(evt.Event, "ChatMessage") {
			var data struct {
				Content   string `json:"content"`
				CreatedAt string `json:"created_at"`
				Sender    struct {
					Username string `json:"username"`
					Identity struct {
						Color  string `json:"color"`
						Badges []struct {
							Type string `json:"type"`
						} `json:"badges"`
					} `json:"identity"`
				} `json:"sender"`
			}
			if json.Unmarshal([]byte(evt.Data), &data) != nil {
				continue
			}
			var badges []string
			for _, b := range data.Sender.Identity.Badges {
				badges = append(badges, b.Type)
			}
			entry := ChatMessage{
				Timestamp: data.CreatedAt,
				Username:  data.Sender.Username,
				Content:   data.Content,
				Color:     data.Sender.Identity.Color,
				Badges:    strings.Join(badges, ","),
			}
			c.mu.Lock()
			c.messages = append(c.messages, entry)
			c.mu.Unlock()
		}
	}
}

func (c *ChatCapture) Stop() int {
	c.mu.Lock()
	c.stopped = true
	count := len(c.messages)
	c.mu.Unlock()

	if c.conn != nil {
		c.conn.Close()
	}
	c.save()
	return count
}

func (c *ChatCapture) save() {
	c.mu.Lock()
	msgs := make([]ChatMessage, len(c.messages))
	copy(msgs, c.messages)
	c.mu.Unlock()

	if len(msgs) == 0 {
		return
	}

	// Save .txt
	var lines []string
	for _, m := range msgs {
		ts := strings.Replace(m.Timestamp, "T", " ", 1)
		if idx := strings.Index(ts, "."); idx > 0 {
			ts = ts[:idx]
		}
		badge := ""
		if m.Badges != "" {
			badge = fmt.Sprintf("[%s] ", m.Badges)
		}
		lines = append(lines, fmt.Sprintf("[%s] %s%s: %s", ts, badge, m.Username, m.Content))
	}
	os.WriteFile(c.outputBase+"-chat.txt", []byte(strings.Join(lines, "\n")), 0644)

	// Save .json
	data, _ := json.MarshalIndent(msgs, "", "  ")
	os.WriteFile(c.outputBase+"-chat.json", data, 0644)

	if c.OnStatus != nil {
		c.OnStatus(fmt.Sprintf("Chat: saved %d messages", len(msgs)))
	}
}

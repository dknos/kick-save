/**
 * chat.js — Kick.com chat capture via Pusher WebSocket
 * Connects to Kick's Pusher-based chat and logs messages to .txt and .json
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PUSHER_KEYS = ['32cbd69e4b950bf97679', 'eb1d5f283081a78b932c'];
const PUSHER_CLUSTER = 'us2';

class ChatCapture {
  constructor(chatroomId, outputBase) {
    this.chatroomId = chatroomId;
    this.outputTxt  = outputBase + '-chat.txt';
    this.outputJson = outputBase + '-chat.json';
    this.ws = null;
    this.messages = [];
    this.connected = false;
    this.stopped = false;
    this.onMessage = null;
    this.onStatus = null;
  }

  async connect() {
    for (const key of PUSHER_KEYS) {
      try {
        await this._tryConnect(key);
        if (this.connected) return true;
      } catch (_) {}
    }
    this.onStatus?.('Chat: could not connect (all Pusher keys failed)');
    return false;
  }

  _tryConnect(appKey) {
    return new Promise((resolve, reject) => {
      const url = `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${appKey}?protocol=7&client=js&version=8.3.0&flash=false`;
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);

      ws.on('open', () => {
        this.onStatus?.('Chat: WebSocket connected, subscribing...');
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.event === 'pusher:connection_established') {
            clearTimeout(timeout);
            // Subscribe to chatroom
            ws.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` }
            }));
          }

          if (msg.event === 'pusher_internal:subscription_succeeded') {
            this.connected = true;
            this.ws = ws;
            this.onStatus?.(`Chat: subscribed to chatroom ${this.chatroomId}`);
            resolve(true);
          }

          if (msg.event === 'pusher:error') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.data?.message || 'Pusher error'));
          }

          // Chat messages
          if (msg.event === 'App\\Events\\ChatMessageEvent' ||
              msg.event === 'App\\Events\\ChatMessageSentEvent') {
            const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            this._handleMessage(data);
          }

          // Keep-alive
          if (msg.event === 'pusher:ping') {
            ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          }
        } catch (_) {}
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!this.stopped && this.connected) {
          this.onStatus?.('Chat: disconnected, reconnecting in 3s...');
          setTimeout(() => { if (!this.stopped) this._tryConnect(appKey).catch(() => {}); }, 3000);
        }
      });
    });
  }

  _handleMessage(data) {
    const entry = {
      timestamp: data.created_at || new Date().toISOString(),
      username:  data.sender?.username || 'unknown',
      color:     data.sender?.identity?.color || '#FFFFFF',
      badges:    (data.sender?.identity?.badges || []).map(b => b.type),
      content:   data.content || '',
      type:      data.type || 'message',
      id:        data.id || null,
    };
    this.messages.push(entry);
    this.onMessage?.(entry);
  }

  formatLine(entry) {
    const ts = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
    const badges = entry.badges.length ? `[${entry.badges.join(',')}] ` : '';
    return `[${ts}] ${badges}${entry.username}: ${entry.content}`;
  }

  stop() {
    this.stopped = true;
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this._save();
    return this.messages.length;
  }

  _save() {
    if (!this.messages.length) return;
    // Save .txt
    const txt = this.messages.map(m => this.formatLine(m)).join('\n');
    fs.writeFileSync(this.outputTxt, txt, 'utf8');
    // Save .json
    fs.writeFileSync(this.outputJson, JSON.stringify(this.messages, null, 2), 'utf8');
    this.onStatus?.(`Chat: saved ${this.messages.length} messages → ${path.basename(this.outputTxt)}`);
  }

  get messageCount() { return this.messages.length; }
}

module.exports = { ChatCapture };

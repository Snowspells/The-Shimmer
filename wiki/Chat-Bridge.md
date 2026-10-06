# Chat Bridge

The Shimmer provides a real-time chat bridge between **Discord**, the **in-game Global chat**, and the **website**. Messages sent on any platform are relayed to all others, keeping Shattered Echoes community members connected wherever they are.

## How It Works

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│          │  POST /api/bridge  │          │  Send to channel   │          │
│   Game   │ ──────────────────>│The Shimmer│ ──────────────────>│ Discord  │
│  Server  │    /incoming       │   Bot    │                    │ Channel  │
│          │                    │          │                    │          │
│          │  GAME_WEBHOOK_URL  │          │  messageCreate     │          │
│          │ <──────────────────│          │ <──────────────────│          │
└──────────┘                    └──────────┘                    └──────────┘
                                     │ ▲
                                     │ │
                              WebSocket (ws/chat)
                                     │ │
                                     ▼ │
                                ┌──────────┐
                                │ Website  │
                                │  Users   │
                                └──────────┘
```

### Game → Discord → Web (Inbound)

1. A player sends a message in the game's Global chat
2. The game server sends a `POST` request to The Shimmer's API at `/api/bridge/incoming`
3. The Shimmer formats the message and sends it to the configured Discord channel
4. The message is also broadcast to all connected website users via WebSocket
5. The message appears in Discord as: **[Global] PlayerName:** message content

### Discord → Game + Web (Outbound)

1. A user sends a message in the bridge Discord channel
2. The Shimmer's `messageCreate` event listener detects the message
3. The bot sends a `POST` request to the game server's webhook URL
4. The message is also broadcast to all connected website users via WebSocket

### Web → Discord + Game

1. A user sends a message in the website chat
2. The WebSocket server receives it, sanitizes it (XSS filtering), and checks if the user is muted
3. The message is broadcast to all other website chat users
4. It is relayed to the configured Discord bridge channel as: **[Web] Username:** message content
5. It is relayed to the game server via the webhook URL

All messages are logged in the SQLite database for history and auditing.

---

## Website Chat

### Accessing the Chat

Navigate to `/chat` on the web dashboard (requires login). The chat page includes:

- **Message history** — The last 50 messages are loaded on connect
- **Real-time updates** — New messages appear instantly via WebSocket
- **Source labels** — Each message shows its origin: `[Discord]` (blue), `[Game]` (green), or `[Web]` (purple)
- **Online count** — Shows how many users are connected to the web chat
- **Connection status** — Green dot when connected, red when disconnected. Auto-reconnects.

### WebSocket Protocol

Connect to `ws://your-host/ws/chat` (or `wss://` for HTTPS). The connection requires a valid session cookie.

**Server → Client messages:**

| Type | Description |
|------|-------------|
| `history` | Sent on connect. Contains `messages` array of recent messages. |
| `message` | A new chat message. Contains `source`, `author_name`, `author_id`, `content`, `timestamp`. |
| `system` | A system notification (e.g. "User was muted"). Contains `content`. |
| `delete_message` | A message was deleted by staff. Contains `messageId`. |
| `online_count` | Updated count of connected web users. Contains `count`. |
| `muted` | You have been muted. Contains `reason` and `expires_at`. |
| `unmuted` | Your mute has been lifted. |
| `error` | An error message (e.g. "You are muted"). Contains `message`. |

**Client → Server messages:**

| Type | Description |
|------|-------------|
| `message` | Send a chat message. Must contain `content` (max 500 characters). |

---

## Staff Moderation Tools

Members with the configured **Staff** role or higher see moderation controls in the web chat:

### Mute a User
- Hover over a message → click the mute icon
- Enter an optional reason and duration (in minutes)
- Permanent mute if no duration is specified
- The muted user receives a notification and their input is disabled

### Unmute a User
- Click "Muted Users" in the moderation bar
- View all active mutes with reason and expiration
- Click "Unmute" to lift a mute immediately

### Delete a Message
- Hover over a message → click the ✕ button
- The message is removed from the database
- All connected clients see the message replaced with "[Message deleted by staff]"

### Moderation API Routes

| Route | Method | Access | Description |
|-------|--------|--------|-------------|
| `/chat/mute` | POST | Staff or higher | Mute a user (`userId`, required `reason` and HTTP(S) `evidenceUrl`, optional `duration` in minutes) |
| `/chat/unmute` | POST | Staff or higher | Unmute a user (`userId`, required `reason` and HTTP(S) `evidenceUrl`) |
| `/chat/delete-message` | POST | Staff or higher | Delete a message (`messageId`, required `reason` and HTTP(S) `evidenceUrl`) |
| `/chat/mutes` | GET | Staff or higher | List all active mutes |

Every mute, unmute, chat-message deletion, in-game kick, and in-game ban is logged to the Discord text channel configured by `MODERATION_LOG_CHANNEL_ID`. The bot writes a pending record before carrying out the action and updates it with the outcome. If the channel is unavailable, the moderation action is blocked.

---

## Configuration

### Required Environment Variables

```env
BRIDGE_CHANNEL_ID=1234567890123456789
BRIDGE_API_KEY=your_shared_secret_key
GAME_WEBHOOK_URL=http://your-game-server.com/api/chat
```

| Variable | Description |
|----------|-------------|
| `BRIDGE_CHANNEL_ID` | The Discord channel ID that serves as the bridge endpoint. Messages in this channel are relayed to the game and web. |
| `BRIDGE_API_KEY` | A shared secret key used to authenticate API requests from the game server. Choose a strong random string. |
| `GAME_WEBHOOK_URL` | The URL on your game server that accepts incoming chat messages from Discord/web. The Shimmer sends `POST` requests here. |

### How to find a Channel ID

1. In Discord, enable Developer Mode (**User Settings → Advanced → Developer Mode**)
2. Right-click the channel → **Copy Channel ID**

---

## REST API Reference

All API endpoints are served from the web server (default port 3000).

### Send a message from game to Discord

```http
POST /api/bridge/incoming
```

**Headers:**
| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-API-Key` | Your `BRIDGE_API_KEY` value |

**Request Body:**
```json
{
    "playerName": "PlayerOne",
    "message": "Hello from the game!",
    "playerId": "optional-player-id"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `playerName` | Yes | The in-game player's display name |
| `message` | Yes | The chat message content |
| `playerId` | No | Optional player identifier for logging |

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| `200` | `{ "success": true }` | Message delivered to Discord and web |
| `400` | `{ "error": "Missing playerName or message" }` | Required fields missing |
| `401` | `{ "error": "Unauthorized" }` | Invalid or missing API key |
| `500` | `{ "error": "Bridge channel not configured" }` | `BRIDGE_CHANNEL_ID` not set |
| `500` | `{ "error": "Bridge channel not found" }` | Channel ID doesn't match a channel the bot can see |

**Example:**
```bash
curl -X POST http://localhost:3000/api/bridge/incoming \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key" \
  -d '{"playerName": "TestPlayer", "message": "Hello from the game!"}'
```

---

### Get recent bridge messages

```http
GET /api/bridge/messages?limit=50
```

**Headers:**
| Header | Value |
|--------|-------|
| `X-API-Key` | Your `BRIDGE_API_KEY` value |

**Query Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `50` | Maximum number of messages to return |

**Response (200):**
```json
[
    {
        "id": 1,
        "source": "discord",
        "author_name": "Username",
        "author_id": "123456789",
        "content": "Hello from Discord!",
        "timestamp": "2025-01-15T12:00:00.000Z"
    },
    {
        "id": 2,
        "source": "web",
        "author_name": "WebUser",
        "author_id": "987654321",
        "content": "Hello from the website!",
        "timestamp": "2025-01-15T12:00:05.000Z"
    }
]
```

Messages are returned in chronological order (oldest first).

---

### Health check

```http
GET /api/bridge/health
```

No authentication required.

**Response (200):**
```json
{
    "status": "ok",
    "bot_online": true,
    "bridge_channel_configured": true,
    "uptime": 123456
}
```

---

## Game Server Integration

### Path of Titans (recommended)

For a Path of Titans dedicated server, use the native **RCON + server webhook**
integration — see **[Path of Titans Integration](Path-of-Titans-Integration.md)**.
When RCON is configured, Discord/Web → Game relay goes out over RCON
automatically (the HTTP paths below are only used as a fallback for custom game
integrations).

### Legacy HTTP webhook (fallback / custom games)

If your game can run custom code, it may instead use the HTTP bridge:

1. **Send messages to Discord/Web** — When a player sends a message in Global chat, make a `POST` request to `/api/bridge/incoming` with the player's name and message.

2. **Receive messages from Discord/Web** — Set up an HTTP endpoint at your `GAME_WEBHOOK_URL` that accepts `POST` requests with this body:

```json
{
    "playerName": "DiscordUsername",
    "message": "Hello from Discord!",
    "discordId": "123456789",
    "source": "discord"
}
```

The `source` field will be `"discord"` or `"web"` depending on where the message originated. This path is only used when **no RCON server is configured**.

---

## Message Format

### In Discord (from game)
```
[Global] PlayerName: message content
```

### In Discord (from web)
```
[Web] Username: message content
```

### On the website
Each message shows a colored source label, the author name, and the content. Messages from Discord are labeled in blue, game messages in green, and web messages in purple.

---

## Monitoring

The staff admin panel on the web dashboard includes a **Recent Chat Bridge Messages** section showing the last 25 bridged messages. Each entry shows:

- **Source** — Discord (blue), Game (green), or Web (purple)
- **Author** — The sender's name
- **Content** — The message text
- **Timestamp** — When the message was bridged

---

## Behavior Notes

- **Bot messages are ignored** — The bridge does not relay messages sent by bots in the Discord channel, preventing infinite relay loops.
- **Graceful degradation** — If `GAME_WEBHOOK_URL` is not configured, outbound relay (Discord/Web → Game) is silently skipped.
- **All messages are logged** — All messages from all sources are saved to the `chat_bridge_messages` SQLite table.
- **XSS protection** — All web chat messages are sanitized through the xss library before storage and broadcast.
- **Rate limiting** — The API is rate-limited to 60 requests per minute. The WebSocket connection enforces message length limits (500 characters).
- **Muted users** — Muted users cannot send messages through the web chat. Expired mutes are automatically cleared.
- **Auto-reconnect** — The web chat client automatically reconnects after 3 seconds if the WebSocket connection drops.

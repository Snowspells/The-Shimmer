# Path of Titans Integration

The Shimmer integrates directly with a **Path of Titans** dedicated server. Because
Alderon Games servers cannot run arbitrary code, the integration uses the two
channels the game actually exposes:

| Direction | Mechanism |
|-----------|-----------|
| **The Shimmer → Game** (Discord/Web chat, admin actions) | **RCON** (Source-style RCON over TCP) |
| **Game → The Shimmer** (in-game chat, join/leave, AGIDs) | The PoT server's built-in **Discord webhook** |

```
                         RCON (TCP)
   ┌──────────┐   announce / kick / ban / ...   ┌─────────────┐
   │The Shimmer│ ───────────────────────────────>│ Path of     │
   │ (bot +   │                                  │ Titans      │
   │  web)    │<─────────────────────────────────│ Server      │
   └──────────┘   Discord webhook (chat/joins)   └─────────────┘
        │ ▲              posts to a Discord channel
        │ │                  the bot watches
        ▼ │
   Discord bridge channel + website chat
```

---

## Setup

### 1. Enable RCON on your Path of Titans server

In your server configuration, enable RCON and set a port and password. Then set
the following environment variables for The Shimmer:

```env
RCON_HOST=your.server.ip
RCON_PORT=7779
RCON_PASSWORD=your_rcon_password
RCON_SERVER_NAME=Main        # optional label
```

For **multiple servers**, use `RCON_SERVERS` instead (JSON, takes precedence):

```env
RCON_SERVERS=[{"name":"Main","host":"1.2.3.4","port":7779,"password":"pw1"},{"name":"Event","host":"1.2.3.4","port":7780,"password":"pw2"}]
```

When no RCON variables are set, the integration is completely inert — the bot and
web dashboard run exactly as before.

### 2. Forward in-game chat to a Discord channel

In your Path of Titans server's Discord integration settings, configure it to
post **Global chat** and **join/leave** events to a Discord channel via webhook.
Then tell The Shimmer which channel that is:

```env
GAME_CHAT_CHANNEL_ID=1234567890123456789   # channel the PoT webhook posts to
BRIDGE_CHANNEL_ID=2234567890123456789      # human Discord chat channel
BRIDGE_RELAY_JOINS=false                   # set "true" to relay joins/leaves to the bridge channel too
```

`GAME_CHAT_CHANNEL_ID` and `BRIDGE_CHANNEL_ID` can be the **same** channel or
different channels. If different, parsed game chat is mirrored into
`BRIDGE_CHANNEL_ID` (and the website chat).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RCON_HOST` | for RCON | Server IP/hostname |
| `RCON_PORT` | for RCON | RCON TCP port (default `7779`) |
| `RCON_PASSWORD` | for RCON | RCON password |
| `RCON_SERVER_NAME` | no | Friendly label for the single server (default `Main`) |
| `RCON_SERVERS` | no | JSON array of `{name, host, port, password}` for multi-server |
| `GAME_CHAT_CHANNEL_ID` | for inbound | Discord channel that receives the PoT webhook |
| `BRIDGE_CHANNEL_ID` | for bridge | Discord channel for the human chat bridge |
| `BRIDGE_RELAY_JOINS` | no | `"true"` to relay join/leave events to the bridge channel |

### RCON command templates (advanced)

Command syntax varies between game versions. Each command is overridable; `{...}`
placeholders are substituted at send time.

| Variable | Default |
|----------|---------|
| `RCON_CMD_ANNOUNCE` | `announce {message}` |
| `RCON_CMD_CHAT` | `whisperall {message}` |
| `RCON_CMD_PLAYERLIST` | `getplayerlist` |
| `RCON_CMD_KICK` | `kick {agid} {reason}` |
| `RCON_CMD_BAN` | `ban {agid} {hours} {reason}` |
| `RCON_CMD_HEAL` | `heal {agid}` |
| `RCON_CMD_HEALALL` | `healall` |
| `RCON_CMD_WHISPER` | `whisper {agid} {message}` |
| `RCON_CMD_TELEPORT` | `teleport {agid} {x} {y} {z}` |

### Webhook parsing patterns (advanced)

If your server's webhook output differs from the defaults, override the parsers.
Each must use named capture groups: `(?<name>)`, `(?<agid>)`, and for chat
`(?<message>)`.

| Variable | Purpose |
|----------|---------|
| `POT_CHAT_REGEX` | Match an in-game chat line |
| `POT_JOIN_REGEX` | Match a join event |
| `POT_LEAVE_REGEX` | Match a leave event |

---

## Account Linking (AGID verification)

Linking proves a Discord user controls an in-game account using an RCON whisper:

1. The player runs `/link agid:<AGID>` in Discord.
2. The Shimmer whispers a one-time code to that AGID **in-game** (the player must be online).
3. The player runs `/linkverify code:<code>` to confirm the link.

If RCON is not configured, `/link` stores the AGID directly (marked unverified).
Administrators can always set a link manually with `/adminlink`.

In-game presence (player name ↔ AGID ↔ last seen) is tracked automatically from
join and chat events and is visible in the Staff Panel.

---

## Discord Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/link agid:<AGID>` | Everyone | Start linking your Discord account to your AGID |
| `/linkverify code:<code>` | Everyone | Finish linking with the in-game code |
| `/players [server]` | Manage Messages | List players currently online (RCON) |
| `/announce message:<text> [server]` | Manage Messages | Broadcast a server-wide announcement |
| `/server status` | Administrator | Show configured RCON servers and connection state |
| `/server kick agid:<AGID> reason:<text> evidence_url:<URL> [server]` | Staff or higher | Kick a player; reason and evidence URL are required and logged to `MODERATION_LOG_CHANNEL_ID` |
| `/server ban agid:<AGID> [hours] reason:<text> evidence_url:<URL> [server]` | Staff or higher | Ban a player (`hours=0` = permanent); reason and evidence URL are required and logged to `MODERATION_LOG_CHANNEL_ID` |
| `/server heal agid:<AGID> [server]` | Administrator | Heal a player |
| `/server healall [server]` | Administrator | Heal all players |
| `/server whisper agid:<AGID> message:<text> [server]` | Administrator | Private message a player |
| `/server teleport agid:<AGID> x y z [server]` | Administrator | Teleport a player |

> Discord access is enforced via each command's default member permissions; server
> owners can fine-tune them under **Server Settings → Integrations**.

---

## Staff Panel (Web)

The **Path of Titans Server (RCON)** section of `/admin` shows connection status,
a live player list, recently seen players (with AGIDs), and moderation controls:

| Action | Required level |
|--------|----------------|
| View status / live players / recent players | Support |
| Announce, Kick | Moderator |
| Ban | Administrator |

---

## Behavior Notes

- **Graceful when unconfigured** — with no RCON variables set, outbound relay falls
  back to the legacy `GAME_WEBHOOK_URL` HTTP path (if configured) and all RCON
  commands report "RCON is not configured."
- **Loop protection** — messages The Shimmer relays into the game are remembered
  briefly so the PoT webhook's echo of them is not relayed back out.
- **Auto-reconnect** — RCON connections reconnect automatically (10s backoff).
- **Resilient parsing** — unrecognized webhook lines are logged at debug level and
  ignored; parsing patterns are configurable.

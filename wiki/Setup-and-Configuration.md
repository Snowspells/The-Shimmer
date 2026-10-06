# Setup & Configuration

This guide walks through everything needed to get The Shimmer running.

## Prerequisites

- **Node.js** v16.11.0 or newer
- A **Discord Application** with a bot user ([Discord Developer Portal](https://discord.com/developers/applications))
- A Discord server where you have admin permissions

## 1. Install Dependencies

```bash
git clone https://github.com/Snowspells/The-Echo.git The-Shimmer
cd The-Shimmer
npm install
```

## 2. Create the Config File

Copy the example config to create your own:

```bash
cp src/example.config.js src/config.js
```

Edit `src/config.js` with your values:

| Field | Description |
|-------|-------------|
| `commands.prefix` | Default message command prefix (e.g. `?`) |
| `commands.message_commands` | Enable/disable message commands (`true`/`false`) |
| `users.ownerId` | Legacy bot-owner ID setting; website access is controlled by the role IDs below |
| `users.developers` | Legacy developer ID list; active Developer access is controlled by `DEVELOPER_USER_ID` below |
| `development.enabled` | If `true`, registers slash commands to a specific guild (faster updates during development) |
| `development.guildId` | The guild ID for development command registration |
| `messages.*` | Customizable error/permission messages |

> **Note:** `config.js` is gitignored and will not be committed to the repository.

## 3. Create the .env File

Create a `.env` file in the project root with the following variables:

```env
# ── Discord Bot ──────────────────────────────────────────
CLIENT_TOKEN=your_discord_bot_token

# ── Discord OAuth2 (Web Dashboard) ──────────────────────
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_CLIENT_SECRET=your_discord_application_client_secret
WEB_BASE_URL=http://localhost:3000
WEB_PORT=3000
WEB_HOST=0.0.0.0
SESSION_SECRET=any_random_string_for_session_encryption
# For remote access, set WEB_BASE_URL to the hostname/IP other machines will use.
# For direct HTTPS, use a certificate whose SAN matches that hostname/IP.
# WEB_TLS_CERT_PATH=./certs/server.pem
# WEB_TLS_KEY_PATH=./certs/server-key.pem

# ── Staff Roles ─────────────────────────────────────────
STAFF_GUILD_ID=your_discord_server_id
STAFF_IN_TRAINING_ROLE_ID=your_staff_in_training_role_id
STAFF_ROLE_ID=your_staff_role_id
OWNER_ROLE_ID=your_owner_role_id
DEVELOPER_USER_ID=your_discord_user_id

# ── Moderation Audit ─────────────────────────────────────
MODERATION_LOG_CHANNEL_ID=discord_channel_id_for_moderation_audit_logs

# ── Chat Bridge ─────────────────────────────────────────
BRIDGE_CHANNEL_ID=discord_channel_id_for_chat_bridge
BRIDGE_API_KEY=a_secret_key_shared_with_your_game_server
GAME_WEBHOOK_URL=http://your-game-server.com/api/chat   # legacy fallback only

# ── AI Chatbot Plugin (optional) ─────────────────────────
# Uncomment and set both values to enable the plugin.
# AI_SERVER_URL=http://localhost:6969/v1
# AI_CHAT_CHANNEL_ID=discord_channel_id_for_ai_chat
# AI_BOT_ACCOUNT_NAME=Shimmer
# AI_MODEL=trinity
# AI_API_KEY=local-matrix
# FORUM_CHANNEL_ID=discord_creature_profiles_forum_channel
# RULES_FORUM_CHANNEL_ID=discord_in_game_rules_forum_channel

# ── Path of Titans (RCON + server webhook) ──────────────
RCON_HOST=your.server.ip
RCON_PORT=7779
RCON_PASSWORD=your_rcon_password
GAME_CHAT_CHANNEL_ID=discord_channel_the_pot_webhook_posts_to
# BRIDGE_RELAY_JOINS=true   # relay join/leave events to the bridge channel

# ── Logging ─────────────────────────────────────────────
LOG_LEVEL=info
```

### Variable Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `CLIENT_TOKEN` | Yes | Your Discord bot token from the Developer Portal |
| `DISCORD_CLIENT_ID` | For web | OAuth2 client ID (found in your Discord application's OAuth2 page) |
| `DISCORD_CLIENT_SECRET` | For web | OAuth2 client secret |
| `WEB_BASE_URL` | For web | The public URL of your web dashboard (e.g. `https://echo.example.com`) |
| `WEB_PORT` | No | Port for the web server (default: `3000`) |
| `WEB_HOST` | No | Network interface to bind (default: `0.0.0.0`, all interfaces). Use `127.0.0.1` to restrict access to this machine. |
| `WEB_TLS_CERT_PATH` | No | Path to the TLS certificate PEM file. Set together with `WEB_TLS_KEY_PATH` to serve HTTPS directly; relative paths are resolved from the project directory. |
| `WEB_TLS_KEY_PATH` | No | Path to the TLS private key PEM file. Set together with `WEB_TLS_CERT_PATH` to serve HTTPS directly; relative paths are resolved from the project directory. |
| `SESSION_SECRET` | For web | Random string used to encrypt session cookies. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `STAFF_GUILD_ID` | For staff | The Discord guild where the bot resolves members' current role permissions for website access. The bot must be a member of this guild. |
| `STAFF_IN_TRAINING_ROLE_ID` | No | Discord role ID for the Staff in Training website access level. |
| `STAFF_ROLE_ID` | No | Discord role ID for the Staff website access level. |
| `OWNER_ROLE_ID` | No | Discord role ID for the Owner website access level, including `/reload`. |
| `DEVELOPER_USER_ID` | No | Discord user ID granted Developer access to all website capabilities and bot commands. This identity takes precedence over configured role levels. |
| `MODERATION_LOG_CHANNEL_ID` | For moderation | Discord text-channel ID for the required moderation audit log. Kick, ban, mute, unmute, and chat-message deletion actions require a reason and an HTTP(S) evidence URL; the bot must be able to view, send messages, and embed links in this channel. If it is unset or unavailable, these actions are blocked. |
| `BRIDGE_CHANNEL_ID` | For bridge | The Discord channel ID that serves as the bridge endpoint |
| `BRIDGE_API_KEY` | For bridge | Shared secret key for authenticating game server API requests |
| `GAME_WEBHOOK_URL` | No | Legacy HTTP relay URL, used only when no RCON server is configured |
| `AI_SERVER_URL` | For AI chatbot | OpenAI-compatible inference server URL (for example, `http://localhost:6969/v1`). The plugin stays disabled unless this and `AI_CHAT_CHANNEL_ID` are set. |
| `AI_CHAT_CHANNEL_ID` | For AI chatbot | Discord channel where the chatbot listens and responds. `ALLOWED_CHANNEL_ID` is also accepted for compatibility with the standalone chatbot configuration. |
| `AI_BOT_ACCOUNT_NAME` | No | Name trigger and conversational persona (default: `Shimmer`). `BOT_ACCOUNT_NAME` is accepted as a fallback. |
| `AI_BOT_VERSION` | No | Version the assistant reports when asked (defaults to the project's package version). |
| `AI_MODEL` | No | Model name sent to the inference server (default: `trinity`). |
| `AI_API_KEY` | No | API key for inference servers that require one (default: `local-matrix`, suitable for local servers). |
| `FORUM_CHANNEL_ID` | No | Forum channel containing creature profiles to sync into chatbot context. The bot needs View Channel and Read Message History permissions there. |
| `RULES_FORUM_CHANNEL_ID` | No | Forum channel containing baseline in-game rules. The bot synchronizes current posts and archives superseded/deleted versions alongside profile history. |
| `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` | For PoT | Path of Titans RCON connection (see [Path of Titans Integration](Path-of-Titans-Integration.md)) |
| `GAME_CHAT_CHANNEL_ID` | For PoT inbound | Discord channel the PoT server webhook posts in-game chat/joins to |
| `LOG_LEVEL` | No | Logging verbosity: `error`, `warn`, `success`, `info`, or `debug` (default: `info`) |

## 4. Discord Application Setup

### Bot Permissions

When inviting the bot to your server, ensure it has these permissions:
- **View Channels** — Required to access the configured chat bridge, ticket panel, and forum channels
- **Send Messages** — Required for commands, forum access where applicable, and private ticket DMs
- **Read Message History** — Required for the chat bridge and forum profile/rule synchronization
- **Embed Links** — Required for ticket panels and log messages

### OAuth2 Configuration

In the [Discord Developer Portal](https://discord.com/developers/applications), go to your application's **OAuth2** page:

1. Under **Redirects**, add your callback URL:
   ```
   http://localhost:3000/auth/callback
   ```
   (Replace with your `WEB_BASE_URL` in production)

2. The bot uses these OAuth2 scopes:
   - `identify` — Read the user's Discord profile
   - `guilds.members.read` — Read the user's membership in the staff guild

### Bot Gateway Intents

In the Developer Portal under **Bot**, enable:
- **Message Content Intent** — Required for message commands and chat bridge relay
- **Server Members Intent** — Required to resolve members and their combined Discord role permissions for website access
- **Moderation audit channel** — The bot needs View Channel, Send Messages, and Embed Links in `MODERATION_LOG_CHANNEL_ID`.

Moderation actions initiated from the website or `/server kick` and `/server ban` require a reason and HTTP(S) evidence URL. The bot records a pending audit entry before performing an action, then marks the entry completed or failed.

The AI chatbot also needs **Message Content Intent**, **View Channel**, **Send Messages**, and **Read Message History** in its configured channel. If creature-profile sync is enabled, grant View Channel and Read Message History for the configured forum as well.

### AI Chatbot Plugin

The optional AI chatbot runs inside The Shimmer's existing Discord client; it does not create a second bot login. Configure both `AI_SERVER_URL` and `AI_CHAT_CHANNEL_ID` to enable it. In that channel it responds when mentioned, when someone replies to one of its messages, or when its configured name is used. Conversation history is read from and stored in `chat_history` under `data/chat-memory/memory.db`. Current creature profiles and rules are read from `creature_profiles` under `data/creature-profiles/creature_profiles.db`; superseded and deleted versions are read from `creature_profile_versions` under `data/creature-profile-history/creature_profile_history.db`, distinguished by source forum ID. The plugin validates required tables and columns and disables itself with an error if a database or required schema is missing. It syncs active and public archived posts at startup, then updates local records when forum posts or their messages change. Set `FORUM_CHANNEL_ID` and `RULES_FORUM_CHANNEL_ID` to the respective forums; without `FORUM_CHANNEL_ID`, existing profile records are still queried, and without `RULES_FORUM_CHANNEL_ID`, no baseline rule context is loaded. Relevant creature-specific profile rules are treated as permitted overrides of baseline rules. Future self-assignable modifiers are not yet implemented or supplied to the chatbot. Prompt size is capped at 4,500 characters and completion at 512 tokens.

### Ticket conversations

The existing `/ticketsetup panel` command still posts the button used to create a ticket. New tickets open a private DM with the bot; the user and staff can reply either in that DM or on the website's **Live Communication** page. A user can have one open DM ticket at a time. Staff in Training and higher can view and manage all tickets. Existing channel-based tickets and saved transcripts remain available as read-only history. The bot must be allowed to send DMs to members who open tickets.

The inference server is a separate process and must be running and reachable at `AI_SERVER_URL`; The Shimmer does not download or start a language model.

### Remote access and HTTPS

The server binds to all network interfaces by default. From another machine, open the server's reachable hostname or IP and port (for example, `http://192.168.1.20:3000` for HTTP testing), and ensure the host firewall allows that port. Set `WEB_BASE_URL` to the exact origin users will open.

To serve HTTPS directly in Express, provide both `WEB_TLS_CERT_PATH` and `WEB_TLS_KEY_PATH`. The server reads the PEM files at startup and serves HTTPS (including WebSockets) on `WEB_PORT`; if either variable is set without the other, startup fails with a configuration error. The certificate must be trusted by client machines and include the exact DNS name or IP address they use in its Subject Alternative Name (SAN). A certificate for `localhost` will not validate when connecting via the server's LAN IP or another hostname. Set `WEB_BASE_URL` to the matching `https://` origin and register its exact `/auth/callback` URL in the Discord Developer Portal. Without certificate paths, the server listens over HTTP.

## 5. Start The Shimmer

```bash
npm start
```

Both the Discord bot and the web dashboard start together. You should see log output confirming:
- Bot login and command registration
- Web server listening on the configured port

## 6. First-Run Staff Setup

After the bot is online in your Discord server:

1. Set `STAFF_GUILD_ID`, the three staff-role ID variables, and `DEVELOPER_USER_ID` in `.env` (see [Staff System](Staff-System.md)). Developer access is assigned by user ID; otherwise the highest configured staff role wins.
2. Ensure the bot is in that guild and has the Server Members intent enabled.
3. Open the web dashboard and log in with Discord; website privileges follow each member's current combined role permissions.

## 7. Running as a Linux systemd service

The repository includes a sample service unit at [`deploy/the-shimmer.service`](../deploy/the-shimmer.service). The example assumes The Shimmer is installed at `/opt/the-shimmer`, runs as the dedicated `the-shimmer` account, and uses Node.js at `/usr/bin/node`. Adjust those values in the unit if your installation differs.

Create the service account and install the project under its home:

```bash
sudo useradd --system --user-group --shell /usr/sbin/nologin the-shimmer
sudo install -d --owner=the-shimmer --group=the-shimmer /opt/the-shimmer
sudo -u the-shimmer git clone https://github.com/Snowspells/The-Echo.git /opt/the-shimmer
cd /opt/the-shimmer
sudo -u the-shimmer cp src/example.config.js src/config.js
sudo -u the-shimmer npm ci --omit=dev
```

Create `/opt/the-shimmer/.env` with the required production values from the configuration section above, then restrict it to the service account:

```bash
sudo chown the-shimmer:the-shimmer /opt/the-shimmer/.env /opt/the-shimmer/src/config.js
sudo chmod 600 /opt/the-shimmer/.env
```

Install and enable the service:

```bash
sudo cp /opt/the-shimmer/deploy/the-shimmer.service /etc/systemd/system/the-shimmer.service
sudo systemctl daemon-reload
sudo systemctl enable --now the-shimmer
sudo systemctl status the-shimmer
```

If Node.js is installed outside `/usr/bin`, update `ExecStart` in `/etc/systemd/system/the-shimmer.service` to the absolute path returned by `command -v node`. If you change the installation directory or service account, also update `WorkingDirectory`, `EnvironmentFile`, `User`, and `Group` in the unit. The account must own the application directory because The Shimmer writes its SQLite data and `terminal.log` there.

Use journald to inspect logs and manage the service:

```bash
sudo journalctl -u the-shimmer -f
sudo systemctl restart the-shimmer
sudo systemctl stop the-shimmer
```

On `systemctl stop` or host shutdown, the service sends `SIGTERM`; The Shimmer closes the web server and WebSockets, disconnects RCON and Discord, and closes its SQLite database before exiting. `Restart=on-failure` automatically restarts it after unexpected failures.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot won't start | Check that `CLIENT_TOKEN` is correct in `.env` and the bot is invited to at least one server |
| Web dashboard shows "Configuration Error" | Ensure `DISCORD_CLIENT_ID` is set in `.env` |
| OAuth2 callback fails | Verify the redirect URI in Discord Developer Portal matches `{WEB_BASE_URL}/auth/callback` exactly |
| Staff level not detected | Make sure `STAFF_GUILD_ID` and the appropriate role ID are set, the bot is in that guild, and Server Members Intent is enabled. Role changes are refreshed on protected requests without requiring a new login. |
| Chat bridge not relaying | Check that `BRIDGE_CHANNEL_ID` points to a valid channel the bot can read and send messages in |

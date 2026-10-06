# The Shimmer

*The Shimmer Beckons. The Shimmer Nurtures. The Shimmer Watches.*

**The Shimmer** is the community management platform for the **Shattered Echoes Fantasy Semi-Realism** Path of Titans community. It combines a Discord bot, a real-time web dashboard, and a cross-platform chat bridge into a single unified system — keeping the community connected whether members are in-game, on Discord, or browsing the website.

> **Note:** This project is built exclusively for the Shattered Echoes community. There are no plans to generalize or extend it beyond the scope of this community at this time.

## What It Does

- **Account Linking** — Players connect their Discord ID to their in-game account (AGID), with optional in-game verification via RCON whisper, enabling cross-platform tracking of currency (marks), inventory, and activity.
- **Path of Titans Integration** — Direct RCON control of a Path of Titans dedicated server (announce, kick, ban, heal, teleport) plus ingestion of the server's Discord webhook for in-game chat, join/leave events, and real AGID capture. See [Path of Titans Integration](wiki/Path-of-Titans-Integration.md).
- **Real-Time Chat Bridge** — A live chatroom on the website that bridges with Discord and the in-game Global channel, so community members can communicate from anywhere. Messages flow seamlessly between all three platforms in real time via WebSocket.
- **Optional AI Chatbot Plugin** — An OpenAI-compatible local inference backend can power a conversational Discord assistant with persistent channel history and synchronized creature-forum profiles, sharing the existing bot client and database.
- **Ticketing System** — Button-created private DM conversations, website replies on the Live Communication page, staff ticket management, and transcripts; legacy channel tickets remain read-only history.
- **Suggestions & Updates Board** — Linked members submit and track ideas on a Trello-style progress board; Owners can decline with a reason, while the Developer manages all cards.
- **Web Dashboard** — A companion website where players can view their linked account, chat with the community, browse tickets, and read transcripts — all behind Discord OAuth2 login.
- **Staff Moderation Tools** — Three role-configured staff levels plus a Developer user-ID access level for ticket support, web management, moderation, and bot commands.
- **Security** — Rate limiting on all endpoints, Helmet security headers, input sanitization (XSS protection), secure session management (httpOnly, SameSite cookies), and role-based access control with a separately configured Developer user ID.

## Quick Start

1. **Clone & install:**
   ```bash
   git clone https://github.com/Snowspells/The-Shimmer.git The-Shimmer
   cd The-Shimmer
   npm install
   ```

2. **Configure:** Copy the example files and fill in your values:
   - `src/example.config.js` → `src/config.js`
   - Create a `.env` file (see [Setup & Configuration](wiki/Setup-and-Configuration.md))

3. **Run:**
   ```bash
   npm start
   ```
   The Discord bot, web dashboard, and WebSocket chat server start together.

   To run The Shimmer persistently as a Linux service, see [Running as a systemd service](wiki/Setup-and-Configuration.md#running-as-a-linux-systemd-service).

## Documentation

Full documentation is available in the [wiki](wiki/Home.md):

- [Setup & Configuration](wiki/Setup-and-Configuration.md) — Environment variables, config file, and first-run setup.
- [Commands](wiki/Commands.md) — All Discord bot commands (slash commands, message commands, context menus).
- [Web Dashboard](wiki/Web-Dashboard.md) — Website layout, pages, and navigation.
- [Staff System](wiki/Staff-System.md) — Role-based access tiers and how to configure them.
- [Ticketing System](wiki/Ticketing-System.md) — Support tickets, transcript saving, and web viewer.
- [Path of Titans Integration](wiki/Path-of-Titans-Integration.md) — RCON setup, server webhook ingestion, AGID verification, and admin actions.
- [Chat Bridge](wiki/Chat-Bridge.md) — Real-time chat bridge setup, WebSocket protocol, and REST API reference.
- [Standalone Client API](wiki/Standalone-Client-API.md) — Token-based auth, extended WebSocket protocol, and role colors for the standalone chat client.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Discord Bot | [discord.js](https://discord.js.org/) v14 |
| Database | [SQLite](https://www.sqlite.org/) via better-sqlite3 |
| Web Server | [Express.js](https://expressjs.com/) v5 |
| Real-Time Chat | [ws](https://github.com/websockets/ws) (WebSocket) |
| Templates | [EJS](https://ejs.co/) |
| Auth | Discord OAuth2 |
| Security | [Helmet](https://helmetjs.github.io/), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit), [xss](https://github.com/leizongmin/js-xss) |

## Security

Account security is a priority for this project. The following measures are in place:

- **Rate Limiting** — All routes are rate-limited (200 req/15 min general, 15 req/15 min auth, 60 req/min API).
- **DDoS Protection** — WebSocket connection flood prevention (max 5 connections per IP, 20 connection attempts per minute per IP), per-user chat slowmode (1.5s cooldown), and 10KB message size cap.
- **Helmet** — Security headers including Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, and more.
- **XSS Protection** — All user input is sanitized before storage and rendering. Chat messages are filtered through the xss library.
- **Session Security** — httpOnly cookies, SameSite=Lax, configurable secure flag, 24-hour session expiry, custom cookie name.
- **Role-Based Access** — Staff in Training, Staff, Owner, and configured Developer access levels enforced on web routes, bot commands, and WebSocket connections. Moderation tools require Staff or above.
- **Request Size Limits** — JSON and URL-encoded body parsing limited to 1MB, WebSocket messages limited to 10KB.
- **WebSocket Authentication** — WebSocket connections require a valid session. Unauthenticated connections are immediately closed.

## Project Structure

```
src/
  index.js                     # Entry point — starts bot + web server + WebSocket
  config.js                    # Bot configuration (gitignored)
  client/                      # Discord bot client and handlers
  commands/
    Developer/                 # eval, reload (owner/developer only)
    Information/               # help
    PoT/                       # link, adminlink, staffrole
    Tickets/                   # ticket, ticketsetup
    Utility/                   # ping, setprefix
  components/                  # Button, modal, select menu, autocomplete handlers
  events/
    Client/                    # Bot ready event
    ChatBridge/                # Discord → Game → Web message relay
  structure/                   # Base classes for commands, events, components
  utils/
    Console.js                 # Logging system with configurable levels
    Database.js                # SQLite database manager
  plugins/
    ai-chatbot.js              # Optional AI assistant and creature-profile sync
  web/
    server.js                  # Express + WebSocket server
    middleware/                # Auth & staff access middleware
    routes/                    # Auth, dashboard, admin, API, tickets, chat routes
    views/                     # EJS templates (dark theme)
    public/                    # Static assets (CSS)
wiki/                          # Project documentation
```

## Contributing

Contributions are welcome. Please test your changes before submitting a pull request and follow the existing code style.

## License

[GPL-3.0](./LICENSE)

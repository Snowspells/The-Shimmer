# The Shimmer — Wiki

Welcome to The Shimmer wiki. This is the documentation for **The Shimmer**, the community management platform for the **Shattered Echoes Fantasy Semi-Realism** Path of Titans community.

## Pages

### Getting Started
- **[Setup & Configuration](Setup-and-Configuration.md)** — Environment variables, config file, Discord application setup, and first-run instructions.

### Discord Bot
- **[Commands](Commands.md)** — Complete reference for all slash commands, message commands, and context menus.

### Web Dashboard
- **[Web Dashboard](Web-Dashboard.md)** — Website pages, layout, navigation, and how users interact with the site.
- **[Suggestions & Updates Board](Web-Dashboard.md#suggestions--updates-suggestions)** — Linked-member suggestions, progress statuses, and Owner/Developer controls.

### Administration
- **[Staff System](Staff-System.md)** — Role-based access tiers (Support, Moderator, Administrator), how to configure them, and what each level can do.

### Support
- **[Ticketing System](Ticketing-System.md)** — Discord ticket channels, transcript generation, web-based transcript viewer, and setup guide.

### Game Integration
- **[Path of Titans Integration](Path-of-Titans-Integration.md)** — RCON + server webhook integration: two-way chat, AGID account verification, and admin actions (kick/ban/heal/teleport).
- **[Chat Bridge](Chat-Bridge.md)** — Real-time chat bridge between Discord, the game, and the website. Includes WebSocket protocol, REST API, and moderation tools.

---

## Overview

The Shimmer is the community management platform for the Shattered Echoes community, connecting five systems:

1. **Discord Bot** — Runs in your Discord server. Handles account linking, staff role management, ticketing, chat bridging, and utility commands.
2. **Web Dashboard** — A companion website where players log in with Discord to view their linked account, chat with the community, browse tickets, and view transcripts.
3. **Real-Time Chat** — A live chatroom on the website bridged with Discord and in-game Global chat via WebSocket.
4. **Ticketing System** — Private support channels in Discord with full transcript logging and a web interface for reviewing closed tickets.
5. **Chat Bridge** — A real-time message relay between Discord, the website, and the in-game Global chat channel.

All systems share a single SQLite database and run from a single Node.js process (`npm start`).

### Security

Account security is a core priority. All endpoints are protected by rate limiting, Helmet security headers, XSS input sanitization, secure session cookies, and role-based access control. See the [README](../README.md) for a full breakdown of security measures.

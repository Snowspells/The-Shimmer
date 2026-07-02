# Commands

The Echo supports three types of Discord commands: **slash commands**, **message commands** (prefix-based), and **context menus** (right-click).

---

## Slash Commands

Used by typing `/command` in any channel where the bot is present.

### Account Linking

| Command | Description | Access |
|---------|-------------|--------|
| `/link <agid>` | Links your Discord account to your Path of Titans AGID. With RCON configured, sends a verification code in-game that you confirm with `/linkverify`. | Everyone |
| `/linkverify <code>` | Finishes linking using the code whispered to you in-game. | Everyone |
| `/adminlink <user> <agid>` | Creates or overwrites a user's linked AGID. If the user already exists, updates their AGID; otherwise creates a new entry. | Developers only |

#### `/link`
- **Options:**
  - `agid` (required) — Your Alderon Games ID, e.g. `123-456-789`
- **Cooldown:** 5 seconds
- **Behavior:** Validates the AGID. If RCON is configured, whispers a one-time code to that AGID in-game and stores a pending verification (run `/linkverify` to confirm). If RCON is not configured, links directly (marked unverified). Will not overwrite an existing link — use `/adminlink`.

#### `/linkverify`
- **Options:**
  - `code` (required) — The verification code whispered to you in-game
- **Cooldown:** 5 seconds
- **Behavior:** Confirms a pending `/link` request and finalizes the AGID link. Codes expire after 10 minutes.

#### `/adminlink`
- **Options:**
  - `user` (required) — The Discord user to link
  - `agid` (required) — The game account ID to assign
- **Cooldown:** 5 seconds
- **Behavior:** If the user already has a linked account, their AGID is updated. Otherwise a new account is created.

---

### Path of Titans (RCON)

Requires RCON to be configured. See **[Path of Titans Integration](Path-of-Titans-Integration.md)**.

| Command | Description | Access |
|---------|-------------|--------|
| `/players [server]` | Lists players currently online on the server. | Manage Messages |
| `/announce <message> [server]` | Broadcasts a server-wide announcement in-game. | Manage Messages |
| `/deposit <amount> [server]` | Moves Marks from your character in-game into your inventory. | Everyone (linked) |
| `/withdraw <amount> [server]` | Moves Marks from your inventory onto your character in-game. | Everyone (linked) |
| `/server status` | Shows configured RCON servers and connection state. | Administrator |
| `/server kick <agid> [reason] [server]` | Kicks a player. | Administrator |
| `/server ban <agid> [hours] [reason] [server]` | Bans a player (`hours=0` = permanent). | Administrator |
| `/server heal <agid> [server]` | Heals a player. | Administrator |
| `/server healall [server]` | Heals all players. | Administrator |
| `/server whisper <agid> <message> [server]` | Sends a private message to a player. | Administrator |
| `/server teleport <agid> <x> <y> <z> [server]` | Teleports a player to coordinates. | Administrator |

---

### Staff Management

| Command | Description | Access |
|---------|-------------|--------|
| `/staffrole assign <role> <level>` | Maps a Discord role to a staff access level | Bot owner only |
| `/staffrole remove <role>` | Removes a Discord role from staff access | Bot owner only |
| `/staffrole list` | Lists all configured staff roles for the current server | Bot owner only |

#### `/staffrole assign`
- **Options:**
  - `role` (required) — The Discord role to assign
  - `level` (required) — Choose from:
    - `Support (view-only)` — Level 1
    - `Moderator (edit users)` — Level 2
    - `Administrator (full access)` — Level 3
- **Cooldown:** 3 seconds
- **Behavior:** Saves the role-to-level mapping in the database. Users with this Discord role will be granted the corresponding staff access when they log into the web dashboard.

#### `/staffrole remove`
- **Options:**
  - `role` (required) — The Discord role to remove from staff access
- **Behavior:** Removes the mapping. Users with only this role will no longer have staff access on the web dashboard (after re-login).

#### `/staffrole list`
- **Behavior:** Shows all configured staff roles for the current server, including the role name and assigned level.

See [Staff System](Staff-System.md) for full details on how role-based access works.

---

### Ticketing

| Command | Description | Access |
|---------|-------------|--------|
| `/ticket create [subject]` | Creates a new private ticket channel | Everyone |
| `/ticket close [reason]` | Closes the ticket, saves transcript, and deletes the channel | Ticket creator / Staff |
| `/ticket add <user>` | Adds a user to the ticket channel | Ticket creator / Staff |
| `/ticket remove <user>` | Removes a user from the ticket channel | Ticket creator / Staff |
| `/ticket claim` | Claims the ticket as assigned staff | Staff only |
| `/ticketsetup category <channel>` | Sets the category for new ticket channels | Administrator |
| `/ticketsetup log-channel <channel>` | Sets the log channel for ticket events | Administrator |
| `/ticketsetup support-role <role>` | Sets the role with automatic ticket access | Administrator |
| `/ticketsetup welcome-message <message>` | Sets the ticket welcome message | Administrator |
| `/ticketsetup panel [title] [description]` | Sends a ticket creation panel with button | Administrator |
| `/ticketsetup view` | Shows current ticket configuration and stats | Administrator |

See [Ticketing System](Ticketing-System.md) for full setup guide and transcript details.

---

### Utility

| Command | Description | Access |
|---------|-------------|--------|
| `/ping` | Shows the bot's WebSocket latency in milliseconds | Everyone |
| `/help` | Lists all available slash commands | Everyone |

---

### Developer / Debug

These commands are restricted to bot developers or the bot owner. They are primarily used for development and debugging.

| Command | Description | Access |
|---------|-------------|--------|
| `/eval <code>` | Executes arbitrary JavaScript code and returns the result as a file attachment. The bot token is automatically redacted from output. | Bot owner only |
| `/reload` | Reloads all commands and re-registers application commands with Discord | Developers only |
| `/components` | Sends a test message with example button and select menu components | Developers only |
| `/show-modal` | Opens a test modal dialog | Developers only |
| `/autocomplete <option>` | Tests the autocomplete interaction handler | Developers only |

> **Warning:** The `/eval` command can execute any code with the bot's permissions. It should only be accessible to the bot owner.

---

## Message Commands

Prefix-based commands triggered by typing `{prefix}command` in chat. The default prefix is `?` but can be changed per server with `setprefix`.

| Command | Aliases | Description | Access |
|---------|---------|-------------|--------|
| `help` | `h` | Lists all available message commands | Everyone (10s cooldown) |
| `ping` | `p` | Shows the bot's WebSocket latency | Everyone (5s cooldown) |
| `setprefix <new>` | — | Changes the command prefix for the current server (max 5 characters). Setting it to the default prefix resets the custom setting. | Everyone (5s cooldown) |
| `eval <code>` | `ev` | Executes JavaScript code (same as slash command version) | Bot owner only |
| `reload` | — | Reloads all commands | Developers only |

---

## Context Menus

Right-click (or long-press on mobile) a user or message to access these commands.

| Command | Type | Description | Access |
|---------|------|-------------|--------|
| User Information | User context | Shows the target user's display name, whether they're a bot, and whether they're the guild owner | Everyone (5s cooldown) |
| Message Information | Message context | Shows the message author, content, and whether it has attachments | Everyone (5s cooldown) |

---

## Access Levels

| Level | Who | Commands |
|-------|-----|----------|
| **Everyone** | All server members | `/link`, `/ticket create`, `/ping`, `/help`, `ping`, `help`, `setprefix`, context menus |
| **Server Admin** | Members with Administrator permission | `/ticketsetup` (all subcommands) |
| **Developers** | Users listed in `config.users.developers` | `/adminlink`, `/reload`, `/components`, `/show-modal`, `/autocomplete`, `reload` |
| **Bot Owner** | The user ID in `config.users.ownerId` | `/eval`, `/staffrole`, `eval`, plus everything above |

## Cooldowns

Most commands have a cooldown to prevent spam. If you trigger a command too quickly, the bot will tell you how many seconds to wait. Cooldowns are per-user, per-guild.

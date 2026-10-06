# Commands

The Shimmer supports three types of Discord commands: **slash commands**, **message commands** (prefix-based), and **context menus** (right-click).

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
| `/players [server]` | Lists players currently online on the server. | Staff or higher |
| `/announce <message> [server]` | Broadcasts a server-wide announcement in-game. | Staff or higher |
| `/server status` | Shows configured RCON servers and connection state. | Staff or higher |
| `/server kick <agid> <reason> <evidence_url> [server]` | Kicks a player; reason and evidence URL are required and the action is written to `MODERATION_LOG_CHANNEL_ID`. | Staff or higher |
| `/server ban <agid> [hours] <reason> <evidence_url> [server]` | Bans a player (`hours=0` = permanent); reason and evidence URL are required and the action is written to `MODERATION_LOG_CHANNEL_ID`. | Staff or higher |
| `/server heal <agid> [server]` | Heals a player. | Staff or higher |
| `/server healall [server]` | Heals all players. | Staff or higher |
| `/server whisper <agid> <message> [server]` | Sends a private message to a player. | Staff or higher |
| `/server teleport <agid> <x> <y> <z> [server]` | Teleports a player. | Staff or higher |

---

### Staff Management

| Command | Description | Access |
|---------|-------------|--------|
| `/staffrole assign <role> <level>` | Edits the legacy staff-role table; does not grant access | Developer only |
| `/staffrole remove <role>` | Edits the legacy staff-role table; does not grant access | Developer only |
| `/staffrole list` | Lists legacy staff-role records | Developer only |

#### `/staffrole assign`
- **Options:**
  - `role` (required) — The Discord role to assign
  - `level` (required) — Choose from:
    - `Support (view-only)` — Level 1
    - `Moderator (edit users)` — Level 2
    - `Administrator (full access)` — Level 3
- **Cooldown:** 3 seconds
- **Behavior:** Saves the legacy role mapping. Active website and bot access is configured with role IDs in `.env`; see [Staff System](Staff-System.md).

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
| `/ticket create [subject]` | Opens a private DM ticket | Everyone |
| `/ticketsetup category <channel>` | Legacy channel-ticket setting | Owner or Developer |
| `/ticketsetup log-channel <channel>` | Sets the ticket creation log channel | Owner or Developer |
| `/ticketsetup support-role <role>` | Legacy channel-ticket setting | Owner or Developer |
| `/ticketsetup welcome-message <message>` | Sets the opening DM message | Owner or Developer |
| `/ticketsetup panel [title] [description]` | Sends a ticket creation panel with button | Owner or Developer |
| `/ticketsetup view` | Shows current ticket configuration and stats | Owner or Developer |

See [Ticketing System](Ticketing-System.md) for full setup guide and transcript details.

---

### Utility

| Command | Description | Access |
|---------|-------------|--------|
| `/ping` | Shows the bot's WebSocket latency in milliseconds | Everyone |
| `/help` | Lists all available slash commands | Everyone |

---

### Developer / Debug

Developer-only commands are restricted to the Discord user configured by `DEVELOPER_USER_ID`. `/reload` is available to Owner role holders and that configured Developer user.

| Command | Description | Access |
|---------|-------------|--------|
| `/eval <code>` | Executes arbitrary JavaScript code and returns the result as a file attachment. The bot token is automatically redacted from output. | Developer only |
| `/reload` | Reloads all commands and re-registers application commands with Discord | Owner or Developer |
| `/components` | Sends a test message with example button and select menu components | Developers only |
| `/show-modal` | Opens a test modal dialog | Developers only |
| `/autocomplete <option>` | Tests the autocomplete interaction handler | Developers only |

> **Warning:** The `/eval` command can execute any code with the bot's permissions. Keep `DEVELOPER_USER_ID` limited to a trusted account.

---

## Message Commands

Prefix-based commands triggered by typing `{prefix}command` in chat. The default prefix is `?` but can be changed per server with `setprefix`.

| Command | Aliases | Description | Access |
|---------|---------|-------------|--------|
| `help` | `h` | Lists all available message commands | Everyone (10s cooldown) |
| `ping` | `p` | Shows the bot's WebSocket latency | Everyone (5s cooldown) |
| `setprefix <new>` | — | Changes the command prefix for the current server (max 5 characters). Setting it to the default prefix resets the custom setting. | Everyone (5s cooldown) |
| `eval <code>` | `ev` | Executes JavaScript code (same as slash command version) | Developer only |
| `reload` | — | Reloads all commands | Owner or Developer |

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
| **Owner** | Members with the configured Owner role | `/reload` and `/ticketsetup` |
| **Developer** | The user ID in `DEVELOPER_USER_ID` | All commands, including `/eval`, `/adminlink`, and developer utilities |

## Cooldowns

Most commands have a cooldown to prevent spam. If you trigger a command too quickly, the bot will tell you how many seconds to wait. Cooldowns are per-user, per-guild.

# Web Dashboard

The Shimmer includes a companion website that runs alongside the Discord bot. Players log in with their Discord account to view their linked game data, and staff members access moderation tools through the admin panel.

## Accessing the Dashboard

The web dashboard starts automatically when you run `npm start`. By default it listens on port 3000:

```
http://localhost:3000
```

In production, set `WEB_BASE_URL` in your `.env` to match your domain (e.g. `https://shimmer.yourdomain.com`).

---

## Pages

### Home (`/`)

The landing page for The Shimmer. It displays:

- **The Shimmer tagline** and a brief description of what the platform does
- **Three feature cards:**
  - **Account Linking** — Link Discord to your in-game identity
  - **Global Chat Bridge** — Cross-platform chat between Discord and the game
  - **Community Hub** — Central place for stats and account management
- **Login button** — "Login with Discord" if not logged in, or "Go to Dashboard" if already authenticated

---

### Dashboard (`/dashboard`)

*Requires login.*

The user's personal page showing their linked account information, current Marks, and inventory.

**Profile Section:**
- Discord avatar (full size)
- Discord username
- Discord ID

**If account is linked (via `/link` or `/adminlink`):**

Three stat cards:
| Card | Shows |
|------|-------|
| **AGID** | The user's linked game account ID |
| **Marks** | Current currency balance |
| **Linked Since** | Date the account was first linked |

**Inventory Section:**
- Grid display of all items in the user's inventory
- Shows "Your inventory is empty." if no items

**If account is NOT linked:**
- Message explaining the account isn't linked yet
- Instructions to use `/link` in Discord or ask staff for `/adminlink`

---

### Staff Panel (`/admin`)

*Requires the Staff role or higher. See [Staff System](Staff-System.md).*

The panel and its actions follow configured role IDs in `STAFF_GUILD_ID`, rechecked for protected requests. Highest role level wins.

**Header:**
- Page title with a color-coded staff badge showing the user's level and tier name

**Stats Overview:**
| Stat | Description |
|------|-------------|
| Linked Users | Total number of accounts linked; visible to members with Manage Server or Administrator |
| Servers | Number of Discord servers the bot is in |
| Bot Uptime | How long the bot has been running |

**Role access:**
- Staff in Training: ticket management
- Staff: linked-user marks/inventory management, chat moderation, and server controls
- Owner: Staff access plus `/reload`
- Developer: all web capabilities and bot commands

In-game kicks and bans from the panel, as well as chat mute, unmute, and message-deletion endpoints, require a reason and HTTP(S) evidence URL. These actions are blocked unless `MODERATION_LOG_CHANNEL_ID` is configured and writable; each is recorded there with its outcome.

### Reaction Role Posts (`/admin/reaction-roles`)

*Requires Owner or Developer access.*

Create, edit, publish, and delete Discord posts that let members assign or remove configured roles by adding or removing reactions. Each post has custom text, a channel in `STAFF_GUILD_ID`, and up to 20 Unicode or custom emoji-to-role mappings. Drafts can be saved before publishing; published posts can be updated from the panel. This feature manages Discord roles only and is separate from in-game behavioral or stat modifiers.

The bot needs View Channel, Send Messages, Read Message History, and Add Reactions in the selected channel, plus Manage Roles in the server. Each assigned role must be below the bot's highest role and must not be managed by another integration. Removing a mapping stops future reaction changes for that emoji; it does not revoke roles members already received.

**Recent Chat Bridge Messages:**
- Visible to members with Manage Messages or Administrator; shows the 25 most recent bridged messages
- Each entry shows source (Discord/Game), author name, message content, and timestamp
- Discord messages highlighted in blue, game messages in green

---

### Tickets (`/tickets`)

*Requires login.*

The page is titled **Live Communication**. Users can open one ticket at a time, continue or close it, and review previous transcripts. New tickets create a private DM conversation with the bot; messages sent in the DM and on the website appear in the same conversation. Staff can reply to and close tickets from the website.

- Staff in Training and higher see and manage all tickets for the configured staff guild
- Members see only tickets they created
- Existing channel-based tickets remain read-only history
- **Filter buttons:** All, Open, Closed
- **Live updates:** Open conversations refresh automatically
- Closed DM tickets retain a transcript

The bot must be able to DM ticket creators. Users who cannot receive DMs cannot open a DM-backed ticket.

---

### Ticket Detail (`/tickets/:id`)

*Requires login. Must be the ticket creator or have staff access.*

Shows the ticket conversation and status. The ticket creator and staff can read it; while open, they can reply and close it. Closed tickets remain viewable as a transcript.

Legacy channel-ticket transcripts remain at `/tickets/:id/transcript`.

---

### Mini Chat

*Requires login.*

The mini chat widget appears on every authenticated page and shares messages with the configured AI chat Discord channel. Legacy `/chat` page requests redirect to the dashboard. See [Chat Bridge](Chat-Bridge.md) for details.

**Features:**
- Recent messages from the configured Discord chat channel
- Live channel updates and message delivery through WebSocket
- Connection status indicator with auto-reconnect
- Message input synchronized with the Discord chat channel

Chat moderation endpoints remain available to Staff and above; each moderation action requires a reason and evidence URL and is audited in the configured Discord moderation channel.

---

### Suggestions & Updates (`/suggestions`)

*Requires login and a linked Discord/game account.*

The Trello-style progress board is visible to all linked members. Members can submit suggestions and follow every card through **Suggested**, **Under Review**, **Approved**, **In Progress**, and **Completed**. Owners and the configured Developer can decline a card with a required reason; each decision and reason is posted to `SUGGESTION_LOG_CHANNEL_ID`. The Developer can create, edit, move, and delete cards. Progress history stays on the website.

---

### Error Page

Displayed when:
- A user tries to access a page they don't have permission for (403)
- An authentication error occurs
- The server encounters an unexpected error

Shows an error title, descriptive message, and a link back to the home page.

---

## Navigation

The navigation bar appears on every page and includes:

| Element | Visibility | Description |
|---------|------------|-------------|
| **The Shimmer** (brand) | Always | Links to the home page |
| **Home** | Always | Links to `/` |
| **Dashboard** | Logged in | Links to `/dashboard` |
| **Mini Chat** | Logged in | Compact chat widget appears on authenticated pages |
| **Tickets** | Logged in | Links to `/tickets` — view your tickets or all tickets (staff) |
| **Staff Panel** | Staff only | Links to `/admin` (only shown if the user has a staff level) |
| **Reaction Roles** | Owner and Developer | Links to `/admin/reaction-roles` to manage Discord reaction-role posts |
| **Staff Badge** | Staff only | Color-coded badge showing the user's tier (e.g. "Moderator") |
| **Avatar + Username** | Logged in | Shows the user's Discord avatar and username |
| **Logout** | Logged in | Destroys the session and redirects to home |
| **Login with Discord** | Logged out | Starts the OAuth2 login flow |

---

## Authentication Flow

1. User clicks **"Login with Discord"**
2. Redirected to Discord's OAuth2 authorization page
3. User authorizes the application (scopes: `identify`, `guilds.members.read`)
4. Discord redirects back to `/auth/callback` with an authorization code
5. The Shimmer exchanges the code for an access token
6. Fetches the user's Discord profile
7. If `STAFF_GUILD_ID` is set, fetches the user's roles in that guild and determines their staff level
8. Creates a session and redirects to `/dashboard`

Sessions are stored server-side. Logging out destroys the session entirely.

---

## Design

The dashboard uses a dark theme designed to feel at home alongside Discord:

- **Background:** Dark grays (`#0d1117`, `#161b22`)
- **Cards/panels:** Slightly lighter dark backgrounds with subtle borders
- **Accent color:** Purple (`#6e56cf`)
- **Text:** White/light gray with muted secondary text
- **Staff badges:** Blue (Support), Amber (Moderator), Red (Administrator)
- **Responsive:** Adapts to mobile screens with stacked layouts

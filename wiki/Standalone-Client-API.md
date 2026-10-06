# Standalone Client API

The Shimmer supports standalone chat clients (Windows, Linux, Android) via token-based authentication and extended WebSocket features. This page documents the API endpoints and protocol extensions used by the standalone client.

## Authentication

The standalone client uses **token-based authentication** instead of browser session cookies. The flow is:

1. Client requests a login URL from the server
2. Server returns a Discord OAuth2 authorization URL
3. User authenticates in their browser
4. Server issues a short-lived, single-use **code** (valid 5 minutes) and returns it via the `echochat://auth?code=<code>` deep link
5. Client exchanges the code for a long-lived client token (30 days) via `POST /auth/client/exchange`
6. Client stores the token securely and uses it for all subsequent requests

The one-time code keeps the long-lived token out of the browser URL/history; the token itself is only ever transmitted in the exchange response body.

### Endpoints

#### Get Login URL

```http
GET /auth/client/login
```

**Response (200):**
```json
{
    "auth_url": "https://discord.com/oauth2/authorize?client_id=...",
    "state": "random_state_string"
}
```

The client opens `auth_url` in the system browser. After Discord authorization, the user is redirected to `/auth/client/callback`, which issues a one-time code and attempts to redirect back to the app via the `echochat://auth?code=<code>` deep link. If the deep link does not open the app, the page displays the code for manual entry.

---

#### Exchange Code for Token

```http
POST /auth/client/exchange
```

**Body:**
```json
{
    "code": "<one_time_code>"
}
```

**Response (200):**
```json
{
    "token": "<client_token>"
}
```

Codes are single-use and expire after 5 minutes. After obtaining the token, validate it with `POST /auth/client/validate` to fetch the user profile and role colors.

---

#### Validate Token

```http
POST /auth/client/validate
```

**Headers:**
| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <client_token>` |

**Response (200):**
```json
{
    "valid": true,
    "user": {
        "id": "123456789",
        "username": "PlayerOne",
        "discriminator": "0",
        "avatar": "abc123",
        "isStaff": true,
        "staffLevel": 2,
        "staffLabel": "Moderator",
        "agid": "AGID-12345",
        "roleColor": "#5865f2"
    },
    "role_colors": [
        { "level": 4, "label": "Owner", "color": "#f0883e", "discord_role_id": null },
        { "level": 3, "label": "Administrator", "color": "#da3633", "discord_role_id": "111..." },
        { "level": 2, "label": "Moderator", "color": "#5865f2", "discord_role_id": "222..." },
        { "level": 1, "label": "Support", "color": "#3fb950", "discord_role_id": "333..." },
        { "level": 0, "label": "Member", "color": "#8b949e", "discord_role_id": null }
    ],
    "expires_at": "2025-02-15T12:00:00.000Z"
}
```

---

#### Logout (Revoke Token)

```http
POST /auth/client/logout
```

**Headers:**
| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <client_token>` |

**Response (200):**
```json
{ "success": true }
```

---

#### Get Role Colors

```http
GET /auth/client/role-colors
```

No authentication required.

**Response (200):**
```json
{
    "role_colors": [
        { "level": 4, "label": "Owner", "color": "#f0883e", "discord_role_id": null },
        { "level": 3, "label": "Administrator", "color": "#da3633", "discord_role_id": "111..." },
        { "level": 2, "label": "Moderator", "color": "#5865f2", "discord_role_id": "222..." },
        { "level": 1, "label": "Support", "color": "#3fb950", "discord_role_id": "333..." },
        { "level": 0, "label": "Member", "color": "#8b949e", "discord_role_id": null }
    ]
}
```

---

## WebSocket Connection

Connect to `ws://your-host/ws/chat?token=<client_token>` (or `wss://` for HTTPS).

The standalone client uses the same WebSocket protocol as the web dashboard (see [Chat Bridge](Chat-Bridge.md)), with these additional message types:

### Additional Server → Client Messages

#### `online_users`

Sent on connect and whenever a user joins or leaves. Contains the full list of connected users, sorted by staff level (highest first).

```json
{
    "type": "online_users",
    "users": [
        {
            "id": "123456789",
            "username": "Owner",
            "avatar": "abc123",
            "staffLevel": 4,
            "staffLabel": "Owner",
            "roleColor": "#f0883e",
            "agid": "AGID-001",
            "source": "client"
        },
        {
            "id": "987654321",
            "username": "Member",
            "avatar": null,
            "staffLevel": 0,
            "staffLabel": "Member",
            "roleColor": "#8b949e",
            "agid": null,
            "source": "web"
        }
    ],
    "count": 2
}
```

#### `role_colors`

Sent on connect. Contains the role color configuration.

```json
{
    "type": "role_colors",
    "colors": [
        { "level": 4, "label": "Owner", "color": "#f0883e", "discord_role_id": null },
        { "level": 0, "label": "Member", "color": "#8b949e", "discord_role_id": null }
    ]
}
```

### Extended `message` Fields

Messages from users include additional fields for role display:

```json
{
    "type": "message",
    "source": "client",
    "author_name": "PlayerOne",
    "author_id": "123456789",
    "content": "Hello from the standalone client!",
    "timestamp": "2025-01-15T12:00:00.000Z",
    "isStaff": true,
    "staffLevel": 2,
    "staffLabel": "Moderator",
    "roleColor": "#5865f2",
    "agid": "AGID-12345"
}
```

---

## Moderation API

Staff members can use the same moderation endpoints as the web dashboard, authenticated with their client token via the `Authorization: Bearer <token>` header instead of session cookies.

See [Chat Bridge — Moderation API Routes](Chat-Bridge.md#moderation-api-routes) for endpoint details.

---

## Role Color Configuration

Role colors are stored in the `role_colors` database table:

| Column | Type | Description |
|--------|------|-------------|
| `level` | INTEGER | Staff level (0=Member, 1=Support, 2=Moderator, 3=Administrator, 4=Owner) |
| `label` | TEXT | Display label for the role |
| `color` | TEXT | Hex color code (e.g., `#5865f2`) |
| `discord_role_id` | TEXT | Optional Discord role ID to tie this color to |

Default colors are seeded on first run. To change a role's color, update the database directly or use a future admin API endpoint.

---

## Security Notes

- Client tokens are 48-byte random hex strings (384 bits of entropy)
- Tokens expire after 30 days
- Tokens are stored **hashed (SHA-256)** in the `client_tokens` database table, so a database leak does not expose usable credentials
- Stored Discord OAuth tokens (`access_token`/`refresh_token`) are encrypted at rest with AES-256-GCM using a key derived from `SESSION_SECRET` (or `TOKEN_ENCRYPTION_KEY`)
- The browser only ever receives a short-lived single-use code (5 min), never the long-lived token
- Expired tokens, OAuth states, and one-time codes are purged on a background interval (every 10 minutes)
- All moderation actions require the same staff level as the web dashboard
- WebSocket connections via token have the same rate limiting and DDoS protection as session-based connections

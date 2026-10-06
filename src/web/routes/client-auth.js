const express = require('express');
const crypto = require('crypto');
const { info, error, debug, warn } = require('../../utils/Console');
const DatabaseManager = require('../../utils/Database');
const { resolveWebPermissions } = require('../middleware/auth');

const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getClientRedirectUri() {
    const base = (process.env.WEB_BASE_URL || `http://localhost:${process.env.WEB_PORT || 3000}`)
        .replace(/\/+$/, '');
    return `${base}/auth/client/callback`;
}

// Standalone client initiates Discord OAuth2 login
router.get('/login', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
        return res.status(500).json({ error: 'Discord OAuth2 is not configured.' });
    }

    const state = crypto.randomBytes(16).toString('hex');
    req.db.createOAuthState(state);

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: getClientRedirectUri(),
        response_type: 'code',
        scope: 'identify guilds.members.read',
        state: state
    });

    res.json({
        auth_url: `https://discord.com/oauth2/authorize?${params}`,
        state: state
    });
});

// Exchange a short-lived one-time code (from the OAuth2 callback) for a client token
router.post('/exchange', (req, res) => {
    const code = req.body?.code;
    if (!code) {
        return res.status(400).json({ error: 'Missing code.' });
    }

    const token = req.db.consumeAuthCode(code);
    if (!token) {
        return res.status(400).json({ error: 'Invalid or expired code.' });
    }

    res.json({ token });
});

// OAuth2 callback — exchanges code for a client token
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state || !req.db.consumeOAuthState(state)) {
        return res.status(400).json({ error: 'Invalid OAuth2 callback.' });
    }

    try {
        const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: getClientRedirectUri()
            })
        });

        if (!tokenResponse.ok) {
            throw new Error(`Token exchange failed: ${tokenResponse.status}`);
        }

        const tokens = await tokenResponse.json();

        const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        if (!userResponse.ok) {
            throw new Error(`User fetch failed: ${userResponse.status}`);
        }

        const discordUser = await userResponse.json();

        // Determine staff level
        const config = require('../../config');
        const isOwner = discordUser.id === config.users.ownerId;
        let staffLevel = 0;
        let staffLabel = null;
        let userRoles = [];

        const staffGuildId = process.env.STAFF_GUILD_ID;
        if (staffGuildId) {
            try {
                const memberResponse = await fetch(
                    `${DISCORD_API}/users/@me/guilds/${staffGuildId}/member`,
                    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
                );

                if (memberResponse.ok) {
                    const memberData = await memberResponse.json();
                    userRoles = memberData.roles || [];
                }
            } catch (memberErr) {
                debug(`Error fetching guild member roles: ${memberErr.message}`);
            }
        }

        if (isOwner) {
            staffLevel = DatabaseManager.STAFF_LEVELS.OWNER;
            staffLabel = 'Owner';
        }

        let webPermissions;
        try {
            webPermissions = await resolveWebPermissions(req, { id: discordUser.id });
        } catch (permissionErr) {
            warn(`Could not resolve Discord web permissions for ${discordUser.id} during client login: ${permissionErr.message}`);
            webPermissions = null;
            staffLevel = 0;
            staffLabel = 'Member';
        }
        if (webPermissions) {
            staffLevel = webPermissions.staffLevel;
            staffLabel = webPermissions.staffLabel;
        }

        // Generate client token
        const clientToken = crypto.randomBytes(48).toString('hex');
        const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

        // Look up AGID
        const linkedUser = req.db.getUserByDiscordId(discordUser.id);

        // Get role color
        const roleColor = req.db.getRoleColor(staffLevel);

        req.db.createClientToken(clientToken, {
            discord_id: discordUser.id,
            username: discordUser.username,
            global_name: discordUser.global_name || null,
            discriminator: discordUser.discriminator,
            avatar: discordUser.avatar,
            is_staff: webPermissions?.isStaff || false,
            staff_level: staffLevel,
            staff_label: staffLabel,
            roles: userRoles,
            refresh_token: tokens.refresh_token,
            discord_access_token: tokens.access_token,
            expires_at: expiresAt
        });

        info(`Client token issued for ${discordUser.username} (${discordUser.id})`);

        // Issue a short-lived, single-use code instead of exposing the long-lived
        // token in the browser URL/history. The client exchanges it via /exchange.
        const oneTimeCode = crypto.randomBytes(24).toString('hex');
        req.db.createAuthCode(oneTimeCode, clientToken);

        // Return HTML page that sends the code back to the app via deep link
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Login Successful</title>
            <style>body{background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
            .card{background:#161b22;padding:2rem;border-radius:12px;border:1px solid #30363d;text-align:center;max-width:400px}
            h1{color:#3fb950;margin-bottom:1rem}p{color:#8b949e}</style></head>
            <body><div class="card">
            <h1>Login Successful</h1>
            <p>You can close this window and return to The Shimmer client.</p>
            <p id="status">Redirecting...</p>
            </div>
            <script>
            const code = '${oneTimeCode}';
            // Try deep link first, then show the one-time code for manual entry
            window.location.href = 'echochat://auth?code=' + code;
            setTimeout(() => {
                document.getElementById('status').textContent = 'If the app did not open, enter this code (valid 5 min): ' + code;
            }, 2000);
            </script>
            </body></html>
        `);
    } catch (err) {
        error('Client auth error:', err);
        res.status(500).json({ error: 'Authentication failed.' });
    }
});

// Validate a client token
router.post('/validate', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token.' });
    }

    const token = authHeader.slice(7);
    const tokenData = req.db.getClientToken(token);

    if (!tokenData) {
        return res.status(401).json({ error: 'Invalid token.' });
    }

    if (new Date(tokenData.expires_at) < new Date()) {
        req.db.deleteClientToken(token);
        return res.status(401).json({ error: 'Token expired.' });
    }

    const linkedUser = req.db.getUserByDiscordId(tokenData.discord_id);
    const roleColor = req.db.getRoleColor(tokenData.staff_level);
    const roleColors = req.db.getAllRoleColors();

    res.json({
        valid: true,
        user: {
            id: tokenData.discord_id,
            username: tokenData.username,
            displayName: tokenData.global_name || tokenData.username,
            discriminator: tokenData.discriminator,
            avatar: tokenData.avatar,
            isStaff: !!tokenData.is_staff,
            staffLevel: tokenData.staff_level,
            staffLabel: tokenData.staff_label,
            agid: linkedUser?.agid || null,
            roleColor: roleColor?.color || '#8b949e'
        },
        role_colors: roleColors,
        expires_at: tokenData.expires_at
    });
});

// Revoke a client token (logout)
router.post('/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token.' });
    }

    const token = authHeader.slice(7);
    req.db.deleteClientToken(token);
    res.json({ success: true });
});

// Get role colors configuration
router.get('/role-colors', (req, res) => {
    const roleColors = req.db.getAllRoleColors();
    res.json({ role_colors: roleColors });
});

module.exports = router;

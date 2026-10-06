const express = require('express');
const crypto = require('crypto');
const { info, error, debug, warn } = require('../../utils/Console');
const { resolveWebPermissions } = require('../middleware/auth');
const DatabaseManager = require('../../utils/Database');

const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';

function getRedirectUri() {
    const base = (process.env.WEB_BASE_URL || `http://localhost:${process.env.WEB_PORT || 3000}`)
        .replace(/\/+$/, '');
    return `${base}/auth/callback`;
}

router.get('/login', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
        return res.status(500).render('error', {
            title: 'Configuration Error',
            message: 'Discord OAuth2 is not configured. Set DISCORD_CLIENT_ID in .env.',
            user: null
        });
    }

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauth_state = state;

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: getRedirectUri(),
        response_type: 'code',
        scope: 'identify guilds.members.read',
        state: state
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || state !== req.session.oauth_state) {
        return res.status(400).render('error', {
            title: 'Authentication Error',
            message: 'Invalid OAuth2 callback. Please try logging in again.',
            user: null
        });
    }

    delete req.session.oauth_state;

    try {
        const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: getRedirectUri()
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

        // Determine staff level from Discord guild roles
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
                    debug(`Fetched Discord roles for ${discordUser.username}: [${userRoles.join(', ')}]`);
                } else {
                    debug(`Could not fetch guild member for ${discordUser.username}: ${memberResponse.status}`);
                }
            } catch (memberErr) {
                debug(`Error fetching guild member roles: ${memberErr.message}`);
            }
        }

        if (isOwner) {
            staffLevel = DatabaseManager.STAFF_LEVELS.ADMINISTRATOR;
            staffLabel = 'Administrator (Owner)';
        }

        let webPermissions;
        try {
            webPermissions = await resolveWebPermissions(req, { id: discordUser.id });
        } catch (permissionErr) {
            warn(`Could not resolve Discord web permissions for ${discordUser.id} during login: ${permissionErr.message}`);
            webPermissions = null;
            staffLevel = 0;
            staffLabel = 'Member';
        }
        if (webPermissions) {
            staffLevel = webPermissions.staffLevel;
            staffLabel = webPermissions.staffLabel;
        }

        req.session.user = {
            id: discordUser.id,
            username: discordUser.username,
            displayName: discordUser.global_name || discordUser.username,
            discriminator: discordUser.discriminator,
            avatar: discordUser.avatar,
            isStaff: webPermissions?.isStaff || false,
            staffLevel,
            staffLabel,
            roles: userRoles,
            webPermissions
        };

        const sessionId = crypto.randomBytes(16).toString('hex');
        req.db.createWebSession(sessionId, {
            discord_id: discordUser.id,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            username: discordUser.username,
            discriminator: discordUser.discriminator,
            avatar: discordUser.avatar,
            is_staff: webPermissions?.isStaff || false,
            expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        });

        info(`Web login: ${discordUser.username} (${discordUser.id}) — staff level: ${staffLabel || 'none'}`);
        res.redirect('/dashboard');
    } catch (err) {
        error('OAuth2 callback error:', err);
        res.status(500).render('error', {
            title: 'Authentication Error',
            message: 'Failed to complete Discord authentication. Please try again.',
            user: null
        });
    }
});

router.get('/logout', (req, res) => {
    const username = req.session.user?.username;
    req.session.destroy(() => {
        if (username) info(`Web logout: ${username}`);
        res.redirect('/');
    });
});

module.exports = router;

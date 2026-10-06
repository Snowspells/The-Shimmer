const express = require('express');
const { requireStaff, WEB_PERMISSIONS } = require('../middleware/auth');
const { info, warn } = require('../../utils/Console');
const { normalizeAgid, isValidAgid } = require('../../utils/pot');
const { executeModerationAction, ModerationActionError } = require('../../utils/ModerationAudit');

const router = express.Router();

async function addDiscordNamesToUsers(discordClient, users) {
    const guild = process.env.STAFF_GUILD_ID
        ? discordClient.guilds.cache.get(process.env.STAFF_GUILD_ID)
        : null;
    let nextUserIndex = 0;

    async function loadNextUser() {
        while (nextUserIndex < users.length) {
            const user = users[nextUserIndex++];
            let discordUser = guild?.members.cache.get(user.DID)?.user
                || discordClient.users.cache.get(user.DID);

            if (!discordUser) {
                try {
                    discordUser = await discordClient.users.fetch(user.DID);
                } catch (err) {
                    warn(`Could not fetch Discord names for linked user ${user.DID}: ${err.message}`);
                }
            }

            user.discordUsername = discordUser?.username || 'Unavailable';
            user.globalUsername = discordUser?.globalName || 'Not set';
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(10, users.length) },
        () => loadNextUser()
    ));
    return users;
}

router.get('/', requireStaff(WEB_PERMISSIONS.VIEW_STAFF_PANEL), async (req, res) => {
    const permissions = req.webPermissions;
    const users = permissions.canManageServer
        ? await addDiscordNamesToUsers(req.discordClient, req.db.getAllUsers())
        : [];
    const recentMessages = req.db.getRecentBridgeMessages(25);
    const botGuilds = req.discordClient.guilds.cache.size;
    const recentTickets = permissions.canManageServer ? req.db.getAllTickets(10) : [];
    const ticketStats = process.env.STAFF_GUILD_ID
        && permissions.canManageServer
        ? req.db.getTicketStats(process.env.STAFF_GUILD_ID)
        : { total: 0, open: 0, closed: 0 };

    const rcon = req.discordClient.rcon;
    const rconEnabled = !!rcon?.isEnabled();

    res.render('admin', {
        user: req.session.user,
        users,
        recentMessages,
        recentTickets,
        ticketStats,
        rconEnabled,
        rconStatus: rconEnabled ? rcon.status() : [],
        onlinePlayers: req.db.getOnlineGamePlayers(),
        recentGamePlayers: req.db.getRecentGamePlayers(25),
        permissions: req.webPermissions,
        stats: {
            totalUsers: users.length,
            botGuilds,
            botUptime: formatUptime(req.discordClient.uptime)
        }
    });
});

// ---- Path of Titans RCON actions ---------------------------------------

function rconOrError(req, res) {
    const rcon = req.discordClient.rcon;
    if (!rcon?.isEnabled()) {
        res.status(400).json({ error: 'RCON is not configured.' });
        return null;
    }
    return rcon;
}

// Live player list (Manage Server, Kick Members, or Ban Members)
router.get('/rcon/players', requireStaff([
    WEB_PERMISSIONS.MANAGE_SERVER,
    WEB_PERMISSIONS.KICK_PLAYERS,
    WEB_PERMISSIONS.BAN_PLAYERS
]), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    try {
        const response = await rcon.getPlayers(req.query.server || null);
        res.json({ players: response });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// Announce (Manage Server)
router.post('/rcon/announce', requireStaff(WEB_PERMISSIONS.MANAGE_SERVER), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    const { message, server } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });
    try {
        await rcon.announce(message.trim().slice(0, 300), server || null);
        info(`Web RCON announce by ${req.session.user.displayName || req.session.user.username}: ${message}`);
        res.json({ success: true });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// Kick (Kick Members)
router.post('/rcon/kick', requireStaff(WEB_PERMISSIONS.KICK_PLAYERS), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    const { agid, reason, evidenceUrl, server } = req.body;
    if (!isValidAgid(agid)) return res.status(400).json({ error: 'Invalid AGID' });
    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'In-game kick',
            target: `AGID ${normalizeAgid(agid)}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            maxReasonLength: 200,
            evidenceUrl,
            context: `Server: ${server || 'Primary'}`
        }, () => rcon.kick(normalizeAgid(agid), reason.trim().slice(0, 200), server || null));
        info(`Web RCON kick by ${req.session.user.displayName || req.session.user.username}: ${agid}`);
        res.json({ success: true, auditWarning });
    } catch (err) {
        const status = err instanceof ModerationActionError ? err.statusCode : 502;
        res.status(status).json({ error: err.message });
    }
});

// Ban (Ban Members)
router.post('/rcon/ban', requireStaff(WEB_PERMISSIONS.BAN_PLAYERS), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    const { agid, hours, reason, evidenceUrl, server } = req.body;
    if (!isValidAgid(agid)) return res.status(400).json({ error: 'Invalid AGID' });
    const banHours = hours === undefined || hours === null || hours === '' ? 0 : Number(hours);
    if (!Number.isSafeInteger(banHours) || banHours < 0) {
        return res.status(400).json({ error: 'Ban duration must be a non-negative whole number of hours.' });
    }
    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'In-game ban',
            target: `AGID ${normalizeAgid(agid)}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            maxReasonLength: 200,
            evidenceUrl,
            context: `Duration: ${banHours === 0 ? 'Permanent' : `${banHours} hours`}; server: ${server || 'Primary'}`
        }, () => rcon.ban(normalizeAgid(agid), banHours, reason.trim().slice(0, 200), server || null));
        info(`Web RCON ban by ${req.session.user.displayName || req.session.user.username}: ${agid}`);
        res.json({ success: true, auditWarning });
    } catch (err) {
        const status = err instanceof ModerationActionError ? err.statusCode : 502;
        res.status(status).json({ error: err.message });
    }
});

router.post('/users/:id/update', requireStaff(WEB_PERMISSIONS.MANAGE_SERVER), (req, res) => {
    const discordId = req.params.id;
    const { agid, marks, inventory } = req.body;

    const updateData = {};
    if (agid !== undefined) {
        if (typeof agid !== 'string' || !agid.trim()) {
            return res.status(400).render('error', {
                title: 'Invalid Account ID',
                message: 'AGID must not be empty.',
                user: req.session.user
            });
        }
        updateData.agid = agid.trim();
    }
    if (marks !== undefined) {
        const parsedMarks = Number(marks);
        if (typeof marks !== 'string' || !/^\d+$/.test(marks.trim()) ||
            !Number.isSafeInteger(parsedMarks) || parsedMarks < 0) {
            return res.status(400).render('error', {
                title: 'Invalid Marks',
                message: 'Marks must be a non-negative whole number.',
                user: req.session.user
            });
        }
        updateData.marks = parsedMarks;
    }
    if (inventory !== undefined) {
        let parsedInventory;
        try {
            parsedInventory = JSON.parse(inventory);
        } catch {
            return res.status(400).render('error', {
                title: 'Invalid Inventory',
                message: 'Inventory must be valid JSON.',
                user: req.session.user
            });
        }
        if (!Array.isArray(parsedInventory)) {
            return res.status(400).render('error', {
                title: 'Invalid Inventory',
                message: 'Inventory must be a JSON array.',
                user: req.session.user
            });
        }
        updateData.inventory = parsedInventory;
    }

    if (Object.keys(updateData).length > 0) {
        req.db.updateUser(discordId, updateData);
        info(`Admin ${req.session.user.displayName || req.session.user.username} (${req.session.user.staffLabel}) updated user ${discordId}: ${JSON.stringify(updateData)}`);
    }

    res.redirect('/admin');
});

router.post('/users/:id/delete', requireStaff(WEB_PERMISSIONS.MANAGE_SERVER), (req, res) => {
    const discordId = req.params.id;
    req.db.deleteUser(discordId);
    info(`Admin ${req.session.user.displayName || req.session.user.username} (${req.session.user.staffLabel}) deleted user ${discordId}`);
    res.redirect('/admin');
});

function formatUptime(ms) {
    if (!ms) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m ${seconds % 60}s`;
}

module.exports = router;

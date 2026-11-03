const express = require('express');
const { EmbedBuilder } = require('discord.js');
const { requireStaff, WEB_PERMISSIONS } = require('../middleware/auth');
const { info, warn } = require('../../utils/Console');
const { normalizeAgid, isValidAgid } = require('../../utils/pot');
const { executeModerationAction, ModerationActionError } = require('../../utils/ModerationAudit');
const echoConfig = require('../../utils/EchoConfig');
const { InfractionError, getSettings: getInfractionSettings } = require('../../utils/InfractionManager');

const router = express.Router();

async function resolveDiscordName(discordClient, discordId) {
    try {
        const user = discordClient.users.cache.get(discordId) || await discordClient.users.fetch(discordId);
        return user.globalName || user.username;
    } catch {
        return discordId;
    }
}

function describeUserChange(change) {
    if (change.field === 'marks') {
        return { name: 'Marks', value: `${change.from} â†’ ${change.to}` };
    }
    const summarize = json => {
        try {
            const items = JSON.parse(json || '[]');
            const text = JSON.stringify(items);
            return `${items.length} item(s): ${text.length > 400 ? `${text.slice(0, 400)}â€¦` : text}`;
        } catch {
            return 'Unreadable';
        }
    };
    return {
        name: 'Inventory',
        value: `Before â€” ${summarize(change.from)}\nAfter â€” ${summarize(change.to)}`.slice(0, 1024)
    };
}

async function postUserChangeToDiscord(discordClient, { actorName, actorId, targetName, targetId, changes, reason }) {
    const channelId = process.env.USER_CHANGE_LOG_CHANNEL_ID;
    if (!channelId || changes.length === 0) return;
    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            throw new Error('USER_CHANGE_LOG_CHANNEL_ID must identify an accessible text channel.');
        }
        const embed = new EmbedBuilder()
            .setColor(0x6e56cf)
            .setTitle('Account updated')
            .addFields(
                { name: 'User', value: `${targetName} (${targetId})`.slice(0, 1024) },
                { name: 'Changed by', value: `${actorName} (${actorId})`.slice(0, 1024) },
                { name: 'Reason', value: String(reason || 'No reason given').slice(0, 1024) },
                ...changes.map(describeUserChange)
            )
            .setTimestamp();
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        warn(`Could not post account change to the user change log channel: ${err.message}`);
    }
}

async function dmUserAboutChange(discordClient, { actorName, targetId, changes, reason }) {
    if (changes.length === 0) return;
    try {
        const user = await discordClient.users.fetch(targetId);
        const embed = new EmbedBuilder()
            .setColor(0x6e56cf)
            .setTitle('Your account was updated')
            .setDescription(`Changed by ${actorName}.`)
            .addFields(
                { name: 'Reason', value: String(reason || 'No reason given').slice(0, 1024) },
                ...changes.map(describeUserChange)
            )
            .setTimestamp();
        await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        warn(`Could not DM user ${targetId} about an account change: ${err.message}`);
    }
}

async function dmUserAboutDeletion(discordClient, { actorName, targetId, reason }) {
    try {
        const user = await discordClient.users.fetch(targetId);
        const embed = new EmbedBuilder()
            .setColor(0xd9534f)
            .setTitle('Your linked account was removed')
            .setDescription(`Removed by ${actorName}.`)
            .addFields({ name: 'Reason', value: String(reason || 'No reason given').slice(0, 1024) })
            .setTimestamp();
        await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        warn(`Could not DM user ${targetId} about account deletion: ${err.message}`);
    }
}

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

function ticketStatsFor(req) {
    return process.env.STAFF_GUILD_ID
        ? req.db.getTicketStats(process.env.STAFF_GUILD_ID)
        : { total: 0, open: 0, closed: 0 };
}

const VIEW_SERVER_CONTROLS = [
    WEB_PERMISSIONS.USE_RCON,
    WEB_PERMISSIONS.KICK_PLAYERS,
    WEB_PERMISSIONS.BAN_PLAYERS,
    WEB_PERMISSIONS.MUTE_PLAYERS
];

// Overview dashboard
router.get('/', requireStaff(WEB_PERMISSIONS.VIEW_STAFF_PANEL), (req, res) => {
    const permissions = req.webPermissions;
    res.render('admin', {
        user: req.session.user,
        permissions,
        stats: {
            totalUsers: permissions.canManageServer ? req.db.getAllUsers().length : 0,
            openTickets: permissions.canManageTickets ? ticketStatsFor(req).open : 0,
            botGuilds: req.discordClient.guilds.cache.size,
            botUptime: formatUptime(req.discordClient.uptime)
        }
    });
});

// Server controls dashboard
router.get('/server', requireStaff(VIEW_SERVER_CONTROLS), (req, res) => {
    const rcon = req.discordClient.rcon;
    const rconEnabled = !!rcon?.isEnabled();
    res.render('admin/server', {
        user: req.session.user,
        permissions: req.webPermissions,
        rconEnabled,
        rconStatus: rconEnabled ? rcon.status() : [],
        recentGamePlayers: req.db.getRecentGamePlayers(25)
    });
});

// Linked users dashboard
router.get('/users', requireStaff(WEB_PERMISSIONS.MANAGE_SERVER), async (req, res) => {
    req.db.markNotificationsViewed(req.session.user.id, {
        scope: 'user_changes',
        includeRecipient: false
    });
    const users = await addDiscordNamesToUsers(req.discordClient, req.db.getAllUsers());
    res.render('admin/users', {
        user: req.session.user,
        permissions: req.webPermissions,
        users
    });
});

// Echo / shop catalog (read from the JSON files under config/)
router.get('/catalog', requireStaff([WEB_PERMISSIONS.MANAGE_ECHO, WEB_PERMISSIONS.MANAGE_SHOP]), (req, res) => {
    res.render('admin/catalog', {
        user: req.session.user,
        permissions: req.webPermissions,
        tiers: echoConfig.getTiers().map(tier => ({ ...tier, echoes: echoConfig.getEchoesForTier(tier) })),
        species: echoConfig.getSpecies(),
        shopItems: echoConfig.getShopItems()
    });
});

// Reports and appeals
function staffActor(req) {
    return { id: req.session.user.id, name: req.session.user.displayName || req.session.user.username };
}

function infractionFailure(req, res, err) {
    const known = err instanceof InfractionError;
    res.status(known ? 400 : 500).render('error', {
        title: known ? 'Action Failed' : 'Error',
        message: known ? err.message : 'Something went wrong. Please try again.',
        user: req.session.user
    });
}

router.get('/reports', requireStaff(WEB_PERMISSIONS.JUDGE_REPORTS), (req, res) => {
    const manager = req.discordClient.infractions;
    res.render('admin/reports', {
        user: req.session.user,
        permissions: req.webPermissions,
        settings: getInfractionSettings(),
        reports: manager.getPendingReports().map(report => ({ ...report, points: manager.activePoints(report.target_agid) })),
        appeals: req.webPermissions.canDecideAppeals ? manager.getPendingAppeals() : [],
        recent: manager.getRecentJudgedReports()
    });
});

router.post('/reports/:id/judge', requireStaff(WEB_PERMISSIONS.JUDGE_REPORTS), async (req, res) => {
    try {
        await req.discordClient.infractions.judge(Number(req.params.id), String(req.body.judgement || ''), staffActor(req));
        res.redirect('/admin/reports');
    } catch (err) {
        infractionFailure(req, res, err);
    }
});

router.post('/appeals/:id/decide', requireStaff(WEB_PERMISSIONS.DECIDE_APPEALS), async (req, res) => {
    try {
        const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
        await req.discordClient.infractions.decideAppeal(Number(req.params.id), req.body.decision === 'approve', staffActor(req), note);
        res.redirect('/admin/reports');
    } catch (err) {
        infractionFailure(req, res, err);
    }
});

// Ticket management dashboard
router.get('/tickets', requireStaff(WEB_PERMISSIONS.MANAGE_TICKETS), (req, res) => {
    const currentFilter = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;
    let tickets = req.db.getAllTickets();
    if (currentFilter) tickets = tickets.filter(ticket => ticket.status === currentFilter);
    res.render('admin/tickets', {
        user: req.session.user,
        permissions: req.webPermissions,
        tickets,
        ticketStats: ticketStatsFor(req),
        currentFilter
    });
});

// Chat moderation dashboard
router.get('/chat', requireStaff(WEB_PERMISSIONS.MANAGE_CHAT), (req, res) => {
    res.render('admin/chat', {
        user: req.session.user,
        permissions: req.webPermissions,
        chatMutes: req.db.getAllChatMutes(),
        recentMessages: req.db.getRecentBridgeMessages(25)
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
    WEB_PERMISSIONS.USE_RCON,
    WEB_PERMISSIONS.KICK_PLAYERS,
    WEB_PERMISSIONS.BAN_PLAYERS,
    WEB_PERMISSIONS.MUTE_PLAYERS
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
router.post('/rcon/announce', requireStaff(WEB_PERMISSIONS.USE_RCON), async (req, res) => {
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

// In-game mute (Staff or higher)
router.post('/rcon/mute', requireStaff(WEB_PERMISSIONS.MUTE_PLAYERS), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    const { agid, minutes, reason, evidenceUrl, server } = req.body;
    if (!isValidAgid(agid)) return res.status(400).json({ error: 'Invalid AGID' });
    const muteMinutes = minutes === undefined || minutes === null || minutes === '' ? 0 : Number(minutes);
    if (!Number.isSafeInteger(muteMinutes) || muteMinutes < 0 || muteMinutes > 525600) {
        return res.status(400).json({ error: 'Mute duration must be a whole number of minutes from 0 (permanent) to 525600.' });
    }
    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'In-game mute',
            target: `AGID ${normalizeAgid(agid)}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            maxReasonLength: 200,
            evidenceUrl,
            context: `Duration: ${muteMinutes === 0 ? 'Permanent' : `${muteMinutes} minutes`}; server: ${server || 'Primary'}`
        }, () => rcon.mute(normalizeAgid(agid), muteMinutes, reason.trim().slice(0, 200), server || null));
        info(`Web RCON mute by ${req.session.user.displayName || req.session.user.username}: ${agid}`);
        res.json({ success: true, auditWarning });
    } catch (err) {
        const status = err instanceof ModerationActionError ? err.statusCode : 502;
        res.status(status).json({ error: err.message });
    }
});

// In-game unmute (Staff or higher)
router.post('/rcon/unmute', requireStaff(WEB_PERMISSIONS.MUTE_PLAYERS), async (req, res) => {
    const rcon = rconOrError(req, res);
    if (!rcon) return;
    const { agid, reason, evidenceUrl, server } = req.body;
    if (!isValidAgid(agid)) return res.status(400).json({ error: 'Invalid AGID' });
    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'In-game unmute',
            target: `AGID ${normalizeAgid(agid)}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            maxReasonLength: 200,
            evidenceUrl,
            context: `Server: ${server || 'Primary'}`
        }, () => rcon.unmute(normalizeAgid(agid), server || null));
        info(`Web RCON unmute by ${req.session.user.displayName || req.session.user.username}: ${agid}`);
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

router.post('/users/:id/update', requireStaff(WEB_PERMISSIONS.MANAGE_ECONOMY), async (req, res) => {
    const discordId = req.params.id;
    const { agid, marks, inventory } = req.body;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 300) {
        return res.status(400).render('error', {
            title: 'Reason Required',
            message: 'Enter a reason of up to 300 characters for this change.',
            user: req.session.user
        });
    }

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
        const actor = req.session.user;
        const actorName = actor.displayName || actor.username;
        const targetName = await resolveDiscordName(req.discordClient, discordId);
        const changes = req.db.updateUser(discordId, updateData, {
            actorId: actor.id,
            actorName,
            targetName,
            reason
        });
        info(`Admin ${actorName} (${actor.staffLabel}) updated user ${discordId} (reason: ${reason}): ${JSON.stringify(updateData)}`);
        await postUserChangeToDiscord(req.discordClient, {
            actorName, actorId: actor.id, targetName, targetId: discordId, changes, reason
        });
        await dmUserAboutChange(req.discordClient, { actorName, targetId: discordId, changes, reason });
    }

    res.redirect('/admin');
});

router.post('/users/:id/delete', requireStaff(WEB_PERMISSIONS.MANAGE_ECONOMY), async (req, res) => {
    const discordId = req.params.id;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 300) {
        return res.status(400).render('error', {
            title: 'Reason Required',
            message: 'Enter a reason of up to 300 characters for deleting this user.',
            user: req.session.user
        });
    }
    const actorName = req.session.user.displayName || req.session.user.username;
    const existed = req.db.userExists(discordId);
    req.db.deleteUser(discordId);
    if (existed) await dmUserAboutDeletion(req.discordClient, { actorName, targetId: discordId, reason });
    info(`Admin ${req.session.user.displayName || req.session.user.username} (${req.session.user.staffLabel}) deleted user ${discordId} (reason: ${reason})`);
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

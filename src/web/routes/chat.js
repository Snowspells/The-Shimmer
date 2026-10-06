const express = require('express');
const { requireAuth, requireStaff, WEB_PERMISSIONS } = require('../middleware/auth');
const { executeModerationAction, ModerationActionError } = require('../../utils/ModerationAudit');

const router = express.Router();

router.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

function isDiscordId(value) {
    return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function moderationFailure(res, err) {
    const status = err instanceof ModerationActionError ? err.statusCode : 502;
    return res.status(status).json({ error: err.message });
}

// Staff: Mute a user
router.post('/mute', requireStaff(WEB_PERMISSIONS.MANAGE_CHAT), async (req, res) => {
    const { userId, reason, evidenceUrl, duration } = req.body;
    const user = req.session.user;

    if (!isDiscordId(userId)) {
        return res.status(400).json({ error: 'A valid Discord userId is required.' });
    }

    let expiresAt = null;
    if (duration !== undefined && duration !== null && String(duration).trim() !== '') {
        if (!/^\d+$/.test(String(duration)) || Number(duration) < 1 || Number(duration) > 525600) {
            return res.status(400).json({ error: 'Duration must be a whole number of minutes from 1 to 525600.' });
        }
        expiresAt = new Date(Date.now() + Number(duration) * 60 * 1000).toISOString();
    }

    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'Chat mute',
            target: `Discord user ${userId}`,
            actorName: user.displayName || user.username,
            actorId: user.id,
            reason,
            evidenceUrl,
            context: `Duration: ${expiresAt ? `${Number(duration)} minutes` : 'Permanent'}`
        }, () => {
            if (!req.db.setChatMute(userId, user.id, user.displayName || user.username, reason.trim(), expiresAt)) {
                throw new Error('The chat mute could not be saved.');
            }
        });

        const webServer = req.webServer;
        if (webServer) {
            for (const [, client] of webServer.wsClients) {
                if (client.user.id === userId && client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({
                        type: 'muted',
                        reason: reason.trim(),
                        expires_at: expiresAt
                    }));
                }
            }
            webServer.broadcastToWebClients({
                type: 'system',
                content: `${userId} has been muted by ${user.displayName || user.username}.`,
                timestamp: new Date().toISOString()
            });
        }
        res.json({ success: true, auditWarning });
    } catch (err) {
        moderationFailure(res, err);
    }
});

// Staff: Unmute a user
router.post('/unmute', requireStaff(WEB_PERMISSIONS.MANAGE_CHAT), async (req, res) => {
    const { userId, reason, evidenceUrl } = req.body;

    if (!isDiscordId(userId)) {
        return res.status(400).json({ error: 'A valid Discord userId is required.' });
    }
    if (!req.db.getChatMute(userId)) {
        return res.status(404).json({ error: 'That user does not have an active chat mute.' });
    }

    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'Chat unmute',
            target: `Discord user ${userId}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            evidenceUrl
        }, () => {
            if (!req.db.removeChatMute(userId)) throw new Error('The chat mute could not be removed.');
        });

        const webServer = req.webServer;
        if (webServer) {
            for (const [, client] of webServer.wsClients) {
                if (client.user.id === userId && client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({ type: 'unmuted' }));
                }
            }
        }
        res.json({ success: true, auditWarning });
    } catch (err) {
        moderationFailure(res, err);
    }
});

// Staff: Delete a message
router.post('/delete-message', requireStaff(WEB_PERMISSIONS.MANAGE_CHAT), async (req, res) => {
    const { messageId, reason, evidenceUrl } = req.body;

    if (!/^\d+$/.test(String(messageId)) || Number(messageId) < 1 || !Number.isSafeInteger(Number(messageId))) {
        return res.status(400).json({ error: 'A valid messageId is required.' });
    }

    const parsedMessageId = Number(messageId);
    try {
        const { auditWarning } = await executeModerationAction(req.discordClient, {
            action: 'Chat message deletion',
            target: `Website chat message ${parsedMessageId}`,
            actorName: req.session.user.displayName || req.session.user.username,
            actorId: req.session.user.id,
            reason,
            evidenceUrl
        }, () => {
            if (!req.db.deleteBridgeMessage(parsedMessageId)) throw new Error('The chat message could not be deleted.');
        });

        const webServer = req.webServer;
        if (webServer) {
            webServer.broadcastToWebClients({
                type: 'delete_message',
                messageId: parsedMessageId
            });
        }
        res.json({ success: true, auditWarning });
    } catch (err) {
        moderationFailure(res, err);
    }
});

// Staff: Get active mutes
router.get('/mutes', requireStaff(WEB_PERMISSIONS.MANAGE_CHAT), (req, res) => {
    const mutes = req.db.getAllChatMutes();
    res.json({ mutes });
});

module.exports = router;

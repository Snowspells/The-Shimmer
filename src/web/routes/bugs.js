const express = require('express');
const { EmbedBuilder } = require('discord.js');
const { requireAuth, attachWebPermissions, STAFF_LEVELS } = require('../middleware/auth');
const { warn, error } = require('../../utils/Console');

const router = express.Router();
const STATUSES = ['New Bug Report', 'Investigating', 'Identified', 'Closed'];
const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 3000;
const MAX_COMMENT_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const NOTICES = Object.freeze({
    reported: 'Bug reported. Thank you!',
    updated: 'Bug updated.',
    commented: 'Comment posted.',
    deleted: 'Bug deleted.'
});

function isDeveloper(req) {
    return (req.webPermissions?.staffLevel || 0) >= STAFF_LEVELS.DEVELOPER;
}

function getActor(user) {
    return { actorId: user.id, actorName: user.displayName || user.username };
}

function showError(res, req, status, title, message) {
    return res.status(status).render('error', { title, message, user: req.session.user });
}

function parseBugId(req) {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readText(value, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && text.length <= max ? text : null;
}

async function dmDeveloper(client, { title, description }) {
    const developerId = process.env.DEVELOPER_USER_ID;
    if (!developerId) return;
    try {
        const developer = await client.users.fetch(developerId);
        const embed = new EmbedBuilder()
            .setColor(0xf0883e)
            .setTitle(title.slice(0, 256))
            .setDescription(String(description).slice(0, 4096))
            .setTimestamp();
        await developer.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        warn(`Could not DM the Developer about a bug event: ${err.message}`);
    }
}

async function postBugEventToDiscord(client, action, bug, actorName, details) {
    const channelId = process.env.BUG_LOG_CHANNEL_ID;
    if (!channelId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            throw new Error('BUG_LOG_CHANNEL_ID must identify an accessible text channel.');
        }
        const embed = new EmbedBuilder()
            .setColor(action === 'deleted' ? 0xda3633 : action === 'reported' ? 0xf0883e : 0x6e56cf)
            .setTitle(`Bug #${bug.id} ${action}`.slice(0, 256))
            .setDescription(bug.title.slice(0, 4096))
            .addFields(
                { name: 'Reported by', value: bug.creator_name.slice(0, 1024), inline: true },
                { name: 'Severity', value: bug.severity, inline: true },
                { name: 'Status', value: bug.status, inline: true },
                { name: 'Details', value: String(details || 'No additional details.').slice(0, 1024) }
            )
            .setTimestamp();
        if (action !== 'reported') embed.addFields({ name: 'Changed by', value: actorName.slice(0, 1024) });
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        warn(`Could not post bug #${bug.id} ${action} event to the bug log channel: ${err.message}`);
    }
}

function renderTracker(req, res, notice = null) {
    const userId = req.session.user.id;
    if (isDeveloper(req)) {
        req.db.markNotificationsViewed(userId, { category: 'bug_update', scope: 'private' });
        req.db.markNotificationsViewed(userId, { category: 'bug_comment', scope: 'private' });
    }
    const bugs = req.db.getBugs().map(bug => ({
        ...bug,
        activity: req.db.getBugActivity(bug.id),
        comments: req.db.getBugComments(bug.id)
    }));
    res.render('bugs', {
        user: req.session.user,
        bugs,
        statuses: STATUSES,
        severities: SEVERITIES,
        isDeveloper: isDeveloper(req),
        notice
    });
}

function requireLinkedMember(req, res, next) {
    if (!req.db.getUserByDiscordId(req.session.user.id)) {
        return showError(res, req, 403, 'Linked Account Required',
            'Link your Discord account to your game account before using the bug tracker.');
    }
    next();
}

router.use(requireAuth, attachWebPermissions, requireLinkedMember);

router.get('/', (req, res) => renderTracker(req, res, NOTICES[req.query.notice] || null));

router.post('/', async (req, res) => {
    const title = readText(req.body.title, MAX_TITLE_LENGTH);
    const description = readText(req.body.description, MAX_DESCRIPTION_LENGTH);
    const severity = SEVERITIES.includes(req.body.severity) ? req.body.severity : null;
    if (!title || !description || !severity) {
        return showError(res, req, 400, 'Invalid Bug Report',
            `Provide a title (up to ${MAX_TITLE_LENGTH} characters), details (up to ${MAX_DESCRIPTION_LENGTH}), and a severity.`);
    }
    try {
        const { actorId, actorName } = getActor(req.session.user);
        const bug = req.db.createBug({ title, description, severity, creatorId: actorId, creatorName: actorName });
        await postBugEventToDiscord(req.discordClient, 'reported', bug, actorName, description);
        if (actorId !== process.env.DEVELOPER_USER_ID) {
            await dmDeveloper(req.discordClient, {
                title: `New bug #${bug.id} (${bug.severity}): ${bug.title}`,
                description: `Reported by ${actorName}\n\n${description}`
            });
        }
        res.redirect('/bugs?notice=reported');
    } catch (err) {
        error(`Could not create bug report from ${req.session.user.id}:`, err);
        showError(res, req, 500, 'Bug Could Not Be Saved', 'Your bug report could not be saved. Please try again.');
    }
});

router.post('/:id/comments', async (req, res) => {
    const id = parseBugId(req);
    if (!id) return showError(res, req, 400, 'Invalid Bug', 'The bug ID is invalid.');
    const content = readText(req.body.content, MAX_COMMENT_LENGTH);
    if (!content) {
        return showError(res, req, 400, 'Invalid Comment',
            `A comment is required and must be ${MAX_COMMENT_LENGTH} characters or fewer.`);
    }
    const { actorId, actorName } = getActor(req.session.user);
    const comment = req.db.addBugComment(id, { authorId: actorId, authorName: actorName, content });
    if (!comment) return showError(res, req, 404, 'Bug Not Found', 'That bug report no longer exists.');
    res.redirect(`/bugs?notice=commented#bug-${id}`);
});

function requireDeveloper(req, res, next) {
    if (!isDeveloper(req)) {
        return showError(res, req, 403, 'Developer Only', 'Only the Developer can edit or manage bug reports.');
    }
    next();
}

router.post('/:id', requireDeveloper, async (req, res) => {
    const id = parseBugId(req);
    if (!id) return showError(res, req, 400, 'Invalid Bug', 'The bug ID is invalid.');
    const title = readText(req.body.title, MAX_TITLE_LENGTH);
    const description = readText(req.body.description, MAX_DESCRIPTION_LENGTH);
    if (!title || !description || !STATUSES.includes(req.body.status) || !SEVERITIES.includes(req.body.severity)) {
        return showError(res, req, 400, 'Invalid Bug', 'Title, details, status, and severity are all required.');
    }
    const { actorId, actorName } = getActor(req.session.user);
    const result = req.db.updateBug(id, {
        title, description, severity: req.body.severity, status: req.body.status, actorId, actorName
    });
    if (!result) return showError(res, req, 404, 'Bug Not Found', 'That bug report no longer exists.');
    if (result.changes.length > 0) {
        await postBugEventToDiscord(req.discordClient, 'updated', result.bug, actorName, result.changes.join('\n'));
    }
    res.redirect(`/bugs?notice=updated#bug-${id}`);
});

router.post('/:id/delete', requireDeveloper, async (req, res) => {
    const id = parseBugId(req);
    if (!id) return showError(res, req, 400, 'Invalid Bug', 'The bug ID is invalid.');
    const reason = readText(req.body.reason, MAX_REASON_LENGTH);
    if (!reason) {
        return showError(res, req, 400, 'Reason Required',
            `Enter a reason of up to ${MAX_REASON_LENGTH} characters for deleting this bug.`);
    }
    const { actorId, actorName } = getActor(req.session.user);
    const bug = req.db.deleteBug(id);
    if (!bug) return showError(res, req, 404, 'Bug Not Found', 'That bug report no longer exists.');
    await postBugEventToDiscord(req.discordClient, 'deleted', bug, actorName, `Reason: ${reason}`);
    res.redirect('/bugs?notice=deleted');
});

module.exports = router;

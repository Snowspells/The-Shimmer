const express = require('express');
const { EmbedBuilder } = require('discord.js');
const { requireAuth, attachWebPermissions, STAFF_LEVELS } = require('../middleware/auth');
const { error } = require('../../utils/Console');

const router = express.Router();
const STATUSES = ['Suggested', 'Under Review', 'Approved', 'In Progress', 'Completed'];
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 3000;
const BOARD_NOTICES = Object.freeze({
    submitted: 'Suggestion submitted.',
    created: 'Board card created.',
    updated: 'Card updated.',
    declined: 'Suggestion declined and logged.',
    deleted: 'Card deleted.'
});

function requireLinkedMember(req, res, next) {
    if (!req.db.getUserByDiscordId(req.session.user.id)) {
        return res.status(403).render('error', {
            title: 'Linked Account Required',
            message: 'Link your Discord account to your game account before using the suggestions board.',
            user: req.session.user
        });
    }
    next();
}

function getBoardCapabilities(req) {
    const level = req.webPermissions?.staffLevel || 0;
    return {
        isOwner: level >= STAFF_LEVELS.OWNER,
        isDeveloper: level >= STAFF_LEVELS.DEVELOPER
    };
}

function parseCardId(req) {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getCardInput(body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!title || title.length > MAX_TITLE_LENGTH) {
        return { error: `Title is required and must be ${MAX_TITLE_LENGTH} characters or fewer.` };
    }
    if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
        return { error: `Description is required and must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` };
    }
    return { title, description };
}

function getActor(user) {
    return {
        actorId: user.id,
        actorName: user.displayName || user.username
    };
}

function renderBoard(req, res, notice = null) {
    const cards = req.db.getSuggestions().map(card => ({
        ...card,
        activity: req.db.getSuggestionActivity(card.id)
    }));
    const capabilities = getBoardCapabilities(req);
    res.render('suggestions', {
        user: req.session.user,
        cards,
        statuses: STATUSES,
        ...capabilities,
        notice
    });
}

async function postDeclineToDiscord(client, suggestion, reason, actorName) {
    const channelId = process.env.SUGGESTION_LOG_CHANNEL_ID;
    if (!channelId) throw new Error('SUGGESTION_LOG_CHANNEL_ID is not configured.');

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        error('Could not access the suggestion-decline log channel:', err);
        throw new Error('The configured suggestion log channel is unavailable.');
    }
    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
        throw new Error('SUGGESTION_LOG_CHANNEL_ID must identify an accessible text channel.');
    }

    const embed = new EmbedBuilder()
        .setColor(0xda3633)
        .setTitle(`Suggestion #${suggestion.id} declined`)
        .setDescription(suggestion.title.slice(0, 4096))
        .addFields(
            { name: 'Reason', value: reason.slice(0, 1024) },
            { name: 'Submitted by', value: suggestion.creator_name.slice(0, 1024) },
            { name: 'Declined by', value: actorName.slice(0, 1024) }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

router.use(requireAuth, attachWebPermissions, requireLinkedMember);

router.get('/', (req, res) => renderBoard(
    req,
    res,
    BOARD_NOTICES[req.query.notice] || null
));

router.post('/', (req, res) => {
    const input = getCardInput(req.body);
    if (input.error) {
        return res.status(400).render('error', {
            title: 'Invalid Suggestion',
            message: input.error,
            user: req.session.user
        });
    }

    try {
        const user = req.session.user;
        req.db.createSuggestion({
            ...input,
            creatorId: user.id,
            creatorName: user.displayName || user.username
        });
        res.redirect('/suggestions?notice=submitted');
    } catch (err) {
        error(`Could not create suggestion from ${req.session.user.id}:`, err);
        res.status(500).render('error', {
            title: 'Suggestion Could Not Be Saved',
            message: 'Your suggestion could not be saved. Please try again.',
            user: req.session.user
        });
    }
});

router.post('/cards', (req, res) => {
    if (!getBoardCapabilities(req).isDeveloper) {
        return res.status(403).render('error', {
            title: '403 - Forbidden',
            message: 'Only the configured Developer can create managed board cards.',
            user: req.session.user
        });
    }
    const input = getCardInput(req.body);
    const status = req.body.status;
    if (input.error || !STATUSES.includes(status)) {
        return res.status(400).render('error', {
            title: 'Invalid Board Card',
            message: input.error || 'Choose a valid progress status.',
            user: req.session.user
        });
    }
    try {
        const user = req.session.user;
        req.db.createManagedSuggestion({
            ...input,
            status,
            creatorId: user.id,
            creatorName: user.displayName || user.username
        });
        res.redirect('/suggestions?notice=created');
    } catch (err) {
        error(`Could not create managed suggestion card as ${req.session.user.id}:`, err);
        res.status(500).render('error', {
            title: 'Card Could Not Be Created',
            message: 'The card could not be created. Please try again.',
            user: req.session.user
        });
    }
});

router.post('/cards/:id', (req, res) => {
    if (!getBoardCapabilities(req).isDeveloper) {
        return res.status(403).render('error', {
            title: '403 - Forbidden',
            message: 'Only the configured Developer can edit board cards.',
            user: req.session.user
        });
    }
    const id = parseCardId(req);
    if (!id) return res.status(400).render('error', {
        title: 'Invalid Card',
        message: 'The card ID is invalid.',
        user: req.session.user
    });
    const input = getCardInput(req.body);
    const status = req.body.status;
    const existingCard = req.db.getSuggestion(id);
    if (input.error || (!STATUSES.includes(status) &&
        !(status === 'Declined' && existingCard?.status === 'Declined'))) {
        return res.status(400).render('error', {
            title: 'Invalid Board Card',
            message: input.error || 'Choose a valid progress status.',
            user: req.session.user
        });
    }
    try {
        const card = req.db.updateSuggestion(id, { ...input, status, ...getActor(req.session.user) });
        if (!card) return res.status(404).render('error', {
            title: 'Card Not Found',
            message: 'That suggestion card no longer exists.',
            user: req.session.user
        });
        res.redirect('/suggestions?notice=updated');
    } catch (err) {
        error(`Could not update suggestion card ${id}:`, err);
        res.status(500).render('error', {
            title: 'Card Could Not Be Updated',
            message: 'The card could not be updated. Please try again.',
            user: req.session.user
        });
    }
});

router.post('/cards/:id/decline', async (req, res) => {
    if (!getBoardCapabilities(req).isOwner) {
        return res.status(403).render('error', {
            title: '403 - Forbidden',
            message: 'Only an Owner or the configured Developer can decline suggestions.',
            user: req.session.user
        });
    }
    const id = parseCardId(req);
    if (!id) return res.status(400).render('error', {
        title: 'Invalid Card',
        message: 'The card ID is invalid.',
        user: req.session.user
    });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 1000) {
        return res.status(400).render('error', {
            title: 'Invalid Decline Reason',
            message: 'A decline reason is required and must be 1,000 characters or fewer.',
            user: req.session.user
        });
    }
    const existing = req.db.getSuggestion(id);
    if (!existing) return res.status(404).render('error', {
        title: 'Card Not Found',
        message: 'That suggestion card no longer exists.',
        user: req.session.user
    });
    if (existing.status === 'Completed' || existing.status === 'Declined') {
        return res.status(409).render('error', {
            title: 'Suggestion Cannot Be Declined',
            message: 'Completed or already declined cards cannot be declined.',
            user: req.session.user
        });
    }

    try {
        await postDeclineToDiscord(
            req.discordClient,
            existing,
            reason,
            req.session.user.displayName || req.session.user.username
        );
        const card = req.db.declineSuggestion(id, {
            reason,
            ...getActor(req.session.user)
        });
        if (!card) return res.status(404).render('error', {
            title: 'Card Not Found',
            message: 'That suggestion card no longer exists.',
            user: req.session.user
        });
        res.redirect('/suggestions?notice=declined');
    } catch (err) {
        if (err.code === 'SUGGESTION_CANNOT_BE_DECLINED' || err.code === 'SUGGESTION_CHANGED') {
            return res.status(409).render('error', {
                title: 'Suggestion Could Not Be Declined',
                message: err.message,
                user: req.session.user
            });
        }
        error(`Could not decline suggestion card ${id}:`, err);
        res.status(503).render('error', {
            title: 'Decline Could Not Be Logged',
            message: err.message || 'The decline could not be logged to Discord, so the card was not changed.',
            user: req.session.user
        });
    }
});

router.post('/cards/:id/delete', (req, res) => {
    if (!getBoardCapabilities(req).isDeveloper) {
        return res.status(403).render('error', {
            title: '403 - Forbidden',
            message: 'Only the configured Developer can delete board cards.',
            user: req.session.user
        });
    }
    const id = parseCardId(req);
    if (!id) return res.status(400).render('error', {
        title: 'Invalid Card',
        message: 'The card ID is invalid.',
        user: req.session.user
    });
    try {
        if (!req.db.deleteSuggestion(id)) return res.status(404).render('error', {
            title: 'Card Not Found',
            message: 'That suggestion card no longer exists.',
            user: req.session.user
        });
        res.redirect('/suggestions?notice=deleted');
    } catch (err) {
        error(`Could not delete suggestion card ${id}:`, err);
        res.status(500).render('error', {
            title: 'Card Could Not Be Deleted',
            message: 'The card could not be deleted. Please try again.',
            user: req.session.user
        });
    }
});

module.exports = router;

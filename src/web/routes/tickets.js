const express = require('express');
const { requireAuth, attachWebPermissions } = require('../middleware/auth');
const { warn, error } = require('../../utils/Console');

const router = express.Router();
const MAX_TICKET_MESSAGE_LENGTH = 1900;

function getTicketId(req, res) {
    const ticketId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
        res.status(400).json({ error: 'Invalid ticket ID.' });
        return null;
    }
    return ticketId;
}

function getAuthorizedTicket(req, res, ticketId) {
    const ticket = req.db.getTicket(ticketId);
    if (!ticket) {
        res.status(404).json({ error: 'Ticket not found.' });
        return null;
    }
    const canManageTickets = Boolean(req.webPermissions?.canManageTickets);
    if (!canManageTickets && ticket.creator_id !== req.session.user.id) {
        res.status(403).json({ error: 'You cannot access this ticket.' });
        return null;
    }
    return { ticket, canManageTickets };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function buildTranscriptHtml(ticket, messages) {
    const rows = messages.map(message => `
        <article>
            <header><strong>${escapeHtml(message.author_name)}</strong> · ${escapeHtml(message.created_at)}</header>
            <p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>
        </article>
    `).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ticket #${ticket.id}</title>
        <style>body{font:15px sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}
        article{border-bottom:1px solid #ddd;padding:1rem 0}header{color:#555}p{white-space:normal;overflow-wrap:anywhere}</style>
        </head><body><h1>Ticket #${ticket.id}: ${escapeHtml(ticket.subject)}</h1>${rows}</body></html>`;
}

function renderAccessError(res, user, status, title, message) {
    return res.status(status).render('error', { title, message, user });
}

router.get('/', requireAuth, attachWebPermissions, (req, res) => {
    const user = req.session.user;
    const isStaff = Boolean(req.webPermissions?.canManageTickets);
    const statusFilter = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;

    let tickets = isStaff
        ? req.db.getAllTickets()
        : req.db.getTicketsByUser(user.id);
    if (statusFilter) tickets = tickets.filter(ticket => ticket.status === statusFilter);

    res.render('tickets', {
        user,
        tickets,
        isStaff,
        currentFilter: statusFilter
    });
});

router.post('/', requireAuth, attachWebPermissions, async (req, res) => {
    const guildId = process.env.STAFF_GUILD_ID;
    if (!guildId) return res.status(503).render('error', {
        title: 'Ticketing Unavailable',
        message: 'Ticketing is not configured yet.',
        user: req.session.user
    });

    const subject = typeof req.body.subject === 'string' ? req.body.subject.trim().slice(0, 150) : '';
    try {
        const discordUser = await req.discordClient.users.fetch(req.session.user.id);
        const ticket = await req.discordClient.ticketManager.createDmTicket(
            discordUser,
            guildId,
            subject || 'Support request'
        );
        return res.redirect(`/tickets/${ticket.id}`);
    } catch (err) {
        if (err.code === 'OPEN_TICKET_EXISTS') {
            return res.status(409).render('error', {
                title: 'Ticket Already Open',
                message: err.message,
                user: req.session.user
            });
        }
        error(`Could not create website DM ticket for ${req.session.user.id}:`, err);
        return res.status(502).render('error', {
            title: 'Ticket Could Not Be Created',
            message: 'The bot could not open a DM with your Discord account. Enable server direct messages and try again.',
            user: req.session.user
        });
    }
});

router.get('/:id', requireAuth, attachWebPermissions, (req, res) => {
    const ticketId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
        return renderAccessError(res, req.session.user, 400, '400 - Invalid Ticket', 'The ticket ID is invalid.');
    }
    const ticket = req.db.getTicket(ticketId);
    if (!ticket) return renderAccessError(res, req.session.user, 404, '404 - Not Found', 'Ticket not found.');
    const isStaff = Boolean(req.webPermissions?.canManageTickets);
    if (!isStaff && ticket.creator_id !== req.session.user.id) {
        return renderAccessError(res, req.session.user, 403, '403 - Forbidden', 'You cannot access this ticket.');
    }

    const messages = ticket.ticket_mode === 'dm' ? req.db.getTicketMessages(ticketId) : [];
    res.render('ticket-detail', {
        user: req.session.user,
        ticket,
        messages,
        isStaff,
        canReply: ticket.ticket_mode === 'dm' && ticket.status === 'open',
        legacy: ticket.ticket_mode !== 'dm'
    });
});

router.get('/:id/messages', requireAuth, attachWebPermissions, (req, res) => {
    const ticketId = getTicketId(req, res);
    if (!ticketId) return;
    const authorized = getAuthorizedTicket(req, res, ticketId);
    if (!authorized) return;
    if (authorized.ticket.ticket_mode !== 'dm') {
        return res.status(409).json({ error: 'Legacy channel tickets are read-only.' });
    }
    const afterId = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
    res.json({
        status: authorized.ticket.status,
        messages: req.db.getTicketMessages(ticketId, afterId)
    });
});

router.post('/:id/messages', requireAuth, attachWebPermissions, async (req, res) => {
    const ticketId = getTicketId(req, res);
    if (!ticketId) return;
    const authorized = getAuthorizedTicket(req, res, ticketId);
    if (!authorized) return;
    const { ticket } = authorized;
    if (ticket.ticket_mode !== 'dm') return res.status(409).json({ error: 'Legacy channel tickets are read-only.' });
    if (ticket.status !== 'open') return res.status(409).json({ error: 'This ticket is closed.' });

    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > MAX_TICKET_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `Message must be between 1 and ${MAX_TICKET_MESSAGE_LENGTH} characters.` });
    }

    const user = req.session.user;
    const isStaff = authorized.canManageTickets;
    const authorType = isStaff ? 'staff' : 'user';
    const displayName = user.displayName || user.username;
    try {
        const discordUser = await req.discordClient.users.fetch(ticket.creator_id);
        const outgoing = await discordUser.send({
            content: `**${displayName}:** ${content}`,
            allowedMentions: { parse: [] }
        });
        const saved = req.db.addTicketMessage(
            ticket.id,
            user.id,
            displayName,
            authorType,
            content,
            outgoing.id
        );
        if (!saved) return res.status(500).json({ error: 'Could not save the message to this ticket.' });
        return res.status(201).json({
            message: req.db.getTicketMessages(ticket.id, saved - 1)[0]
        });
    } catch (err) {
        error(`Could not send website reply for ticket #${ticket.id}:`, err);
        return res.status(502).json({ error: 'Could not deliver your reply through Discord. Please try again.' });
    }
});

router.post('/:id/close', requireAuth, attachWebPermissions, async (req, res) => {
    const ticketId = getTicketId(req, res);
    if (!ticketId) return;
    const authorized = getAuthorizedTicket(req, res, ticketId);
    if (!authorized) return;
    const { ticket } = authorized;
    if (ticket.ticket_mode !== 'dm') return res.status(409).json({ error: 'Legacy channel tickets are read-only.' });
    if (ticket.status !== 'open') return res.status(409).json({ error: 'This ticket is already closed.' });

    const user = req.session.user;
    const displayName = user.displayName || user.username;
    const closingMessage = `${displayName} closed this ticket.`;
    if (!req.db.closeTicket(ticket.id, user.id, displayName)) {
        return res.status(500).json({ error: 'Could not close this ticket.' });
    }
    const saved = req.db.addTicketMessage(ticket.id, user.id, displayName, 'system', closingMessage);
    if (!saved) {
        warn(`Ticket #${ticket.id} was closed but its closing message could not be saved.`);
    }
    const messages = req.db.getTicketMessages(ticket.id);
    req.db.saveTranscript(ticket.id, ticket.guild_id, buildTranscriptHtml(ticket, messages), messages.length);
    try {
        const discordUser = await req.discordClient.users.fetch(ticket.creator_id);
        await discordUser.send({
            content: `Ticket #${ticket.id} has been closed. You can review its transcript on the Live Communication page.`,
            allowedMentions: { parse: [] }
        });
    } catch (err) {
        warn(`Ticket #${ticket.id} closed, but Discord could not deliver the DM notification: ${err.message}`);
    }
    return res.json({ success: true, status: 'closed' });
});

router.get('/:id/transcript', requireAuth, attachWebPermissions, (req, res) => {
    const ticketId = Number.parseInt(req.params.id, 10);
    const ticket = Number.isSafeInteger(ticketId) ? req.db.getTicket(ticketId) : null;
    const user = req.session.user;
    if (!ticket) {
        return renderAccessError(res, user, 404, '404 - Not Found', 'Ticket not found.');
    }

    const isStaff = Boolean(req.webPermissions?.canManageTickets);
    if (!isStaff && ticket.creator_id !== user.id) {
        return renderAccessError(res, user, 403, '403 - Forbidden', 'You do not have permission to view this transcript.');
    }

    const transcript = req.db.getTranscript(ticketId);
    const messages = ticket.ticket_mode === 'dm' ? req.db.getTicketMessages(ticketId) : [];
    if (ticket.ticket_mode === 'dm' && !transcript && ticket.status === 'closed') {
        req.db.saveTranscript(ticket.id, ticket.guild_id, buildTranscriptHtml(ticket, messages), messages.length);
    }

    res.render('ticket-detail', {
        user,
        ticket,
        messages: ticket.ticket_mode === 'dm' ? messages : [],
        transcript: ticket.ticket_mode === 'dm'
            ? req.db.getTranscript(ticketId)
            : transcript,
        isStaff,
        canReply: false,
        legacy: ticket.ticket_mode !== 'dm'
    });
});

router.get('/:id/transcript/raw', requireAuth, attachWebPermissions, (req, res) => {
    const ticketId = Number.parseInt(req.params.id, 10);
    const ticket = Number.isSafeInteger(ticketId) ? req.db.getTicket(ticketId) : null;
    if (!ticket) return res.status(404).send('Ticket not found.');

    const isStaff = Boolean(req.webPermissions?.canManageTickets);
    if (!isStaff && ticket.creator_id !== req.session.user.id) return res.status(403).send('Forbidden.');

    let transcript = req.db.getTranscript(ticketId);
    if (ticket.ticket_mode === 'dm' && !transcript && ticket.status === 'closed') {
        const messages = req.db.getTicketMessages(ticketId);
        req.db.saveTranscript(ticket.id, ticket.guild_id, buildTranscriptHtml(ticket, messages), messages.length);
        transcript = req.db.getTranscript(ticketId);
    }
    if (!transcript) return res.status(404).send('No transcript available for this ticket.');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(transcript.transcript_html);
});

module.exports = router;

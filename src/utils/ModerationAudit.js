const { EmbedBuilder } = require('discord.js');
const { error, warn } = require('./Console');

class ModerationActionError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'ModerationActionError';
        this.statusCode = statusCode;
    }
}

function validateModerationDetails(reason, evidenceUrl, maxReasonLength = 1000) {
    if (typeof reason !== 'string' || !reason.trim()) {
        throw new ModerationActionError('A reason is required for moderation actions.');
    }
    if (reason.trim().length > maxReasonLength) {
        throw new ModerationActionError(`The reason must be ${maxReasonLength} characters or fewer.`);
    }
    if (typeof evidenceUrl !== 'string' || !evidenceUrl.trim()) {
        throw new ModerationActionError('An evidence URL is required for moderation actions.');
    }

    let parsedEvidenceUrl;
    try {
        parsedEvidenceUrl = new URL(evidenceUrl.trim());
    } catch {
        throw new ModerationActionError('Evidence must be a valid HTTP or HTTPS URL.');
    }
    if (!['http:', 'https:'].includes(parsedEvidenceUrl.protocol)) {
        throw new ModerationActionError('Evidence must be a valid HTTP or HTTPS URL.');
    }
    if (parsedEvidenceUrl.toString().length > 2048) {
        throw new ModerationActionError('The evidence URL must be 2,048 characters or fewer.');
    }

    return { reason: reason.trim(), evidenceUrl: parsedEvidenceUrl.toString() };
}

function createAuditEmbed(details, status) {
    const statusColors = { Pending: 0xdaa520, Completed: 0x2ecc71, Failed: 0xe74c3c };
    const embed = new EmbedBuilder()
        .setColor(statusColors[status])
        .setTitle(`Moderation Action: ${details.action}`)
        .setAuthor({ name: 'View evidence', url: details.evidenceUrl })
        .addFields(
            { name: 'Target', value: String(details.target).slice(0, 1024) },
            { name: 'Moderator', value: `${details.actorName} (${details.actorId})`.slice(0, 1024) },
            { name: 'Reason', value: details.reason.slice(0, 1024) },
            { name: 'Status', value: status }
        )
        .setTimestamp();
    if (details.context) {
        embed.addFields({ name: 'Details', value: String(details.context).slice(0, 1024) });
    }
    return embed;
}

async function executeModerationAction(client, details, performAction) {
    const validated = validateModerationDetails(details.reason, details.evidenceUrl, details.maxReasonLength);
    const channelId = process.env.MODERATION_LOG_CHANNEL_ID;
    if (!channelId) {
        throw new ModerationActionError('Moderation is disabled until MODERATION_LOG_CHANNEL_ID is configured.', 503);
    }

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        error('Could not fetch the configured moderation log channel:', err);
        throw new ModerationActionError('Could not access the configured moderation log channel.', 503);
    }
    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
        throw new ModerationActionError('MODERATION_LOG_CHANNEL_ID must be an accessible text channel.', 503);
    }

    const actionDetails = {
        ...details,
        ...validated,
        actorName: details.actorName || 'Unknown moderator',
        actorId: details.actorId || 'Unknown ID'
    };
    let auditMessage;
    try {
        auditMessage = await channel.send({ embeds: [createAuditEmbed(actionDetails, 'Pending')] });
    } catch (err) {
        error('Could not create a moderation audit entry:', err);
        throw new ModerationActionError('Could not write to the moderation log channel; no action was taken.', 503);
    }

    let result;
    try {
        result = await performAction();
    } catch (actionError) {
        try {
            await auditMessage.edit({ embeds: [createAuditEmbed(actionDetails, 'Failed')] });
        } catch (auditError) {
            error('Could not mark a failed moderation action in the audit channel:', auditError);
        }
        throw actionError;
    }

    let auditWarning = null;
    try {
        await auditMessage.edit({ embeds: [createAuditEmbed(actionDetails, 'Completed')] });
    } catch (auditError) {
        warn(`Moderation action ${details.action} completed, but its audit entry could not be updated: ${auditError.message}`);
        auditWarning = 'The action succeeded, but its audit entry status could not be updated.';
    }

    return { result, auditWarning };
}

module.exports = { executeModerationAction, ModerationActionError, validateModerationDetails };

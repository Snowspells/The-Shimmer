/**
 * Helpers for working with Path of Titans data: Alderon Games IDs (AGIDs) and
 * the messages posted by a dedicated server's built-in Discord webhook.
 *
 * The webhook output format can differ slightly between game versions and
 * server configurations, so the parsing patterns are overridable via env vars:
 *   POT_CHAT_REGEX, POT_JOIN_REGEX, POT_LEAVE_REGEX
 * Each must expose named capture groups where relevant: (?<name>), (?<agid>),
 * and for chat (?<message>).
 */

// Alderon IDs look like groups of alphanumerics separated by dashes, e.g.
// "123-456-789" or "AB1-2CD-3EF". Be permissive but reject obvious garbage.
const AGID_PATTERN = /^[A-Za-z0-9]{2,5}(?:-[A-Za-z0-9]{2,5}){1,4}$/;

function normalizeAgid(value) {
    return (value || '').toString().trim().toUpperCase();
}

function isValidAgid(value) {
    return AGID_PATTERN.test(normalizeAgid(value));
}

function compileRegex(envValue, fallback) {
    if (!envValue) return fallback;
    try {
        // Allow "/pattern/flags" or a bare pattern.
        const match = envValue.match(/^\/(.*)\/([a-z]*)$/i);
        if (match) return new RegExp(match[1], match[2]);
        return new RegExp(envValue);
    } catch {
        return fallback;
    }
}

const CHAT_REGEX = compileRegex(
    process.env.POT_CHAT_REGEX,
    /^(?:\[(?:Global|Local|Group|Admin|Server)\]\s*)?(?<name>.+?)\s*(?:\((?<agid>[A-Za-z0-9-]+)\))?\s*:\s*(?<message>.+)$/
);
const JOIN_REGEX = compileRegex(
    process.env.POT_JOIN_REGEX,
    /(?<name>.+?)\s*\((?<agid>[A-Za-z0-9-]+)\)\s*(?:has\s+)?(?:joined|connected)/i
);
const LEAVE_REGEX = compileRegex(
    process.env.POT_LEAVE_REGEX,
    /(?<name>.+?)\s*\((?<agid>[A-Za-z0-9-]+)\)\s*(?:has\s+)?(?:left|disconnected|quit)/i
);

/**
 * Flatten a Discord message's text content and embed text into candidate lines.
 * @param {import('discord.js').Message} message
 * @returns {string[]}
 */
function extractLines(message) {
    const parts = [];
    if (message.content) parts.push(message.content);
    for (const embed of message.embeds || []) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) parts.push(embed.description);
        for (const field of embed.fields || []) {
            if (field.name) parts.push(field.name);
            if (field.value) parts.push(field.value);
        }
    }
    return parts
        .join('\n')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

/**
 * Parse a Discord webhook message posted by a Path of Titans server into a list
 * of structured events.
 * @param {import('discord.js').Message} message
 * @returns {Array<{type: 'chat'|'join'|'leave', name: string, agid: string|null, content?: string}>}
 */
function parseWebhookMessage(message) {
    const events = [];
    for (const line of extractLines(message)) {
        const join = JOIN_REGEX.exec(line);
        if (join && join.groups) {
            events.push({
                type: 'join',
                name: (join.groups.name || '').trim(),
                agid: join.groups.agid ? normalizeAgid(join.groups.agid) : null
            });
            continue;
        }

        const leave = LEAVE_REGEX.exec(line);
        if (leave && leave.groups) {
            events.push({
                type: 'leave',
                name: (leave.groups.name || '').trim(),
                agid: leave.groups.agid ? normalizeAgid(leave.groups.agid) : null
            });
            continue;
        }

        const chat = CHAT_REGEX.exec(line);
        if (chat && chat.groups && chat.groups.message) {
            events.push({
                type: 'chat',
                name: (chat.groups.name || '').trim(),
                agid: chat.groups.agid ? normalizeAgid(chat.groups.agid) : null,
                content: chat.groups.message.trim()
            });
        }
    }
    return events;
}

function generateLinkCode(length = 6) {
    // Avoid ambiguous characters (0/O, 1/I).
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
}

module.exports = {
    AGID_PATTERN,
    extractLines,
    normalizeAgid,
    isValidAgid,
    parseWebhookMessage,
    generateLinkCode
};

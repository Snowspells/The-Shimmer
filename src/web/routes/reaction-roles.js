const express = require('express');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { requireStaff, WEB_PERMISSIONS } = require('../middleware/auth');
const { error, warn } = require('../../utils/Console');

const router = express.Router();
const MAX_MAPPINGS = 20;

function parsePanelId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    return value === undefined ? [] : [value];
}

function reactionKey(emoji) {
    const customEmoji = emoji.match(/^<a?:[A-Za-z0-9_~]+:(\d+)>$/);
    return customEmoji ? `id:${customEmoji[1]}` : `name:${emoji}`;
}

function getPanelInput(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const emojis = asArray(body.emoji ?? body['emoji[]']).map(value => typeof value === 'string' ? value.trim() : '');
    const roleIds = asArray(body.roleId ?? body['roleId[]']).map(value => typeof value === 'string' ? value.trim() : '');

    if (!name || name.length > 100) {
        return { error: 'A panel name is required (100 characters maximum).' };
    }
    if (!content || content.length > 2000) {
        return { error: 'The Discord post message is required (2,000 characters maximum).' };
    }
    if (emojis.length !== roleIds.length || emojis.length < 1 || emojis.length > MAX_MAPPINGS) {
        return { error: `Add between 1 and ${MAX_MAPPINGS} complete emoji-to-role mappings.` };
    }

    const seenEmojis = new Set();
    const mappings = [];
    for (let index = 0; index < emojis.length; index++) {
        if (!emojis[index] || !roleIds[index]) {
            return { error: 'Every mapping must include both an emoji and a role.' };
        }
        if (emojis[index].length > 100) {
            return { error: 'Emoji values must be 100 characters or fewer.' };
        }
        const key = reactionKey(emojis[index]);
        if (seenEmojis.has(key)) {
            return { error: 'Each emoji can only appear once in a post.' };
        }
        seenEmojis.add(key);
        mappings.push({ emoji: emojis[index], roleId: roleIds[index] });
    }
    return { name, content, mappings };
}

async function getGuildContext(client) {
    const guildId = process.env.STAFF_GUILD_ID;
    if (!guildId) throw new Error('STAFF_GUILD_ID must be configured before reaction-role posts can be managed.');

    let guild;
    try {
        guild = await client.guilds.fetch(guildId);
    } catch (err) {
        error('Could not load the configured staff guild for reaction-role management:', err);
        throw new Error('The configured staff Discord server is unavailable to the bot.');
    }
    if (!guild) throw new Error('The configured staff Discord server is unavailable to the bot.');

    const [channels, roles] = await Promise.all([
        guild.channels.fetch(),
        guild.roles.fetch()
    ]);
    const botMember = guild.members.me || await guild.members.fetchMe();
    return {
        guild,
        channels: [...channels.values()].filter(channel =>
            channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
        ).sort((left, right) => left.name.localeCompare(right.name)),
        roles: [...roles.values()].filter(role =>
            role && role.id !== guild.id && !role.managed
            && botMember.roles.highest.comparePositionTo(role) > 0
        )
            .sort((left, right) => right.position - left.position)
    };
}

function renderError(res, message, user) {
    return res.status(400).render('error', {
        title: 'Reaction Role Posts',
        message,
        user
    });
}

function preparePanels(panels, channels) {
    const channelNames = new Map(channels.map(channel => [channel.id, channel.name]));
    return panels.map(panel => ({
        ...panel,
        channelName: channelNames.get(panel.channel_id) || 'Unavailable channel',
        mappingsList: JSON.parse(panel.mappings)
    }));
}

function getSubmittedPanel(body, existing) {
    const emojis = asArray(body.emoji ?? body['emoji[]']);
    const roleIds = asArray(body.roleId ?? body['roleId[]']);
    return {
        ...(existing || {}),
        id: existing?.id || null,
        name: typeof body.name === 'string' ? body.name : '',
        content: typeof body.content === 'string' ? body.content : '',
        channel_id: typeof body.channelId === 'string' ? body.channelId : '',
        message_id: existing?.message_id || null,
        mappingsList: emojis.map((emoji, index) => ({
            emoji: typeof emoji === 'string' ? emoji : '',
            roleId: typeof roleIds[index] === 'string' ? roleIds[index] : ''
        }))
    };
}

function renderPanelPage(req, res, context, notice = null, errorMessage = null, editPanel = null) {
    const panels = preparePanels(req.db.getReactionRolePanels(), context.channels);
    const mappedPanel = editPanel
        ? {
            ...editPanel,
            mappingsList: editPanel.mappingsList || JSON.parse(editPanel.mappings)
        }
        : null;
    return res.render('reaction-roles', {
        user: req.session.user,
        panels,
        channels: context.channels,
        roles: context.roles,
        editPanel: mappedPanel,
        notice,
        errorMessage
    });
}

async function validateRoleMappings(guild, roles, mappings) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        throw new Error('The bot needs the Manage Roles permission to assign reaction roles.');
    }

    for (const mapping of mappings) {
        const role = roles.get(mapping.roleId);
        if (!role || role.managed || role.id === guild.id) {
            throw new Error('One or more selected roles are unavailable or cannot be assigned.');
        }
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
            throw new Error(`Move the bot role above "${role.name}" in the Discord role list before using it here.`);
        }
    }
}

async function getPostChannel(channel, guild) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    const permissions = channel.permissionsFor(botMember);
    const required = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AddReactions
    ];
    if (!permissions || !permissions.has(required)) {
        throw new Error('The bot needs View Channel, Send Messages, Read Message History, and Add Reactions in the selected channel.');
    }
}

async function publishPanel(client, db, panel, guild, channels, existingPanel) {
    const channel = channels.get(panel.channelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new Error('Choose an available text or announcement channel in the configured staff server.');
    }
    await getPostChannel(channel, guild);
    const allowedMentions = { parse: [] };
    let message = null;
    let oldMessage = null;
    let oldChannel = null;

    if (existingPanel?.message_id) {
        oldChannel = channels.get(existingPanel.channel_id);
        if (!oldChannel) {
            oldChannel = await client.channels.fetch(existingPanel.channel_id);
        }
        if (!oldChannel?.messages) {
            throw new Error('The channel containing the existing Discord post is unavailable.');
        }
        try {
            oldMessage = await oldChannel.messages.fetch(existingPanel.message_id);
        } catch (err) {
            error(`Could not retrieve saved reaction-role post ${existingPanel.message_id}:`, err);
            throw new Error('The existing Discord post could not be retrieved. It was not replaced.');
        }
        if (oldChannel.id === channel.id) message = oldMessage;
    }

    const isNewMessage = !message;
    const originalContent = message?.content;
    const addedReactions = [];
    try {
        if (message) {
            await message.edit({ content: panel.content, allowedMentions });
        } else {
            message = await channel.send({ content: panel.content, allowedMentions });
        }

        for (const mapping of panel.mappings) {
            const customEmoji = mapping.emoji.match(/^<a?:[A-Za-z0-9_~]+:(\d+)>$/);
            const alreadyReacted = message.reactions.cache.some(reaction =>
                customEmoji
                    ? reaction.emoji.id === customEmoji[1]
                    : reaction.emoji.name === mapping.emoji
            );
            if (!alreadyReacted) addedReactions.push(await message.react(mapping.emoji));
        }

        const saved = db.saveReactionRolePanel({ ...panel, messageId: message.id });
        if (!saved) throw new Error('The reaction-role settings could not be saved after publishing.');
    } catch (err) {
        if (isNewMessage && message) {
            try {
                await message.delete();
            } catch (cleanupError) {
                warn(`Could not remove incomplete reaction-role post ${message.id}: ${cleanupError.message}`);
                throw new Error(`${err.message} The incomplete Discord post could not be removed; delete it manually.`);
            }
        } else if (message) {
            const rollbackErrors = [];
            if (originalContent !== undefined) {
                try {
                    await message.edit({ content: originalContent, allowedMentions });
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError.message);
                }
            }
            for (const reaction of addedReactions) {
                try {
                    await reaction.users.remove(client.user.id);
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError.message);
                }
            }
            if (rollbackErrors.length) {
                throw new Error(`${err.message} The existing Discord post could not be fully restored: ${rollbackErrors.join('; ')}`);
            }
        }
        throw err;
    }

    let warning = null;
    if (oldMessage && oldChannel.id !== channel.id) {
        try {
            await oldMessage.delete();
        } catch (err) {
            warn(`Updated reaction-role post ${message.id}, but could not remove its previous Discord post: ${err.message}`);
            warning = ' The previous Discord post could not be removed; it is inactive but may still be visible.';
        }
    }
    return { panel: db.getReactionRolePanelByMessageId(message.id), warning };
}

router.get('/', requireStaff(WEB_PERMISSIONS.REFRESH_COMMANDS), async (req, res) => {
    try {
        const context = await getGuildContext(req.discordClient);
        const editId = req.query.edit ? parsePanelId(req.query.edit) : null;
        if (req.query.edit && !editId) return renderError(res, 'The selected reaction-role post ID is invalid.', req.session.user);
        const editPanel = editId ? req.db.getReactionRolePanel(editId) : null;
        if (editId && !editPanel) return renderError(res, 'The selected reaction-role post no longer exists.', req.session.user);
        return renderPanelPage(req, res, context, req.query.notice || null, null, editPanel);
    } catch (err) {
        error('Could not load reaction-role management:', err);
        return renderError(res, err.message, req.session.user);
    }
});

router.post('/', requireStaff(WEB_PERMISSIONS.REFRESH_COMMANDS), async (req, res) => {
    try {
        const context = await getGuildContext(req.discordClient);
        const input = getPanelInput(req.body);
        const editId = req.body.id ? parsePanelId(req.body.id) : null;
        const existing = editId ? req.db.getReactionRolePanel(editId) : null;
        if (req.body.id && (!editId || !existing)) throw new Error('The selected reaction-role post no longer exists.');
        if (input.error) {
            return renderPanelPage(
                req,
                res,
                context,
                null,
                input.error,
                getSubmittedPanel(req.body, existing)
            );
        }

        const channelId = typeof req.body.channelId === 'string' ? req.body.channelId : '';
        const channel = context.channels.find(item => item.id === channelId);
        if (!channel) throw new Error('Choose a text or announcement channel in the configured staff server.');
        await validateRoleMappings(context.guild, context.guild.roles.cache, input.mappings);

        const action = req.body.action === 'draft' ? 'draft' : 'publish';
        if (action === 'draft' && existing?.message_id) {
            throw new Error('Published posts must be updated with Publish / Update so the Discord message stays in sync.');
        }
        const data = {
            id: editId,
            name: input.name,
            guildId: context.guild.id,
            channelId,
            messageId: existing?.message_id || null,
            content: input.content,
            mappings: input.mappings,
            updatedBy: req.session.user.id,
            updatedByName: req.session.user.displayName || req.session.user.username
        };

        if (action === 'draft') {
            req.db.saveReactionRolePanel(data);
            return res.redirect('/admin/reaction-roles?notice=Draft%20saved.');
        }

        const result = await publishPanel(
            req.discordClient,
            req.db,
            data,
            context.guild,
            context.guild.channels.cache,
            existing
        );
        return res.redirect(`/admin/reaction-roles?notice=${encodeURIComponent(`"${result.panel.name}" published or updated.${result.warning || ''}`)}`);
    } catch (err) {
        error('Could not save or publish reaction-role post:', err);
        try {
            const context = await getGuildContext(req.discordClient);
            const editId = req.body.id ? parsePanelId(req.body.id) : null;
            const existing = editId ? req.db.getReactionRolePanel(editId) : null;
            return renderPanelPage(
                req,
                res,
                context,
                null,
                err.message,
                getSubmittedPanel(req.body, existing)
            );
        } catch (renderErr) {
            error('Could not render the reaction-role error page:', renderErr);
            return renderError(res, err.message, req.session.user);
        }
    }
});

router.post('/:id/delete', requireStaff(WEB_PERMISSIONS.REFRESH_COMMANDS), async (req, res) => {
    const panelId = parsePanelId(req.params.id);
    if (!panelId) return renderError(res, 'The selected reaction-role post ID is invalid.', req.session.user);

    const panel = req.db.getReactionRolePanel(panelId);
    if (!panel) return renderError(res, 'The selected reaction-role post no longer exists.', req.session.user);

    if (!req.db.deleteReactionRolePanel(panelId)) {
        return renderError(res, 'The reaction-role settings could not be deleted.', req.session.user);
    }
    let notice = 'Reaction-role post deleted.';
    if (panel.message_id) {
        try {
            const channel = await req.discordClient.channels.fetch(panel.channel_id);
            const message = await channel.messages.fetch(panel.message_id);
            await message.delete();
        } catch (err) {
            warn(`Deleted reaction-role configuration ${panelId}, but could not remove its Discord post: ${err.message}`);
            notice = 'Configuration deleted, but the Discord post could not be removed; it is no longer active.';
        }
    }
    return res.redirect(`/admin/reaction-roles?notice=${encodeURIComponent(notice)}`);
});

module.exports = router;

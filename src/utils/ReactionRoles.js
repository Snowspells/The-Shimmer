const { error } = require('./Console');

function matchesEmoji(mapping, reaction) {
    const customEmoji = mapping.emoji.match(/^<a?:[A-Za-z0-9_~]+:(\d+)>$/);
    return customEmoji
        ? reaction.emoji.id === customEmoji[1]
        : reaction.emoji.name === mapping.emoji;
}

async function handleReactionRole(client, reaction, user, action) {
    if (user.bot) return;

    try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
        const message = reaction.message;
        if (!message.guild) return;

        const panel = client.database.getReactionRolePanelByMessageId(message.id);
        if (!panel || panel.guild_id !== message.guild.id) return;

        const mapping = JSON.parse(panel.mappings).find(item => matchesEmoji(item, reaction));
        if (!mapping) return;

        const role = await message.guild.roles.fetch(mapping.roleId);
        if (!role || role.managed || role.id === message.guild.id) {
            throw new Error(`Configured reaction role ${mapping.roleId} is unavailable or not assignable.`);
        }
        const member = await message.guild.members.fetch(user.id);
        if (action === 'add') {
            await member.roles.add(role, `Reaction role post ${message.id}`);
        } else {
            await member.roles.remove(role, `Reaction role post ${message.id}`);
        }
    } catch (err) {
        error(`Could not ${action === 'add' ? 'assign' : 'remove'} a role from a reaction-role post:`, err);
    }
}

module.exports = { handleReactionRole };

const DatabaseManager = require('./Database');

const ROLE_LEVELS = [
    { environmentVariable: 'STAFF_IN_TRAINING_ROLE_ID', level: DatabaseManager.STAFF_LEVELS.STAFF_IN_TRAINING },
    { environmentVariable: 'STAFF_ROLE_ID', level: DatabaseManager.STAFF_LEVELS.STAFF },
    { environmentVariable: 'OWNER_ROLE_ID', level: DatabaseManager.STAFF_LEVELS.OWNER }
];

async function resolveStaffLevel(client, userId) {
    if (process.env.DEVELOPER_USER_ID && userId === process.env.DEVELOPER_USER_ID) {
        return DatabaseManager.STAFF_LEVELS.DEVELOPER;
    }

    const guildId = process.env.STAFF_GUILD_ID;
    if (!guildId) throw new Error('STAFF_GUILD_ID is required to resolve configured Discord staff roles.');

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    let member;
    try {
        member = await guild.members.fetch({ user: userId, force: true });
    } catch (err) {
        if (Number(err.code) === 10007) return DatabaseManager.STAFF_LEVELS.MEMBER;
        throw err;
    }

    return ROLE_LEVELS.reduce((highest, role) => {
        const roleId = process.env[role.environmentVariable];
        return roleId && member.roles.cache.has(roleId) ? Math.max(highest, role.level) : highest;
    }, DatabaseManager.STAFF_LEVELS.MEMBER);
}

module.exports = { resolveStaffLevel };

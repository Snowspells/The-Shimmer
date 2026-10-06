const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const DatabaseManager = require("../../utils/Database");

module.exports = new ApplicationCommand({
    command: {
        name: 'staffrole',
        description: 'Manage staff role assignments for web dashboard access',
        type: 1,
        options: [{
            name: 'assign',
            description: 'Assign a Discord role to a staff access level',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'role',
                description: 'The Discord role to assign',
                type: ApplicationCommandOptionType.Role,
                required: true
            }, {
                name: 'level',
                description: 'The staff access level',
                type: ApplicationCommandOptionType.Integer,
                required: true,
                choices: [
                    { name: 'Support (view-only)', value: 1 },
                    { name: 'Moderator (edit users)', value: 2 },
                    { name: 'Administrator (full access)', value: 3 }
                ]
            }]
        }, {
            name: 'remove',
            description: 'Remove a Discord role from staff access',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'role',
                description: 'The Discord role to remove',
                type: ApplicationCommandOptionType.Role,
                required: true
            }]
        }, {
            name: 'list',
            description: 'List all configured staff roles',
            type: ApplicationCommandOptionType.Subcommand
        }]
    },
    options: {
        cooldown: 3000,
        botDevelopers: true
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { info, error } = require('../../utils/Console');
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'assign') {
                const role = interaction.options.getRole('role', true);
                const level = interaction.options.getInteger('level', true);
                const label = DatabaseManager.STAFF_LABELS[level];

                client.database.setStaffRole(role.id, interaction.guild.id, level);
                info(`Staff role assigned: ${role.name} (${role.id}) -> ${label} by ${interaction.user.username}`);

                await interaction.reply({
                    content: `Role **${role.name}** has been assigned as **${label}** (level ${level}).`,
                    flags: MessageFlags.Ephemeral
                });

            } else if (subcommand === 'remove') {
                const role = interaction.options.getRole('role', true);
                const existing = client.database.getStaffRole(role.id);

                if (!existing) {
                    await interaction.reply({
                        content: `Role **${role.name}** is not configured as a staff role.`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                client.database.removeStaffRole(role.id);
                info(`Staff role removed: ${role.name} (${role.id}) by ${interaction.user.username}`);

                await interaction.reply({
                    content: `Role **${role.name}** has been removed from staff access.`,
                    flags: MessageFlags.Ephemeral
                });

            } else if (subcommand === 'list') {
                const staffRoles = client.database.getAllStaffRoles(interaction.guild.id);

                if (staffRoles.length === 0) {
                    await interaction.reply({
                        content: 'No staff roles are configured for this server.\nUse `/staffrole assign` to set up role-based access.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const lines = staffRoles.map(r => {
                    const guildRole = interaction.guild.roles.cache.get(r.role_id);
                    const roleName = guildRole ? guildRole.name : `Unknown (${r.role_id})`;
                    return `- **${roleName}** -> ${r.label} (level ${r.level})`;
                });

                await interaction.reply({
                    content: `**Staff Roles:**\n${lines.join('\n')}`,
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (err) {
            error('Staff role command error:', err);
            try {
                await interaction.reply({
                    content: 'An error occurred while managing staff roles.',
                    flags: MessageFlags.Ephemeral
                });
            } catch {}
        }
    }
}).toJSON();

const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const DatabaseManager = require("../../utils/Database");

module.exports = new ApplicationCommand({
    command: {
        name: 'announce',
        description: 'Broadcast a server-wide announcement in Path of Titans (via RCON)',
        type: 1,
        options: [{
            name: 'message',
            description: 'The announcement to broadcast in-game',
            type: ApplicationCommandOptionType.String,
            required: true
        }, {
            name: 'server',
            description: 'Which server to announce on (defaults to all servers)',
            type: ApplicationCommandOptionType.String,
            required: false
        }]
    },
    options: {
        cooldown: 3000,
        requiredStaffLevel: DatabaseManager.STAFF_LEVELS.STAFF
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { info, error } = require('../../utils/Console');

        if (!client.rcon?.isEnabled()) {
            await interaction.reply({
                content: 'RCON is not configured. Set `RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD` to enable Path of Titans server commands.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const message = interaction.options.getString('message', true);
        const server = interaction.options.getString('server') || null;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            await client.rcon.announce(message, server);
            info(`RCON announce by ${interaction.user.username}: ${message}`);
            await interaction.editReply({ content: `Announcement sent${server ? ` to ${server}` : ''}: \`${message}\`` });
        } catch (err) {
            error('RCON announce command error:', err);
            await interaction.editReply({ content: `Failed to send announcement: ${err.message}` });
        }
    }
}).toJSON();

const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const DatabaseManager = require("../../utils/Database");

module.exports = new ApplicationCommand({
    command: {
        name: 'players',
        description: 'List players currently online on the Path of Titans server (via RCON)',
        type: 1,
        options: [{
            name: 'server',
            description: 'Which server to query (defaults to the primary server)',
            type: ApplicationCommandOptionType.String,
            required: false
        }]
    },
    options: {
        cooldown: 5000,
        requiredStaffLevel: DatabaseManager.STAFF_LEVELS.STAFF
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { error } = require('../../utils/Console');

        if (!client.rcon?.isEnabled()) {
            await interaction.reply({
                content: 'RCON is not configured. Set `RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD` to enable Path of Titans server commands.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const server = interaction.options.getString('server') || null;

        try {
            const response = await client.rcon.getPlayers(server);
            const text = (response && response.trim().length > 0)
                ? response.trim()
                : 'No players online (empty response).';

            await interaction.editReply({
                content: `**Players online${server ? ` on ${server}` : ''}:**\n\`\`\`\n${text.slice(0, 1800)}\n\`\`\``
            });
        } catch (err) {
            error('RCON players command error:', err);
            await interaction.editReply({
                content: `Failed to query the server: ${err.message}`
            });
        }
    }
}).toJSON();

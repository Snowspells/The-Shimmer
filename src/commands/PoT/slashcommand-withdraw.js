const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const { withdraw } = require("../../utils/marksBank");

module.exports = new ApplicationCommand({
    command: {
        name: 'withdraw',
        description: "Withdraw Marks from your inventory into the game (onto your linked character)",
        type: 1,
        options: [{
            name: 'amount',
            description: 'How many Marks to withdraw',
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1
        }, {
            name: 'server',
            description: 'Which server to withdraw on (defaults to the primary server)',
            type: ApplicationCommandOptionType.String,
            required: false
        }]
    },
    options: {
        cooldown: 5000
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { error } = require('../../utils/Console');

        if (!client.rcon?.isEnabled()) {
            await interaction.reply({
                content: 'RCON is not configured, so Marks cannot be sent into the game. Set `RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD`.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const amount = interaction.options.getInteger('amount', true);
        const server = interaction.options.getString('server') || null;

        try {
            const result = await withdraw({ client, discordId: interaction.user.id, amount, serverName: server });

            if (result.ok) {
                await interaction.editReply({
                    content: `Withdrew **${result.amount}** Marks to your character (\`${result.agid}\`).\nInventory balance: **${result.balance}** Marks.`
                });
                return;
            }

            const messages = {
                bad_amount: 'Amount must be a positive whole number.',
                not_linked: 'You are not linked yet. Use `/link` to connect your AGID first.',
                rcon_disabled: 'RCON is not configured, so Marks cannot be sent into the game.',
                insufficient_bank: `You only have **${result.balance ?? 0}** Marks in your inventory.`,
                ingame_failed: `The game rejected the transfer (are you online in-game?). Server said: \`${(result.response || '').toString().slice(0, 200) || 'no response'}\`. Your inventory balance was not changed.`,
                rcon_error: `Could not reach the game server: ${result.error || 'unknown error'}. Your inventory balance was not changed.`,
                db_error: 'A database error occurred. No Marks were moved.'
            };
            await interaction.editReply({ content: messages[result.code] || 'Withdraw failed.' });
        } catch (err) {
            error('Withdraw command error:', err);
            await interaction.editReply({ content: `Withdraw failed: ${err.message}` });
        }
    }
}).toJSON();

const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const { deposit } = require("../../utils/marksBank");

module.exports = new ApplicationCommand({
    command: {
        name: 'deposit',
        description: "Deposit Marks from your character in-game into your inventory",
        type: 1,
        options: [{
            name: 'amount',
            description: 'How many Marks to deposit',
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1
        }, {
            name: 'server',
            description: 'Which server to deposit from (defaults to the primary server)',
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
                content: 'RCON is not configured, so Marks cannot be taken from the game. Set `RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD`.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const amount = interaction.options.getInteger('amount', true);
        const server = interaction.options.getString('server') || null;

        try {
            const result = await deposit({ client, discordId: interaction.user.id, amount, serverName: server });

            if (result.ok) {
                await interaction.editReply({
                    content: `Deposited **${result.amount}** Marks from your character (\`${result.agid}\`).\nInventory balance: **${result.balance}** Marks.`
                });
                return;
            }

            const messages = {
                bad_amount: 'Amount must be a positive whole number.',
                not_linked: 'You are not linked yet. Use `/link` to connect your AGID first.',
                rcon_disabled: 'RCON is not configured, so Marks cannot be taken from the game.',
                ingame_failed: `Couldn't take that many Marks from your character (do you have enough, and are you online in-game?). Server said: \`${(result.response || '').toString().slice(0, 200) || 'no response'}\`. Nothing was deposited.`,
                rcon_error: `Could not reach the game server: ${result.error || 'unknown error'}. Nothing was deposited.`,
                db_error: 'A database error occurred; the Marks were returned to your character.'
            };
            await interaction.editReply({ content: messages[result.code] || 'Deposit failed.' });
        } catch (err) {
            error('Deposit command error:', err);
            await interaction.editReply({ content: `Deposit failed: ${err.message}` });
        }
    }
}).toJSON();

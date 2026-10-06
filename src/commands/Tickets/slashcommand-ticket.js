const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require('discord.js');
const ApplicationCommand = require('../../structure/ApplicationCommand');
const { error } = require('../../utils/Console');

module.exports = new ApplicationCommand({
    command: {
        name: 'ticket',
        description: 'Open a private support conversation',
        type: 1,
        options: [{
            name: 'create',
            description: 'Create a support ticket in your DMs',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'subject',
                description: 'Brief description of your issue',
                type: ApplicationCommandOptionType.String,
                required: false
            }]
        }]
    },
    options: {
        cooldown: 3000
    },
    /**
     * @param {import('../../client/DiscordBot')} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        if (!interaction.guildId) {
            await interaction.reply({
                content: 'Create a ticket from the server ticket panel or the Live Communication page.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const subject = interaction.options.getString('subject') || 'Support request';
        try {
            const ticket = await client.ticketManager.createDmTicket(
                interaction.user,
                interaction.guildId,
                subject
            );
            await interaction.reply({
                content: `Ticket #${ticket.id} created. Continue in your DMs or on the Live Communication page.`,
                flags: MessageFlags.Ephemeral
            });
        } catch (err) {
            if (err.code === 'OPEN_TICKET_EXISTS') {
                await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
                return;
            }
            error(`Could not create DM ticket for ${interaction.user.id}:`, err);
            await interaction.reply({
                content: 'Could not open a DM ticket. Please enable direct messages from this server and try again.',
                flags: MessageFlags.Ephemeral
            });
        }
    }
}).toJSON();

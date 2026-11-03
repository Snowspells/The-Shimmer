const { ButtonInteraction, MessageFlags } = require('discord.js');
const Component = require('../../structure/Component');
const { error } = require('../../utils/Console');

module.exports = new Component({
    customId: 'ticket-panel-create',
    type: 'button',
    /**
     * @param {import('../../client/DiscordBot')} client
     * @param {ButtonInteraction} interaction
     */
    run: async (client, interaction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const ticket = await client.ticketManager.createDmTicket(
                interaction.user,
                interaction.guildId
            );
            await interaction.editReply({
                content: `Ticket #${ticket.id} created. Continue the conversation in your DMs, or use the Live Communication page on the website.`
            });
        } catch (err) {
            error('DM ticket panel create error:', err);
            const message = err.code === 'OPEN_TICKET_EXISTS'
                ? err.message
                : 'Could not open a DM ticket. Please enable direct messages from this server and try again.';
            await interaction.editReply({ content: message });
        }
    }
}).toJSON();

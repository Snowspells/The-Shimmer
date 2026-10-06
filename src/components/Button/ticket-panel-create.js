const { ButtonInteraction, MessageFlags, EmbedBuilder } = require('discord.js');
const Component = require('../../structure/Component');
const { info, error } = require('../../utils/Console');

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

            const settings = client.database.getTicketSettings(interaction.guildId);
            if (settings?.log_channel_id) {
                const logChannel = await client.channels.fetch(settings.log_channel_id).catch(err => {
                    error(`Could not fetch ticket log channel ${settings.log_channel_id}:`, err);
                    return null;
                });
                if (logChannel?.isTextBased()) {
                    await logChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0x57f287)
                            .setTitle('DM Ticket Created')
                            .addFields(
                                { name: 'Ticket', value: `#${ticket.id}`, inline: true },
                                { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true }
                            )
                            .setTimestamp()
                        ]
                    });
                }
            }
        } catch (err) {
            error('DM ticket panel create error:', err);
            const message = err.code === 'OPEN_TICKET_EXISTS'
                ? err.message
                : 'Could not open a DM ticket. Please enable direct messages from this server and try again.';
            await interaction.editReply({ content: message });
        }
    }
}).toJSON();

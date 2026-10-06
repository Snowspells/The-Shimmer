const { EmbedBuilder, MessageFlags } = require("discord.js");
const { info, warn, error } = require("../../utils/Console");

module.exports = {
    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {import("discord.js").ButtonInteraction} interaction
     */
    run: async (client, interaction) => {
        try {
            const ticket = client.database.getTicketByChannelId(interaction.channel.id);

            if (!ticket) {
                await interaction.reply({
                    content: 'This ticket has already been closed or could not be found.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            if (ticket.ticket_mode !== 'dm') {
                await interaction.reply({
                    content: 'Channel-based tickets are preserved as read-only history.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xed4245)
                    .setTitle('Ticket Closing')
                    .setDescription(`This ticket is being closed by <@${interaction.user.id}>.\n\nGenerating transcript and closing in 5 seconds...`)
                    .setTimestamp()
                ]
            });

            const transcript = await generateTranscript(interaction.channel, ticket);
            client.database.saveTranscript(ticket.id, ticket.guild_id, transcript.html, transcript.messageCount);
            client.database.closeTicket(ticket.id, interaction.user.id, interaction.user.username);

            // Log the event
            const settings = client.database.getTicketSettings(interaction.guild.id);
            if (settings?.log_channel_id) {
                const logChannel = client.channels.cache.get(settings.log_channel_id);
                if (logChannel) {
                    await logChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0xed4245)
                            .setTitle('Ticket Closed')
                            .addFields(
                                { name: 'Ticket', value: `#${ticket.id}`, inline: true },
                                { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Originally By', value: `<@${ticket.creator_id}>`, inline: true },
                                { name: 'Messages', value: `${transcript.messageCount}`, inline: true }
                            )
                            .setTimestamp()
                        ]
                    });
                }
            }

            info(`Ticket #${ticket.id} closed via button by ${interaction.user.username}`);

            setTimeout(async () => {
                try {
                    await interaction.channel.delete();
                } catch (err) {
                    warn(`Could not delete ticket channel: ${err.message}`);
                }
            }, 5000);
        } catch (err) {
            error('Ticket close button error:', err);
            try {
                await interaction.reply({
                    content: 'An error occurred while closing the ticket.',
                    flags: MessageFlags.Ephemeral
                });
            } catch {}
        }
    }
};

async function generateTranscript(channel, ticket) {
    const messages = [];
    let lastId = null;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const fetched = await channel.messages.fetch(options);
        if (fetched.size === 0) break;

        messages.push(...fetched.values());
        lastId = fetched.last().id;

        if (fetched.size < 100) break;
    }

    messages.reverse();

    const messageRows = messages.map(msg => {
        const time = new Date(msg.createdTimestamp).toISOString();
        const authorColor = msg.author.bot ? '#5865f2' : '#ffffff';
        const attachments = msg.attachments.size > 0
            ? `<div class="attachments">${msg.attachments.map(a => `<a href="${a.url}" target="_blank">${a.name}</a>`).join(', ')}</div>`
            : '';
        const embeds = msg.embeds.length > 0
            ? `<div class="embed-indicator">[${msg.embeds.length} embed(s)]</div>`
            : '';

        const escapedContent = msg.content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');

        return `
            <div class="message">
                <div class="message-header">
                    <span class="author" style="color: ${authorColor}">${msg.author.username}</span>
                    <span class="timestamp">${time}</span>
                </div>
                <div class="message-body">${escapedContent}</div>
                ${attachments}
                ${embeds}
            </div>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transcript — Ticket #${ticket.id}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #36393f; color: #dcddde; font-family: 'Segoe UI', 'Helvetica Neue', sans-serif; font-size: 15px; }
        .header { background: #2f3136; padding: 1.5rem 2rem; border-bottom: 1px solid #202225; }
        .header h1 { color: #fff; font-size: 1.3rem; margin-bottom: 0.5rem; }
        .header .meta { color: #72767d; font-size: 0.85rem; }
        .header .meta span { margin-right: 1.5rem; }
        .messages { padding: 1rem 2rem; }
        .message { padding: 0.5rem 0; display: flex; flex-direction: column; }
        .message:hover { background: #32353b; }
        .message-header { display: flex; align-items: baseline; gap: 0.5rem; }
        .author { font-weight: 600; font-size: 0.95rem; }
        .timestamp { color: #72767d; font-size: 0.75rem; }
        .message-body { margin-top: 0.2rem; line-height: 1.4; word-wrap: break-word; }
        .attachments { margin-top: 0.3rem; }
        .attachments a { color: #00aff4; text-decoration: none; }
        .attachments a:hover { text-decoration: underline; }
        .embed-indicator { color: #72767d; font-size: 0.8rem; font-style: italic; margin-top: 0.2rem; }
        .footer { background: #2f3136; padding: 1rem 2rem; border-top: 1px solid #202225; color: #72767d; font-size: 0.8rem; text-align: center; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ticket #${ticket.id} — ${ticket.subject || 'No subject'}</h1>
        <div class="meta">
            <span>Created by: ${ticket.creator_name}</span>
            <span>Channel: #${channel.name}</span>
            <span>Messages: ${messages.length}</span>
        </div>
    </div>
    <div class="messages">
        ${messageRows}
    </div>
    <div class="footer">
        Generated by The Shimmer — ${new Date().toISOString()}
    </div>
</body>
</html>`;

    return { html, messageCount: messages.length };
}

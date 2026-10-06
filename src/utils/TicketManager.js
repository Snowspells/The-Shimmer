const { ChannelType } = require('discord.js');
const { error, info, warn } = require('./Console');

class TicketManager {
    constructor(client) {
        this.client = client;
    }

    registerEvents() {
        this.client.on('messageCreate', message => {
            this.handleDirectMessage(message).catch(err => {
                error(`Failed to process ticket DM from ${message.author.id}:`, err);
            });
        });
    }

    async createDmTicket(user, guildId, subject = 'Support request') {
        const displayName = user.globalName || user.username;
        const existingTicket = this.client.database.getOpenDmTicketByUser(user.id);
        if (existingTicket) {
            const err = new Error(`You already have open ticket #${existingTicket.id}. Please continue that conversation or close it first.`);
            err.code = 'OPEN_TICKET_EXISTS';
            throw err;
        }

        const ticketId = this.client.database.createDmTicket(guildId, user.id, displayName, subject);
        if (!ticketId) {
            const concurrentTicket = this.client.database.getOpenDmTicketByUser(user.id);
            if (concurrentTicket) {
                const err = new Error(`You already have open ticket #${concurrentTicket.id}. Please continue that conversation or close it first.`);
                err.code = 'OPEN_TICKET_EXISTS';
                throw err;
            }
            throw new Error('Could not save the new support ticket.');
        }

        try {
            const settings = this.client.database.getTicketSettings(guildId);
            const welcomeMessage = settings?.welcome_message ||
                'Your support ticket is open. Reply to this DM to continue the conversation. Staff can also respond through the Live Communication page.';
            const dmChannel = await user.createDM();
            const initialMessage = await dmChannel.send({
                content: `Ticket #${ticketId} is open: **${subject}**\n\n${welcomeMessage}`,
                allowedMentions: { parse: [] }
            });
            const saved = this.client.database.addTicketMessage(
                ticketId,
                this.client.user.id,
                this.client.user.username,
                'system',
                initialMessage.content,
                initialMessage.id
            );
            if (!saved) throw new Error('Could not save the ticket welcome message.');
            info(`DM ticket #${ticketId} created for ${displayName} (${user.id}).`);
            const ticket = this.client.database.getTicket(ticketId);
            if (!ticket) throw new Error('Could not reload the newly-created support ticket.');
            return ticket;
        } catch (err) {
            this.client.database.deleteDmTicket(ticketId);
            throw err;
        }
    }

    async handleDirectMessage(message) {
        if (message.author.bot || message.channel.type !== ChannelType.DM) return;

        const ticket = this.client.database.getOpenDmTicketByUser(message.author.id);
        if (!ticket) {
            await message.reply({
                content: 'You do not have an open ticket. Start one from the ticket panel or the Live Communication page.',
                allowedMentions: { parse: [] }
            });
            return;
        }

        const attachments = [...message.attachments.values()]
            .map(attachment => `Attachment: ${attachment.name || 'file'} (${attachment.url})`);
        const content = [message.content.trim(), ...attachments].filter(Boolean).join('\n\n');
        if (!content) return;
        const saved = this.client.database.addTicketMessage(
            ticket.id,
            message.author.id,
            message.author.globalName || message.author.username,
            'user',
            content,
            message.id
        );
        if (!saved) {
            await message.reply('Your message could not be saved to the ticket. Please try again.');
            return;
        }
        info(`Received a DM for ticket #${ticket.id} from ${message.author.username}.`);
    }
}

module.exports = TicketManager;

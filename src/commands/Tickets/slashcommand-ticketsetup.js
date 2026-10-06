const { ChatInputCommandInteraction, ApplicationCommandOptionType, ChannelType, MessageFlags, EmbedBuilder } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const { info, error } = require("../../utils/Console");

module.exports = new ApplicationCommand({
    command: {
        name: 'ticketsetup',
        description: 'Configure the ticket system for this server',
        type: 1,
        options: [{
            name: 'category',
            description: 'Set the category where ticket channels are created',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'channel',
                description: 'The category channel',
                type: ApplicationCommandOptionType.Channel,
                channel_types: [ChannelType.GuildCategory],
                required: true
            }]
        }, {
            name: 'log-channel',
            description: 'Set the channel where ticket events are logged',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'channel',
                description: 'The log channel',
                type: ApplicationCommandOptionType.Channel,
                channel_types: [ChannelType.GuildText],
                required: true
            }]
        }, {
            name: 'support-role',
            description: 'Set the role that can see and respond to tickets',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'role',
                description: 'The support role',
                type: ApplicationCommandOptionType.Role,
                required: true
            }]
        }, {
            name: 'welcome-message',
            description: 'Set the message shown when a ticket is created',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'message',
                description: 'The welcome message',
                type: ApplicationCommandOptionType.String,
                required: true
            }]
        }, {
            name: 'panel',
            description: 'Send a ticket creation panel (embed with button) to a channel',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{
                name: 'channel',
                description: 'The channel to send the panel to',
                type: ApplicationCommandOptionType.Channel,
                channel_types: [ChannelType.GuildText],
                required: true
            }, {
                name: 'title',
                description: 'Panel title',
                type: ApplicationCommandOptionType.String,
                required: false
            }, {
                name: 'description',
                description: 'Panel description',
                type: ApplicationCommandOptionType.String,
                required: false
            }]
        }, {
            name: 'view',
            description: 'View current ticket system configuration',
            type: ApplicationCommandOptionType.Subcommand
        }]
    },
    options: {
        cooldown: 5000,
        botOwner: true
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'category') {
                const channel = interaction.options.getChannel('channel', true);
                client.database.setTicketSettings(interaction.guild.id, { category_id: channel.id });
                await interaction.reply({
                    content: `Ticket category set to **${channel.name}**.`,
                    flags: MessageFlags.Ephemeral
                });
                info(`Ticket category set to ${channel.name} in ${interaction.guild.name}`);

            } else if (subcommand === 'log-channel') {
                const channel = interaction.options.getChannel('channel', true);
                client.database.setTicketSettings(interaction.guild.id, { log_channel_id: channel.id });
                await interaction.reply({
                    content: `Ticket log channel set to <#${channel.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
                info(`Ticket log channel set to #${channel.name} in ${interaction.guild.name}`);

            } else if (subcommand === 'support-role') {
                const role = interaction.options.getRole('role', true);
                client.database.setTicketSettings(interaction.guild.id, { support_role_id: role.id });
                await interaction.reply({
                    content: `Ticket support role set to **${role.name}**.`,
                    flags: MessageFlags.Ephemeral
                });
                info(`Ticket support role set to ${role.name} in ${interaction.guild.name}`);

            } else if (subcommand === 'welcome-message') {
                const message = interaction.options.getString('message', true);
                client.database.setTicketSettings(interaction.guild.id, { welcome_message: message });
                await interaction.reply({
                    content: `Ticket welcome message updated.`,
                    flags: MessageFlags.Ephemeral
                });
                info(`Ticket welcome message updated in ${interaction.guild.name}`);

            } else if (subcommand === 'panel') {
                const channel = interaction.options.getChannel('channel', true);
                const title = interaction.options.getString('title') || 'Support Tickets';
                const description = interaction.options.getString('description') || 'Need help? Click the button below to create a support ticket and a staff member will assist you.';

                const embed = new EmbedBuilder()
                    .setColor(0x6e56cf)
                    .setTitle(title)
                    .setDescription(description)
                    .setFooter({ text: 'The Shimmer — Ticket System' });

                await channel.send({
                    embeds: [embed],
                    components: [{
                        type: 1,
                        components: [{
                            type: 2,
                            custom_id: 'ticket-panel-create',
                            label: 'Create Ticket',
                            style: 1,
                            emoji: { name: '🎫' }
                        }]
                    }]
                });

                await interaction.reply({
                    content: `Ticket panel sent to <#${channel.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
                info(`Ticket panel sent to #${channel.name} in ${interaction.guild.name}`);

            } else if (subcommand === 'view') {
                const settings = client.database.getTicketSettings(interaction.guild.id);
                const stats = client.database.getTicketStats(interaction.guild.id);

                const embed = new EmbedBuilder()
                    .setColor(0x6e56cf)
                    .setTitle('Ticket System Configuration')
                    .addFields(
                        { name: 'Category', value: settings?.category_id ? `<#${settings.category_id}>` : 'Not set', inline: true },
                        { name: 'Log Channel', value: settings?.log_channel_id ? `<#${settings.log_channel_id}>` : 'Not set', inline: true },
                        { name: 'Support Role', value: settings?.support_role_id ? `<@&${settings.support_role_id}>` : 'Not set', inline: true },
                        { name: 'Total Tickets', value: `${stats.total}`, inline: true },
                        { name: 'Open', value: `${stats.open}`, inline: true },
                        { name: 'Closed', value: `${stats.closed}`, inline: true },
                        { name: 'Welcome Message', value: settings?.welcome_message || 'Default' }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
        } catch (err) {
            error('Ticket setup error:', err);
            try {
                await interaction.reply({
                    content: 'An error occurred while configuring the ticket system.',
                    flags: MessageFlags.Ephemeral
                });
            } catch {}
        }
    }
}).toJSON();

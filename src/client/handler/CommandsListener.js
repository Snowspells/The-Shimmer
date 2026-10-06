const { PermissionsBitField, ChannelType, MessageFlags } = require("discord.js");
const DiscordBot = require("../DiscordBot");
const config = require("../../config");
const MessageCommand = require("../../structure/MessageCommand");
const { handleMessageCommandOptions, handleApplicationCommandOptions } = require("./CommandOptions");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const DatabaseManager = require("../../utils/Database");
const { resolveStaffLevel } = require("../../utils/StaffAccess");
const { error } = require("../../utils/Console");

class CommandsListener {
    /**
     * 
     * @param {DiscordBot} client 
     */
    constructor(client) {
        client.on('messageCreate', async (message) => {
            if (message.author.bot || message.channel.type === ChannelType.DM) return;

            if (!config.commands.message_commands) return;

            let prefix = config.commands.prefix;

            const guildPrefix = client.database.getGuildPrefix(message.guild.id);
            if (guildPrefix) {
                prefix = guildPrefix;
            }

            if (!message.content.startsWith(prefix)) return;

            const args = message.content.slice(prefix.length).trim().split(/\s+/g);
            const commandInput = args.shift().toLowerCase();

            if (!commandInput.length) return;

            /**
             * @type {MessageCommand['data']}
             */
            const command =
                client.collection.message_commands.get(commandInput) ||
                client.collection.message_commands.get(client.collection.message_commands_aliases.get(commandInput));

            if (!command) return;

            try {
                if (command.options) {
                    const commandContinue = await handleMessageCommandOptions(client, message, command.options, command.command);

                    if (!commandContinue) return;
                }

                const hasCommandPermissions = !command.command?.permissions ||
                    message.member.permissions.has(PermissionsBitField.resolve(command.command.permissions));
                let developerAccess = false;
                if (!hasCommandPermissions) {
                    try {
                        developerAccess = await resolveStaffLevel(client, message.author.id) >= DatabaseManager.STAFF_LEVELS.DEVELOPER;
                    } catch (err) {
                        error(`Could not verify Developer access for ${message.author.id}:`, err);
                    }
                }
                if (!hasCommandPermissions && !developerAccess) {
                    await message.reply({
                        content: config.messages.MISSING_PERMISSIONS,
                        flags: MessageFlags.Ephemeral
                    });

                    return;
                }

                command.run(client, message, args);
            } catch (err) {
                error(err);
            }
        });

        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isCommand()) return;

            if (!config.commands.application_commands.chat_input && interaction.isChatInputCommand()) return;
            if (!config.commands.application_commands.user_context && interaction.isUserContextMenuCommand()) return;
            if (!config.commands.application_commands.message_context && interaction.isMessageContextMenuCommand()) return;

            /**
             * @type {ApplicationCommand['data']}
             */
            const command = client.collection.application_commands.get(interaction.commandName);

            if (!command) return;

            try {
                if (command.options) {
                    const commandContinue = await handleApplicationCommandOptions(client, interaction, command.options, command.command);

                    if (!commandContinue) return;
                }

                command.run(client, interaction);
            } catch (err) {
                error(err);
            }
        });
    }
}

module.exports = CommandsListener;
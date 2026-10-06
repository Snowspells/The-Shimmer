const { Message, MessageFlags } = require("discord.js");
const MessageCommand = require("../../structure/MessageCommand");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const config = require("../../config");
const DatabaseManager = require("../../utils/Database");
const { resolveStaffLevel } = require("../../utils/StaffAccess");

const application_commands_cooldown = new Map();
const message_commands_cooldown = new Map();

/**
 * 
 * @param {import("discord.js").Interaction} interaction 
 * @param {ApplicationCommand['data']['options']} options 
 * @param {ApplicationCommand['data']['command']} command 
 * @returns {boolean}
 */
const hasRequiredStaffLevel = async (client, userId, minimumLevel) => {
    try {
        return await resolveStaffLevel(client, userId) >= minimumLevel;
    } catch (err) {
        const { error } = require("../../utils/Console");
        error(`Could not verify configured staff role for ${userId}:`, err);
        return false;
    }
};

const handleApplicationCommandOptions = async (client, interaction, options, command) => {
    const minimumStaffLevel = options.requiredStaffLevel ||
        (options.botDevelopers ? DatabaseManager.STAFF_LEVELS.DEVELOPER
            : options.botOwner ? DatabaseManager.STAFF_LEVELS.OWNER : null);
    if (minimumStaffLevel !== null &&
        !(await hasRequiredStaffLevel(client, interaction.user.id, minimumStaffLevel))) {
        const isDeveloperGate = minimumStaffLevel >= DatabaseManager.STAFF_LEVELS.DEVELOPER;
        await interaction.reply({
            content: isDeveloperGate ? config.messages.NOT_BOT_DEVELOPER : config.messages.NOT_BOT_OWNER,
            flags: MessageFlags.Ephemeral
        });
        return false;
    }

    if (options.guildOwner) {
        const isDeveloper = await hasRequiredStaffLevel(
            client,
            interaction.user.id,
            DatabaseManager.STAFF_LEVELS.DEVELOPER
        );
        if (interaction.user.id !== interaction.guild.ownerId && !isDeveloper) {
            await interaction.reply({
                content: config.messages.NOT_GUILD_OWNER,
                flags: MessageFlags.Ephemeral
            });

            return false;
        }
    }

    if (options.cooldown) {
        const cooldownFunction = () => {
            let data = application_commands_cooldown.get(interaction.user.id);

            data.push(interaction.commandName);

            application_commands_cooldown.set(interaction.user.id, data);

            setTimeout(() => {
                let data = application_commands_cooldown.get(interaction.user.id);

                data = data.filter((v) => v !== interaction.commandName);

                if (data.length <= 0) {
                    application_commands_cooldown.delete(interaction.user.id);
                } else {
                    application_commands_cooldown.set(interaction.user.id, data);
                }
            }, options.cooldown);
        }

        if (application_commands_cooldown.has(interaction.user.id)) {
            let data = application_commands_cooldown.get(interaction.user.id);

            if (data.some((cmd) => cmd === interaction.commandName)) {
                await interaction.reply({
                    content: config.messages.GUILD_COOLDOWN.replace(/%cooldown%/g, options.cooldown / 1000),
                    flags: MessageFlags.Ephemeral
                });

                return false;
            } else {
                cooldownFunction();
            }
        } else {
            application_commands_cooldown.set(interaction.user.id, [interaction.commandName]);
            cooldownFunction();
        }
    }

    return true;
}

/**
 * 
 * @param {Message} message 
 * @param {MessageCommand['data']['options']} options 
 * @param {MessageCommand['data']['command']} command 
 * @returns {boolean}
 */
const handleMessageCommandOptions = async (client, message, options, command) => {
    const minimumStaffLevel = options.requiredStaffLevel ||
        (options.botDevelopers ? DatabaseManager.STAFF_LEVELS.DEVELOPER
            : options.botOwner ? DatabaseManager.STAFF_LEVELS.OWNER : null);
    if (minimumStaffLevel !== null &&
        !(await hasRequiredStaffLevel(client, message.author.id, minimumStaffLevel))) {
        await message.reply({
            content: minimumStaffLevel >= DatabaseManager.STAFF_LEVELS.DEVELOPER
                ? config.messages.NOT_BOT_DEVELOPER
                : config.messages.NOT_BOT_OWNER
        });
        return false;
    }

    if (options.guildOwner) {
        const isDeveloper = await hasRequiredStaffLevel(
            client,
            message.author.id,
            DatabaseManager.STAFF_LEVELS.DEVELOPER
        );
        if (message.author.id !== message.guild.ownerId && !isDeveloper) {
            await message.reply({
                content: config.messages.NOT_GUILD_OWNER
            });

            return false;
        }
    }

    if (options.nsfw) {
        if (!message.channel.nsfw) {
            await message.reply({
                content: config.messages.CHANNEL_NOT_NSFW
            });

            return false;
        }
    }

    if (options.cooldown) {
        const cooldownFunction = () => {
            let data = message_commands_cooldown.get(message.author.id);

            data.push(command.name);

            message_commands_cooldown.set(message.author.id, data);

            setTimeout(() => {
                let data = message_commands_cooldown.get(message.author.id);

                data = data.filter((cmd) => cmd !== command.name);

                if (data.length <= 0) {
                    message_commands_cooldown.delete(message.author.id);
                } else {
                    message_commands_cooldown.set(message.author.id, data);
                }
            }, options.cooldown);
        }

        if (message_commands_cooldown.has(message.author.id)) {
            let data = message_commands_cooldown.get(message.author.id);

            if (data.some((v) => v === command.name)) {
                await message.reply({
                    content: config.messages.GUILD_COOLDOWN.replace(/%cooldown%/g, options.cooldown / 1000)
                });

                return false;
            } else {
                cooldownFunction();
            }
        } else {
            message_commands_cooldown.set(message.author.id, [command.name]);
            cooldownFunction();
        }
    }

    return true;
}

module.exports = { handleApplicationCommandOptions, handleMessageCommandOptions }
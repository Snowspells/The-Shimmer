const { ChatInputCommandInteraction, AttachmentBuilder } = require("discord.js");
const DiscordBot = require("../../client/DiscordBot");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const config = require("../../config");
const DatabaseManager = require("../../utils/Database");

module.exports = new ApplicationCommand({
    command: {
        name: 'reload',
        description: 'Reload every command.',
        type: 1,
        options: []
    },
    options: {
        requiredStaffLevel: DatabaseManager.STAFF_LEVELS.OWNER
    },
    /**
     * 
     * @param {DiscordBot} client 
     * @param {ChatInputCommandInteraction} interaction 
     */
    run: async (client, interaction) => {
        await interaction.deferReply();

        try {
            client.commands_handler.reload();

            await client.commands_handler.registerApplicationCommands(config.development);

            await interaction.editReply({
                content: 'Successfully reloaded application commands and message commands.'
            });
        } catch (err) {
            await interaction.editReply({
                content: 'Something went wrong.',
                files: [
                    new AttachmentBuilder(Buffer.from(`${err}`, 'utf-8'), { name: 'output.ts' })
                ]
            });
        };
    }
}).toJSON();
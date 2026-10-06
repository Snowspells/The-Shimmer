const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const { normalizeAgid, isValidAgid } = require("../../utils/pot");
const DatabaseManager = require("../../utils/Database");
const { executeModerationAction } = require("../../utils/ModerationAudit");

const agidOption = {
    name: 'agid',
    description: "The player's Alderon Games ID (AGID)",
    type: ApplicationCommandOptionType.String,
    required: true
};
const serverOption = {
    name: 'server',
    description: 'Which server to target (defaults to the primary server)',
    type: ApplicationCommandOptionType.String,
    required: false
};

module.exports = new ApplicationCommand({
    command: {
        name: 'server',
        description: 'Path of Titans server administration via RCON',
        type: 1,
        options: [
            {
                name: 'status',
                description: 'Show configured RCON servers and their connection state',
                type: ApplicationCommandOptionType.Subcommand
            },
            {
                name: 'kick',
                description: 'Kick a player from the server',
                type: ApplicationCommandOptionType.Subcommand,
                options: [agidOption, {
                    name: 'reason',
                    description: 'Reason for the kick',
                    type: ApplicationCommandOptionType.String,
                    max_length: 200,
                    required: true
                }, {
                    name: 'evidence_url',
                    description: 'HTTP(S) URL with evidence for the kick',
                    type: ApplicationCommandOptionType.String,
                    required: true
                }, serverOption]
            },
            {
                name: 'ban',
                description: 'Ban a player from the server',
                type: ApplicationCommandOptionType.Subcommand,
                options: [agidOption, {
                    name: 'reason',
                    description: 'Reason for the ban',
                    type: ApplicationCommandOptionType.String,
                    max_length: 200,
                    required: true
                }, {
                    name: 'evidence_url',
                    description: 'HTTP(S) URL with evidence for the ban',
                    type: ApplicationCommandOptionType.String,
                    required: true
                }, {
                    name: 'hours',
                    description: 'Ban duration in hours (0 = permanent)',
                    type: ApplicationCommandOptionType.Integer,
                    required: false
                }, serverOption]
            },
            {
                name: 'heal',
                description: 'Heal a specific player',
                type: ApplicationCommandOptionType.Subcommand,
                options: [agidOption, serverOption]
            },
            {
                name: 'healall',
                description: 'Heal all players on the server',
                type: ApplicationCommandOptionType.Subcommand,
                options: [serverOption]
            },
            {
                name: 'whisper',
                description: 'Send a private message to a player',
                type: ApplicationCommandOptionType.Subcommand,
                options: [agidOption, {
                    name: 'message',
                    description: 'The message to whisper',
                    type: ApplicationCommandOptionType.String,
                    required: true
                }, serverOption]
            },
            {
                name: 'teleport',
                description: 'Teleport a player to coordinates',
                type: ApplicationCommandOptionType.Subcommand,
                options: [agidOption,
                    { name: 'x', description: 'X coordinate', type: ApplicationCommandOptionType.Number, required: true },
                    { name: 'y', description: 'Y coordinate', type: ApplicationCommandOptionType.Number, required: true },
                    { name: 'z', description: 'Z coordinate', type: ApplicationCommandOptionType.Number, required: true },
                    serverOption
                ]
            }
        ]
    },
    options: {
        cooldown: 3000,
        requiredStaffLevel: DatabaseManager.STAFF_LEVELS.STAFF
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { info, error } = require('../../utils/Console');
        const sub = interaction.options.getSubcommand();

        if (!client.rcon?.isEnabled()) {
            await interaction.reply({
                content: 'RCON is not configured. Set `RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD` to enable Path of Titans server commands.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === 'status') {
            const status = client.rcon.status();
            const lines = status.map(s =>
                `- **${s.name}** (${s.host}:${s.port}) — ${s.connected ? '🟢 connected' : '🔴 disconnected'}`
            );
            await interaction.reply({
                content: `**RCON Servers:**\n${lines.join('\n')}`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const server = interaction.options.getString('server') || null;

        // Validate AGID for subcommands that need it.
        let agid = null;
        if (['kick', 'ban', 'heal', 'whisper', 'teleport'].includes(sub)) {
            agid = normalizeAgid(interaction.options.getString('agid', true));
            if (!isValidAgid(agid)) {
                await interaction.editReply({ content: `\`${agid}\` does not look like a valid AGID (expected a format like \`123-456-789\`).` });
                return;
            }
        }

        try {
            let response;
            let summary;
            let auditWarning = null;

            switch (sub) {
                case 'kick': {
                    const reason = interaction.options.getString('reason', true);
                    const evidenceUrl = interaction.options.getString('evidence_url', true);
                    const action = await executeModerationAction(client, {
                        action: 'In-game kick',
                        target: `AGID ${agid}`,
                        actorName: interaction.user.globalName || interaction.user.username,
                        actorId: interaction.user.id,
                        reason,
                        maxReasonLength: 200,
                        evidenceUrl,
                        context: `Server: ${server || 'Primary'}`
                    }, () => client.rcon.kick(agid, reason.trim(), server));
                    response = action.result;
                    auditWarning = action.auditWarning;
                    summary = `Kicked \`${agid}\`${reason ? ` (${reason})` : ''}.`;
                    break;
                }
                case 'ban': {
                    const hours = interaction.options.getInteger('hours') ?? 0;
                    const reason = interaction.options.getString('reason', true);
                    const evidenceUrl = interaction.options.getString('evidence_url', true);
                    const action = await executeModerationAction(client, {
                        action: 'In-game ban',
                        target: `AGID ${agid}`,
                        actorName: interaction.user.globalName || interaction.user.username,
                        actorId: interaction.user.id,
                        reason,
                        maxReasonLength: 200,
                        evidenceUrl,
                        context: `Duration: ${hours === 0 ? 'Permanent' : `${hours} hours`}; server: ${server || 'Primary'}`
                    }, () => client.rcon.ban(agid, hours, reason.trim(), server));
                    response = action.result;
                    auditWarning = action.auditWarning;
                    summary = `Banned \`${agid}\` for ${hours === 0 ? 'permanent' : `${hours}h`}${reason ? ` (${reason})` : ''}.`;
                    break;
                }
                case 'heal':
                    response = await client.rcon.heal(agid, server);
                    summary = `Healed \`${agid}\`.`;
                    break;
                case 'healall':
                    response = await client.rcon.healAll(server);
                    summary = 'Healed all players.';
                    break;
                case 'whisper': {
                    const message = interaction.options.getString('message', true);
                    response = await client.rcon.whisper(agid, message, server);
                    summary = `Whispered \`${agid}\`.`;
                    break;
                }
                case 'teleport': {
                    const x = interaction.options.getNumber('x', true);
                    const y = interaction.options.getNumber('y', true);
                    const z = interaction.options.getNumber('z', true);
                    response = await client.rcon.teleport(agid, x, y, z, server);
                    summary = `Teleported \`${agid}\` to (${x}, ${y}, ${z}).`;
                    break;
                }
                default:
                    await interaction.editReply({ content: 'Unknown subcommand.' });
                    return;
            }

            info(`RCON ${sub} by ${interaction.user.username}: ${summary}`);

            const responseText = typeof response === 'string' && response.trim().length > 0
                ? `\n\`\`\`\n${response.trim().slice(0, 1500)}\n\`\`\``
                : '';
            await interaction.editReply({
                content: `${summary}${responseText}${auditWarning ? `\n⚠️ ${auditWarning}` : ''}`
            });
        } catch (err) {
            error(`RCON ${sub} command error:`, err);
            await interaction.editReply({ content: `Command failed: ${err.message}` });
        }
    }
}).toJSON();

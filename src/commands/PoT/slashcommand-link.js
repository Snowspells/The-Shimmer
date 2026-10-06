const { ChatInputCommandInteraction, ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const ApplicationCommand = require("../../structure/ApplicationCommand");
const { normalizeAgid, isValidAgid, generateLinkCode } = require("../../utils/pot");

const VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

module.exports = new ApplicationCommand({
    command: {
        name: 'link',
        description: "Link your Discord account to your Path of Titans AGID",
        type: 1,
        options: [{
            name: 'agid',
            description: 'Your Alderon Games ID (AGID), e.g. 123-456-789',
            type: ApplicationCommandOptionType.String,
            required: true
        }]
    },
    options: {
        cooldown: 5000
    },

    /**
     * @param {import("../../client/DiscordBot")} client
     * @param {ChatInputCommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const { info, error } = require('../../utils/Console');
        try {
            const discordId = interaction.user.id;
            const agid = normalizeAgid(interaction.options.getString('agid', true));

            if (!isValidAgid(agid)) {
                await interaction.reply({
                    content: `\`${agid}\` does not look like a valid AGID. It should look like \`123-456-789\`. You can find it in-game under your profile.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (client.database.userExists(discordId)) {
                await interaction.reply({
                    content: 'You are already linked. Ask an administrator to overwrite your AGID with `/adminlink`.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const existingOwner = client.database.getUserByAgid(agid);
            if (existingOwner) {
                await interaction.reply({
                    content: `AGID \`${agid}\` is already linked to another Discord account. If this is a mistake, contact an administrator.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Without RCON we cannot verify ownership in-game, so link directly.
            if (!client.rcon?.isEnabled()) {
                client.database.createUser(discordId, agid, 0, []);
                info(`New user linked (unverified, no RCON): DID=${discordId} AGID=${agid}`);
                await interaction.reply({
                    content: `Linked <@${discordId}> to AGID \`${agid}\`.\n_Note: in-game verification is unavailable (RCON not configured), so this link was not verified._`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // RCON available: send a verification code in-game and require /linkverify.
            const code = generateLinkCode(6);
            const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();
            client.database.createLinkVerification(discordId, agid, code, expiresAt);

            try {
                await client.rcon.whisper(agid, `The Shimmer link code: ${code} — run /linkverify code:${code} in Discord within 10 minutes.`);
            } catch (err) {
                client.database.deleteLinkVerification(discordId);
                error('Link whisper failed:', err);
                await interaction.reply({
                    content: 'Could not deliver a verification code in-game. Make sure you are currently online on the server, then try `/link` again.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            info(`Link verification started: DID=${discordId} AGID=${agid}`);
            await interaction.reply({
                content: `A verification code has been whispered to **${agid}** in-game. Run \`/linkverify code:<code>\` within 10 minutes to finish linking.`,
                flags: MessageFlags.Ephemeral
            });
        } catch (err) {
            error(err);
            try {
                await interaction.reply({ content: 'An error occurred while linking. Try again later.', flags: MessageFlags.Ephemeral });
            } catch {}
        }
    }
}).toJSON();

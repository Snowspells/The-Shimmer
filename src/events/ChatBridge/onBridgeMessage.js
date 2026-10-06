const { warn, error, debug } = require("../../utils/Console");
const Event = require("../../structure/Event");

module.exports = new Event({
    event: 'messageCreate',
    once: false,
    run: async (client, message) => {
        if (message.author.bot) return;

        const bridgeChannelId = process.env.BRIDGE_CHANNEL_ID;
        if (!bridgeChannelId || message.channel.id !== bridgeChannelId) return;

        const displayName = message.author.globalName || message.author.username;
        const content = message.cleanContent;

        if (!content || content.length === 0) return;

        // Always log + relay to connected web clients.
        client.database.logBridgeMessage('discord', displayName, message.author.id, content);
        const aiChatChannelId = process.env.AI_CHAT_CHANNEL_ID || process.env.ALLOWED_CHANNEL_ID;
        if (client.webServer && message.channel.id !== aiChatChannelId) {
            client.webServer.relayMessageToWeb('discord', displayName, message.author.id, content);
        }

        // Relay into Path of Titans via RCON when configured.
        if (client.rcon?.isEnabled()) {
            try {
                await client.rcon.relayChat('discord', displayName, content);
                debug(`Bridge (Discord -> Game/RCON): ${displayName}: ${content}`);
            } catch (err) {
                warn(`Bridge RCON relay failed: ${err.message}`);
            }
            return;
        }

        // Fallback: legacy HTTP webhook relay (for non-RCON game integrations).
        const gameWebhookUrl = process.env.GAME_WEBHOOK_URL;
        if (!gameWebhookUrl) {
            debug('Chat bridge: no RCON server and GAME_WEBHOOK_URL not configured, skipping outbound relay');
            return;
        }

        try {
            const response = await fetch(gameWebhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': process.env.BRIDGE_API_KEY || ''
                },
                body: JSON.stringify({
                    playerName: displayName,
                    message: content,
                    discordId: message.author.id,
                    source: 'discord'
                })
            });

            if (response.ok) {
                debug(`Bridge (Discord -> Game/webhook): ${displayName}: ${content}`);
            } else {
                warn(`Bridge relay failed (${response.status}): ${displayName}: ${content}`);
            }
        } catch (err) {
            error('Bridge relay error:', err);
        }
    }
}).toJSON();

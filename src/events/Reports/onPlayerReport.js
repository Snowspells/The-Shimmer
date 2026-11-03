const { debug, warn } = require("../../utils/Console");
const Event = require("../../structure/Event");
const { extractLines } = require("../../utils/pot");

/**
 * Turns Path of Titans in-game player reports into reports for staff to judge.
 *
 * Configuration:
 *   PLAYER_REPORT_CHANNEL_ID - Discord channel that receives the server's report webhook
 *   POT_REPORT_REGEX         - optional override; named groups: reporter, reporterAgid,
 *                              target, targetAgid, reason, details (optional)
 */
const DEFAULT_REPORT_REGEX = /(?<reporter>.+?)\s*\((?<reporterAgid>[A-Za-z0-9-]+)\)\s*(?:has\s+)?reported\s+(?<target>.+?)\s*\((?<targetAgid>[A-Za-z0-9-]+)\)\s*(?:for|reason\s*[:=-])\s*(?<reason>[^:]+?)(?:\s*[:-]\s*(?<details>.+))?$/i;

function reportRegex() {
    const value = process.env.POT_REPORT_REGEX;
    if (!value) return DEFAULT_REPORT_REGEX;
    try {
        const match = value.match(/^\/(.*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(value);
    } catch {
        return DEFAULT_REPORT_REGEX;
    }
}

module.exports = new Event({
    event: 'messageCreate',
    once: false,
    run: async (client, message) => {
        const channelId = process.env.PLAYER_REPORT_CHANNEL_ID;
        if (!channelId || message.channel.id !== channelId || !message.webhookId) return;
        if (!client.infractions) return;

        const regex = reportRegex();
        for (const line of extractLines(message)) {
            const match = regex.exec(line);
            if (!match?.groups?.targetAgid) {
                debug(`Reports: unparsed report line: ${line.slice(0, 120)}`);
                continue;
            }
            const g = match.groups;
            try {
                const report = await client.infractions.createReport({
                    reporterAgid: g.reporterAgid,
                    reporterName: g.reporter,
                    targetAgid: g.targetAgid,
                    targetName: g.target,
                    optionText: g.reason,
                    details: g.details || g.reason,
                    server: client.rcon?.defaultServerName?.() || null
                });
                if (report && client.rcon?.isEnabled() && g.reporterAgid) {
                    client.rcon.whisper(g.reporterAgid.toUpperCase(), 'Your report was received and will be reviewed by staff.').catch(() => {});
                }
            } catch (err) {
                warn(`Reports: could not store report: ${err.message}`);
            }
        }
    }
}).toJSON();

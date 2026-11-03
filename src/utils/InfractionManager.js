const config = require('./EchoConfig');
const path = require('path');
const DatabaseManager = require('./Database');
const { resolveStaffLevel } = require('./StaffAccess');
const { normalizeAgid } = require('./pot');
const { info, warn, error } = require('./Console');

const INFRACTION_DIR = path.join(config.CONFIG_ROOT, 'infractions');
const DEFAULT_SETTINGS = { maxInfractions: 6, alertThreshold: 3, judgements: { Behavioral: 2, Gameplay: 1 } };
const OTHER_OPTION = 'Other';

class InfractionError extends Error {}

function getSettings() {
    const file = config.readJson(path.join(INFRACTION_DIR, 'settings.json'), {});
    const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
    const judgements = {};
    for (const [name, points] of Object.entries(file.judgements || DEFAULT_SETTINGS.judgements)) {
        if (Number.isInteger(points) && points > 0) judgements[name] = points;
    }
    return {
        maxInfractions: positive(file.maxInfractions, DEFAULT_SETTINGS.maxInfractions),
        alertThreshold: positive(file.alertThreshold, DEFAULT_SETTINGS.alertThreshold),
        judgements: Object.keys(judgements).length ? judgements : DEFAULT_SETTINGS.judgements
    };
}

function getReportOptions() {
    return config.readJsonDirectory(path.join(INFRACTION_DIR, 'report-options'))
        .filter(({ data }) => data.enabled !== false)
        .map(({ name, data }) => ({ name, description: typeof data.description === 'string' ? data.description : '' }));
}

function matchOption(text) {
    const wanted = String(text || '').trim().toLowerCase();
    const options = getReportOptions();
    return options.find(o => o.name.toLowerCase() === wanted)
        || options.find(o => wanted && (wanted.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(wanted)))
        || null;
}

class InfractionManager {
    constructor(client) {
        this.client = client;
        this.db = client.database;
    }

    // ---- Reports ------------------------------------------------------------

    /** Staff and above are outside the infraction system. Throws when roles cannot be verified. */
    async isExempt(agid) {
        const user = this.db.getUserByAgid(agid);
        if (!user) return false;
        const level = await resolveStaffLevel(this.client, user.DID);
        return level >= DatabaseManager.STAFF_LEVELS.STAFF_IN_TRAINING;
    }

    async createReport({ reporterAgid, reporterName, targetAgid, targetName, optionText, details, server }) {
        const target = normalizeAgid(targetAgid);
        const reporter = reporterAgid ? normalizeAgid(reporterAgid) : null;
        if (!target || target === reporter) return null;

        const option = matchOption(optionText);
        let status = 'pending';
        try {
            if (await this.isExempt(target)) status = 'excluded';
        } catch (err) {
            warn(`Infractions: could not verify exemption for ${target}; leaving report pending: ${err.message}`);
        }
        const result = this.db.db.prepare(`
            INSERT INTO reports (reporter_agid, reporter_name, target_agid, target_name, option_name, details, server, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            reporter, reporterName || null, target, targetName || null,
            option ? option.name : OTHER_OPTION,
            String(details || optionText || '').slice(0, 1000), server || null, status
        );
        return { id: Number(result.lastInsertRowid), status };
    }

    getPendingReports() {
        return this.db.db.prepare("SELECT * FROM reports WHERE status = 'pending' ORDER BY id").all();
    }

    getRecentJudgedReports(limit = 25) {
        return this.db.db.prepare("SELECT * FROM reports WHERE status <> 'pending' ORDER BY id DESC LIMIT ?").all(limit);
    }

    /** judgement is a configured judgement name, or 'Dismiss'. Returns the new infraction, if any. */
    async judge(reportId, judgement, actor) {
        const settings = getSettings();
        const isDismiss = judgement === 'Dismiss';
        if (!isDismiss && !Object.hasOwn(settings.judgements, judgement)) throw new InfractionError('Unknown judgement.');

        const report = this.db.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
        if (!report || report.status !== 'pending') throw new InfractionError('That report was already handled.');
        if (!isDismiss && await this.isExempt(report.target_agid)) {
            this.db.db.prepare("UPDATE reports SET status = 'excluded' WHERE id = ? AND status = 'pending'").run(reportId);
            throw new InfractionError('Staff members are excluded from the infraction system.');
        }

        let infraction = null;
        this.db.db.transaction(() => {
            const claimed = this.db.db.prepare(`
                UPDATE reports SET status = ?, judgement = ?, judged_by = ?, judged_by_name = ?, judged_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'pending'
            `).run(isDismiss ? 'dismissed' : 'judged', judgement, actor.id, actor.name, reportId);
            if (claimed.changes === 0) throw new InfractionError('That report was already handled.');
            if (isDismiss) return;
            const points = settings.judgements[judgement];
            const result = this.db.db.prepare(
                'INSERT INTO infractions (agid, report_id, type, points, issued_by) VALUES (?, ?, ?, ?, ?)'
            ).run(report.target_agid, reportId, judgement, points, actor.id);
            infraction = { id: Number(result.lastInsertRowid), type: judgement, points };
        })();

        if (infraction) {
            const total = this.activePoints(report.target_agid);
            info(`Infractions: ${report.target_agid} received ${judgement} (${total}/${settings.maxInfractions}).`);
            await this.notifyPlayer(report.target_agid,
                `You received a ${judgement} infraction (${total}/${settings.maxInfractions}). Appeal on the website if you disagree.`);
            if (total >= settings.alertThreshold) await this.alertLeadership(report, infraction, total, settings, actor);
            await this.reconcile(report.target_agid);
        }
        return infraction;
    }

    // ---- Infractions --------------------------------------------------------

    activePoints(agid) {
        return this.db.db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM infractions WHERE agid = ? AND status = 'active'")
            .get(normalizeAgid(agid)).total;
    }

    getInfractions(agid) {
        return this.db.db.prepare('SELECT * FROM infractions WHERE agid = ? ORDER BY id DESC').all(normalizeAgid(agid));
    }

    getInfraction(id) {
        return this.db.db.prepare('SELECT * FROM infractions WHERE id = ?').get(id) || null;
    }

    async removeInfraction(id, actor, reason) {
        const result = this.db.db.prepare(`
            UPDATE infractions SET status = 'removed', removed_by = ?, removed_by_name = ?, removed_at = CURRENT_TIMESTAMP, removal_reason = ?
            WHERE id = ? AND status = 'active'
        `).run(actor.id, actor.name, reason || null, id);
        if (result.changes === 0) throw new InfractionError('That infraction is not active.');
        const infraction = this.getInfraction(id);
        const total = this.activePoints(infraction.agid);
        await this.notifyPlayer(infraction.agid,
            `An infraction was removed. You now have ${total}/${getSettings().maxInfractions}.`);
        await this.reconcile(infraction.agid);
        return infraction;
    }

    // ---- Appeals ------------------------------------------------------------

    fileAppeal(did, infractionId, message) {
        const user = this.db.getUserByDiscordId(did);
        const infraction = this.getInfraction(infractionId);
        if (!user || !infraction || infraction.agid !== normalizeAgid(user.agid)) throw new InfractionError('Infraction not found.');
        if (infraction.status !== 'active') throw new InfractionError('That infraction is no longer active.');
        const text = String(message || '').trim();
        if (text.length < 10 || text.length > 1000) throw new InfractionError('Explain your appeal in 10 to 1000 characters.');
        const pending = this.db.db.prepare("SELECT id FROM infraction_appeals WHERE infraction_id = ? AND status = 'pending'").get(infractionId);
        if (pending) throw new InfractionError('This infraction already has a pending appeal.');
        const denied = this.db.db.prepare("SELECT id FROM infraction_appeals WHERE infraction_id = ? AND status = 'denied'").get(infractionId);
        if (denied) throw new InfractionError('This infraction was already appealed and denied.');
        this.db.db.prepare('INSERT INTO infraction_appeals (infraction_id, did, message) VALUES (?, ?, ?)').run(infractionId, did, text);
    }

    getAppealsFor(did) {
        return this.db.db.prepare('SELECT * FROM infraction_appeals WHERE did = ? ORDER BY id DESC').all(did);
    }

    getPendingAppeals() {
        return this.db.db.prepare(`
            SELECT a.*, i.type, i.points, i.agid, i.report_id
            FROM infraction_appeals a JOIN infractions i ON i.id = a.infraction_id
            WHERE a.status = 'pending' ORDER BY a.id
        `).all();
    }

    async decideAppeal(appealId, approve, actor, note) {
        const appeal = this.db.db.prepare('SELECT * FROM infraction_appeals WHERE id = ?').get(appealId);
        if (!appeal || appeal.status !== 'pending') throw new InfractionError('That appeal was already decided.');
        const claimed = this.db.db.prepare(`
            UPDATE infraction_appeals SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?
            WHERE id = ? AND status = 'pending'
        `).run(approve ? 'approved' : 'denied', actor.id, actor.name, note || null, appealId);
        if (claimed.changes === 0) throw new InfractionError('That appeal was already decided.');
        if (approve) {
            try {
                await this.removeInfraction(appeal.infraction_id, actor, `Appeal #${appealId} approved`);
            } catch (err) {
                if (!(err instanceof InfractionError)) throw err;
            }
        }
    }

    // ---- Ban enforcement ----------------------------------------------------

    /** Make the game-side ban match the infraction total: banned at the maximum, unbanned below it. */
    async reconcile(agid) {
        const settings = getSettings();
        const shouldBeBanned = this.activePoints(agid) >= settings.maxInfractions;
        const row = this.db.db.prepare('SELECT banned FROM infraction_bans WHERE agid = ?').get(agid);
        const isBanned = Boolean(row?.banned);
        if (shouldBeBanned === isBanned) return;
        try {
            if (shouldBeBanned) {
                await this.client.rcon.ban(agid, 0, `Reached ${settings.maxInfractions} infractions`);
            } else {
                await this.client.rcon.unban(agid);
            }
            this.db.db.prepare('INSERT INTO infraction_bans (agid, banned) VALUES (?, ?) ON CONFLICT(agid) DO UPDATE SET banned = excluded.banned')
                .run(agid, shouldBeBanned ? 1 : 0);
            info(`Infractions: ${shouldBeBanned ? 'banned' : 'unbanned'} ${agid}.`);
        } catch (err) {
            warn(`Infractions: could not ${shouldBeBanned ? 'ban' : 'unban'} ${agid}; will retry: ${err.message}`);
        }
    }

    async reconcileAll() {
        const rows = this.db.db.prepare(`
            SELECT agid FROM infractions GROUP BY agid
            UNION SELECT agid FROM infraction_bans WHERE banned = 1
        `).all();
        for (const { agid } of rows) await this.reconcile(agid);
    }

    // ---- Notifications ------------------------------------------------------

    async notifyPlayer(agid, message) {
        try {
            await this.client.rcon.whisper(agid, message);
        } catch (err) {
            warn(`Infractions: could not whisper ${agid}: ${err.message}`);
        }
    }

    /** Owner, Developer and Staff Head are told when a player reaches the alert threshold. */
    async alertLeadership(report, infraction, total, settings, actor) {
        const text = `Infraction alert: ${report.target_name || report.target_agid} (${report.target_agid}) now has ${total}/${settings.maxInfractions} infractions `
            + `after a ${infraction.type} judgement by ${actor.name} (report #${report.id}: ${report.option_name}).`;
        const recipients = new Set();
        if (process.env.DEVELOPER_USER_ID) recipients.add(process.env.DEVELOPER_USER_ID);
        try {
            const guildId = process.env.STAFF_GUILD_ID;
            const guild = guildId && (this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId));
            if (guild) {
                const members = await guild.members.fetch();
                for (const envName of ['OWNER_ROLE_ID', 'STAFF_HEAD_ROLE_ID']) {
                    const roleId = process.env[envName];
                    if (!roleId) continue;
                    members.filter(m => m.roles.cache.has(roleId) && !m.user.bot).forEach(m => recipients.add(m.id));
                }
            }
        } catch (err) {
            warn(`Infractions: could not list leadership members: ${err.message}`);
        }
        for (const id of recipients) {
            try {
                const user = await this.client.users.fetch(id);
                await user.send({ content: text, allowedMentions: { parse: [] } });
            } catch (err) {
                warn(`Infractions: could not DM ${id}: ${err.message}`);
            }
        }
    }

    start() {
        const timer = setInterval(() => this.reconcileAll().catch(err => error('Infraction reconcile failed:', err)), 5 * 60 * 1000);
        if (timer.unref) timer.unref();
        this.timer = timer;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { InfractionManager, InfractionError, getSettings, getReportOptions };

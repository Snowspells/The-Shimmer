const path = require('path');
const config = require('./EchoConfig');
const { parsePlayerList } = require('./EchoManager');
const { info, warn, error } = require('./Console');

const DEFAULTS = { enabled: true, intervalMinutes: 5 };

function range(value, fallback) {
    const min = Number(value?.min);
    const max = Number(value?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return fallback;
    return { min, max };
}

function roll({ min, max }, whole) {
    const value = min + Math.random() * (max - min);
    return whole ? Math.round(value) : Math.round(value * 1000) / 1000;
}

function getSettings() {
    const file = config.readJson(path.join(config.CONFIG_ROOT, 'passive.json'), {});
    const interval = Number(file.intervalMinutes);
    const attributes = new Set(config.getAttributeNames().map(a => a.toLowerCase()));
    const pool = (Array.isArray(file.buffs?.pool) ? file.buffs.pool : [])
        .map(entry => ({ attribute: String(entry?.attribute || ''), range: range(entry, null) }))
        .filter(entry => entry.range && attributes.has(entry.attribute.toLowerCase()));
    return {
        enabled: file.enabled !== false,
        // Must divide the hour evenly so ticks land on the hour and every N minutes after it.
        intervalMinutes: Number.isInteger(interval) && interval > 0 && 60 % interval === 0 ? interval : DEFAULTS.intervalMinutes,
        growth: range(file.growth, null),
        marks: range(file.marks, null),
        buffCount: Math.max(0, Math.floor(Number(file.buffs?.count ?? 1)) || 0),
        pool
    };
}

class PassiveRewards {
    constructor(client) {
        this.client = client;
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.timer || !this.client.rcon?.isEnabled()) return;
        this.scheduleNext();
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    scheduleNext() {
        const { intervalMinutes } = getSettings();
        const step = intervalMinutes * 60 * 1000;
        const now = Date.now();
        // Epoch hours are UTC-aligned, which matches the wall-clock hour in whole-hour time zones.
        const hourStart = now - (now % (60 * 60 * 1000));
        const next = hourStart + Math.floor((now - hourStart) / step + 1) * step;
        this.timer = setTimeout(() => {
            this.tick().catch(err => error('Passive rewards failed:', err)).finally(() => this.scheduleNext());
        }, next - now + 250);
        if (this.timer.unref) this.timer.unref();
    }

    async tick() {
        const settings = getSettings();
        if (!settings.enabled || this.running) return;
        this.running = true;
        try {
            const raw = await this.client.rcon.getPlayers();
            const online = parsePlayerList(typeof raw === 'string' ? raw : '');
            let rewarded = 0;
            for (const player of online) {
                const user = this.client.database.getUserByAgid(player.agid);
                if (!user) continue;
                try {
                    await this.reward(player.agid, user, settings);
                    rewarded++;
                } catch (err) {
                    warn(`Passive rewards: failed for ${player.agid}: ${err.message}`);
                }
            }
            info(`Passive rewards: rewarded ${rewarded} linked player(s).`);
        } finally {
            this.running = false;
        }
    }

    async reward(agid, user, settings) {
        const parts = [];
        if (settings.marks) {
            const amount = roll(settings.marks, true);
            if (amount > 0 && this.client.database.addMarks(user.DID, amount)) parts.push(`${amount} Marks`);
        }
        if (settings.growth) {
            const amount = roll(settings.growth, false);
            if (amount > 0) {
                await this.client.rcon.addAttribute(agid, 'Growth', amount);
                parts.push(`${amount} Growth`);
            }
        }
        const pool = [...settings.pool];
        for (let i = 0; i < settings.buffCount && pool.length > 0; i++) {
            const [pick] = pool.splice(Math.floor(Math.random() * pool.length), 1);
            const amount = roll(pick.range, false);
            await this.client.rcon.addAttribute(agid, pick.attribute, amount);
            parts.push(`+${amount} ${pick.attribute}`);
        }
        if (parts.length > 0) {
            await this.client.rcon.whisper(agid, `Time on the server rewarded you: ${parts.join(', ')}.`).catch(() => {});
        }
    }
}

module.exports = { PassiveRewards, getSettings };

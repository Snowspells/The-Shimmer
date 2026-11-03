const crypto = require('crypto');
const config = require('./EchoConfig');
const { info, warn, error, debug } = require('./Console');

function parseInventory(user) {
    try {
        const parsed = typeof user?.inventory === 'string' ? JSON.parse(user.inventory || '[]') : user?.inventory;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const isEchoItem = item => item && typeof item === 'object' && item.type === 'echo' && item.id;

function newEchoItem(echo) {
    return { id: crypto.randomUUID(), type: 'echo', tier: echo.tier, name: echo.name };
}

class EchoManager {
    constructor(client) {
        this.client = client;
        this.db = client.database;
        this.playerState = new Map(); // agid -> { species, dead, appliedKey }
        this.timer = null;
        this.polling = false;
    }

    // ---- Inventory & assignments -------------------------------------------

    getEchoItems(did) {
        return parseInventory(this.db.getUserByDiscordId(did)).filter(isEchoItem);
    }

    getAssignments(did) {
        return this.db.db.prepare('SELECT species, tier, item_id FROM echo_assignments WHERE did = ?').all(did);
    }

    /** Assign an owned Echo to a species; replaces whatever occupied that tier for the species. */
    assign(did, itemId, speciesName) {
        const species = config.findSpecies(speciesName);
        if (!species) throw new EchoError('Unknown species.');
        const item = this.getEchoItems(did).find(i => i.id === itemId);
        if (!item) throw new EchoError('You do not own that Echo.');
        if (!config.getEcho(item.tier, item.name)) throw new EchoError('That Echo is no longer available.');

        this.db.db.transaction(() => {
            this.db.db.prepare('DELETE FROM echo_assignments WHERE item_id = ?').run(itemId);
            this.db.db.prepare('DELETE FROM echo_assignments WHERE did = ? AND species = ? AND tier = ?')
                .run(did, species.name, item.tier);
            this.db.db.prepare('INSERT INTO echo_assignments (did, species, tier, item_id) VALUES (?, ?, ?, ?)')
                .run(did, species.name, item.tier, itemId);
        })();
        this.playerState.forEach(state => { state.appliedKey = null; });
        return { item, species: species.name };
    }

    unassign(did, itemId) {
        const result = this.db.db.prepare('DELETE FROM echo_assignments WHERE did = ? AND item_id = ?').run(did, itemId);
        this.playerState.forEach(state => { state.appliedKey = null; });
        return result.changes > 0;
    }

    /** Delete an Echo from the inventory and from any assignment. */
    destroyEcho(did, itemId, actor = {}) {
        const user = this.db.getUserByDiscordId(did);
        if (!user) return;
        const inventory = parseInventory(user).filter(i => !(isEchoItem(i) && i.id === itemId));
        this.db.db.prepare('DELETE FROM echo_assignments WHERE item_id = ?').run(itemId);
        this.db.updateUser(did, { inventory }, actor);
    }

    // ---- Shop ---------------------------------------------------------------

    purchase(did, shopId) {
        const item = config.getShopItem(shopId);
        if (!item) throw new EchoError('That item is not for sale.');
        const user = this.db.getUserByDiscordId(did);
        if (!user) throw new EchoError('Link your game account before shopping.');
        if ((user.marks || 0) < item.price) throw new EchoError('You do not have enough Marks.');

        const inventory = parseInventory(user);
        if (item.echo) {
            inventory.push(newEchoItem(config.getEcho(item.echo.tier, item.echo.name)));
        } else {
            inventory.push({ id: crypto.randomUUID(), type: 'shop', name: item.name });
        }
        this.db.updateUser(did, { marks: user.marks - item.price, inventory }, {
            actorId: did, reason: `Shop purchase: ${item.name}`
        });
        return item;
    }

    // ---- In-game application ------------------------------------------------

    /** Merge the attribute values of every equipped Echo for a species (numeric values multiply). */
    buildLoadout(did, speciesName) {
        const allowed = new Set(config.getAttributeNames().map(a => a.toLowerCase()));
        const owned = new Map(this.getEchoItems(did).map(i => [i.id, i]));
        const names = [];
        const attributes = {};
        for (const row of this.getAssignments(did)) {
            if (row.species.toLowerCase() !== String(speciesName).toLowerCase()) continue;
            const item = owned.get(row.item_id);
            const echo = item && config.getEcho(item.tier, item.name);
            if (!echo) continue;
            names.push(echo.name);
            for (const [attribute, value] of Object.entries(echo.attributes)) {
                if (value === null || value === undefined || value === '') continue;
                const number = Number(value);
                if (!allowed.has(attribute.toLowerCase()) || !Number.isFinite(number)) {
                    warn(`Echo: ignoring invalid attribute "${attribute}" on ${echo.name}.`);
                    continue;
                }
                attributes[attribute] = attribute in attributes ? attributes[attribute] * number : number;
            }
        }
        return { names, attributes };
    }

    async applyLoadout(agid, speciesName, did) {
        const { names, attributes } = this.buildLoadout(did, speciesName);
        for (const [attribute, value] of Object.entries(attributes)) {
            await this.client.rcon.setAttribute(agid, attribute, value);
        }
        if (names.length > 0) {
            await this.client.rcon.whisper(agid, `Equipped Echoes for ${speciesName}: ${names.join(', ')}`);
        }
        return names;
    }

    /** Roll each equipped Echo's break chance after the player's species dies. */
    async handleDeath(agid, speciesName, did) {
        const owned = new Map(this.getEchoItems(did).map(i => [i.id, i]));
        const broken = [];
        for (const row of this.getAssignments(did)) {
            if (row.species.toLowerCase() !== String(speciesName).toLowerCase()) continue;
            const item = owned.get(row.item_id);
            if (!item) {
                this.db.db.prepare('DELETE FROM echo_assignments WHERE item_id = ?').run(row.item_id);
                continue;
            }
            const tier = config.getTier(item.tier);
            if (tier && Math.random() < tier.breakChance) {
                this.destroyEcho(did, item.id, { reason: `${item.name} broke on death` });
                broken.push(item.name);
            }
        }
        if (broken.length > 0) {
            info(`Echo: ${broken.join(', ')} broke for ${did} (${speciesName}).`);
            await this.client.rcon.whisper(agid, `Your ${broken.join(', ')} broke on death.`).catch(() => {});
        }
        return broken;
    }

    // ---- Death detection by polling the RCON player list --------------------

    start() {
        if (this.timer || !this.client.rcon?.isEnabled()) return;
        const interval = Math.max(2000, parseInt(process.env.ECHO_POLL_INTERVAL_MS, 10) || 5000);
        this.timer = setInterval(() => this.poll().catch(err => warn(`Echo poll failed: ${err.message}`)), interval);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async poll() {
        if (this.polling) return;
        this.polling = true;
        try {
            const raw = await this.client.rcon.getPlayers();
            const players = parsePlayerList(typeof raw === 'string' ? raw : '');
            const seen = new Set();
            for (const player of players) {
                seen.add(player.agid);
                await this.observe(player);
            }
            // A player that vanished while alive may have left, not died; just drop the state.
            for (const agid of [...this.playerState.keys()]) {
                if (!seen.has(agid)) this.playerState.delete(agid);
            }
        } finally {
            this.polling = false;
        }
    }

    async observe(player) {
        const user = this.db.getUserByAgid(player.agid);
        if (!user) return;
        const previous = this.playerState.get(player.agid);
        const state = previous || { species: null, dead: false, appliedKey: null };
        this.playerState.set(player.agid, state);

        const speciesChanged = previous && state.species && player.species &&
            state.species.toLowerCase() !== player.species.toLowerCase();
        const justDied = (player.dead && !state.dead) || (speciesChanged && !state.dead);

        if (justDied && state.species) {
            debug(`Echo: death detected for ${player.agid} as ${state.species}`);
            await this.handleDeath(player.agid, state.species, user.DID).catch(err => error('Echo death handling failed:', err));
        }

        state.dead = player.dead;
        if (player.species) state.species = player.species;
        if (player.dead || !state.species || !config.findSpecies(state.species)) return;

        const key = `${state.species}|${JSON.stringify(this.buildLoadout(user.DID, state.species))}`;
        if (key !== state.appliedKey) {
            state.appliedKey = key;
            await this.applyLoadout(player.agid, state.species, user.DID).catch(err => error('Echo apply failed:', err));
        }
    }
}

class EchoError extends Error {}

function compile(envValue, fallback) {
    if (!envValue) return fallback;
    try {
        const match = envValue.match(/^\/(.*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(envValue);
    } catch {
        return fallback;
    }
}

/**
 * The RCON player list format varies by server version, so each field is matched with an
 * overridable regex: POT_PLAYERLIST_AGID_REGEX, _SPECIES_REGEX, _DEAD_REGEX (each uses group 1,
 * or the whole match when it has no group).
 */
function parsePlayerList(text) {
    const agidRegex = compile(process.env.POT_PLAYERLIST_AGID_REGEX, /\b([A-Za-z0-9]{2,5}(?:-[A-Za-z0-9]{2,5}){1,4})\b/);
    const speciesRegex = compile(process.env.POT_PLAYERLIST_SPECIES_REGEX, /(?:species|dino|character|class)\s*[:=]\s*([^,|;\r\n]+)/i);
    const deadRegex = compile(process.env.POT_PLAYERLIST_DEAD_REGEX, /\b(?:dead|deceased)\b|(?:health|hp)\s*[:=]\s*0(?:\.0+)?\b/i);
    const pick = (regex, line) => {
        const m = regex.exec(line);
        return m ? (m[1] ?? m[0]).trim() : null;
    };
    return text.split(/\r?\n/).map(line => {
        const agid = pick(agidRegex, line);
        if (!agid) return null;
        return { agid: agid.toUpperCase(), species: pick(speciesRegex, line), dead: deadRegex.test(line) };
    }).filter(Boolean);
}

module.exports = { EchoManager, EchoError, parsePlayerList, parseInventory, isEchoItem };

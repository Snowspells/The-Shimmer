const { Rcon } = require('rcon-client');
const { info, warn, error, debug, success } = require('./Console');

/**
 * Manages RCON connections to one or more Path of Titans dedicated servers.
 *
 * Path of Titans exposes a standard Source-style RCON interface over TCP. This
 * manager handles connecting, authenticating, automatic reconnection, and
 * sending commands. All RCON command strings are configurable via environment
 * variables so the integration can adapt to differences between game versions.
 *
 * Configuration (environment variables):
 *   Single server:
 *     RCON_HOST, RCON_PORT, RCON_PASSWORD, RCON_SERVER_NAME (optional)
 *   Multiple servers (takes precedence if set):
 *     RCON_SERVERS = JSON array, e.g.
 *       [{"name":"Main","host":"1.2.3.4","port":7779,"password":"secret"}]
 *
 *   Command templates (optional, defaults shown):
 *     RCON_CMD_ANNOUNCE   = "announce {message}"
 *     RCON_CMD_PLAYERLIST = "getplayerlist"
 *     RCON_CMD_KICK       = "kick {agid} {reason}"
 *     RCON_CMD_BAN        = "ban {agid} {hours} {reason}"
 *     RCON_CMD_HEAL       = "heal {agid}"
 *     RCON_CMD_HEALALL    = "healall"
 *     RCON_CMD_WHISPER    = "whisper {agid} {message}"
 *     RCON_CMD_TELEPORT   = "teleport {agid} {x} {y} {z}"
 *     RCON_CMD_ADDMARKS    = "addmarks {agid} {amount}"
 *     RCON_CMD_REMOVEMARKS = "removemarks {agid} {amount}"
 *     RCON_CMD_SETMARKS    = "setmarks {agid} {amount}"
 */
class RconManager {
    constructor() {
        this.servers = new Map();       // name -> { name, host, port, password }
        this.connections = new Map();   // name -> Rcon instance (connected)
        this.reconnectTimers = new Map();
        this.shuttingDown = false;
        this.RECONNECT_DELAY_MS = 10000;

        // Loop guard: messages we push into the game get echoed back by the PoT
        // server's Discord webhook. Remember recent relays to drop those echoes.
        this.recentRelays = [];
        this.RELAY_ECHO_TTL_MS = 15000;

        this.commands = {
            announce: process.env.RCON_CMD_ANNOUNCE || 'announce {message}',
            // Command used to relay Discord/Web chat into the game. Kept separate
            // from `announce` so chat bridging doesn't render as a banner.
            chat: process.env.RCON_CMD_CHAT || 'whisperall {message}',
            playerlist: process.env.RCON_CMD_PLAYERLIST || 'getplayerlist',
            kick: process.env.RCON_CMD_KICK || 'kick {agid} {reason}',
            ban: process.env.RCON_CMD_BAN || 'ban {agid} {hours} {reason}',
            heal: process.env.RCON_CMD_HEAL || 'heal {agid}',
            healall: process.env.RCON_CMD_HEALALL || 'healall',
            whisper: process.env.RCON_CMD_WHISPER || 'whisper {agid} {message}',
            teleport: process.env.RCON_CMD_TELEPORT || 'teleport {agid} {x} {y} {z}',
            // Per-character Marks economy commands (target by AGID).
            addmarks: process.env.RCON_CMD_ADDMARKS || 'addmarks {agid} {amount}',
            removemarks: process.env.RCON_CMD_REMOVEMARKS || 'removemarks {agid} {amount}',
            setmarks: process.env.RCON_CMD_SETMARKS || 'setmarks {agid} {amount}'
        };

        this.loadConfig();
    }

    loadConfig() {
        // Multi-server config takes precedence.
        if (process.env.RCON_SERVERS) {
            try {
                const parsed = JSON.parse(process.env.RCON_SERVERS);
                if (Array.isArray(parsed)) {
                    for (const s of parsed) {
                        if (!s.host || !s.password) continue;
                        const name = s.name || `${s.host}:${s.port}`;
                        this.servers.set(name, {
                            name,
                            host: s.host,
                            port: parseInt(s.port, 10) || 7779,
                            password: s.password
                        });
                    }
                }
            } catch (err) {
                error('RCON: failed to parse RCON_SERVERS JSON:', err.message);
            }
        } else if (process.env.RCON_HOST && process.env.RCON_PASSWORD) {
            const name = process.env.RCON_SERVER_NAME || 'Main';
            this.servers.set(name, {
                name,
                host: process.env.RCON_HOST,
                port: parseInt(process.env.RCON_PORT, 10) || 7779,
                password: process.env.RCON_PASSWORD
            });
        }
    }

    isEnabled() {
        return this.servers.size > 0;
    }

    serverNames() {
        return [...this.servers.keys()];
    }

    defaultServerName() {
        return this.servers.keys().next().value || null;
    }

    resolveServerName(name) {
        if (name && this.servers.has(name)) return name;
        return this.defaultServerName();
    }

    /**
     * Connect (and authenticate) to every configured server.
     */
    async connectAll() {
        if (!this.isEnabled()) {
            debug('RCON: no servers configured, skipping connection.');
            return;
        }
        for (const name of this.servers.keys()) {
            await this.connect(name).catch(() => {});
        }
    }

    /**
     * Establish a connection to a single server, replacing any existing one.
     * @returns {Promise<Rcon>}
     */
    async connect(name) {
        const cfg = this.servers.get(name);
        if (!cfg) throw new Error(`Unknown RCON server: ${name}`);

        // Tear down any stale connection.
        const existing = this.connections.get(name);
        if (existing) {
            this.connections.delete(name);
            try { await existing.end(); } catch { /* ignore */ }
        }

        const rcon = new Rcon({ host: cfg.host, port: cfg.port, password: cfg.password });

        rcon.on('error', (err) => {
            warn(`RCON [${name}]: connection error: ${err.message}`);
        });
        rcon.on('end', () => {
            if (this.connections.get(name) === rcon) {
                this.connections.delete(name);
            }
            debug(`RCON [${name}]: connection ended.`);
            this.scheduleReconnect(name);
        });

        await rcon.connect();
        this.connections.set(name, rcon);
        success(`RCON [${name}]: connected to ${cfg.host}:${cfg.port}`);
        return rcon;
    }

    scheduleReconnect(name) {
        if (this.shuttingDown) return;
        if (this.reconnectTimers.has(name)) return;
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(name);
            this.connect(name).catch((err) => {
                warn(`RCON [${name}]: reconnect failed: ${err.message}`);
                this.scheduleReconnect(name);
            });
        }, this.RECONNECT_DELAY_MS);
        if (timer.unref) timer.unref();
        this.reconnectTimers.set(name, timer);
    }

    /**
     * Send a raw command to a server, connecting/reconnecting if needed.
     * @returns {Promise<string>} the server's response text
     */
    async send(serverName, command) {
        const name = this.resolveServerName(serverName);
        if (!name) throw new Error('No RCON server configured.');

        let rcon = this.connections.get(name);
        if (!rcon) {
            rcon = await this.connect(name);
        }

        try {
            const response = await rcon.send(command);
            debug(`RCON [${name}] > ${command}`);
            return response;
        } catch (err) {
            // One reconnect-and-retry attempt on transient failures.
            warn(`RCON [${name}]: command failed (${err.message}), retrying after reconnect.`);
            rcon = await this.connect(name);
            return rcon.send(command);
        }
    }

    /** Send the same command to every configured server. */
    async sendAll(command) {
        const results = {};
        for (const name of this.servers.keys()) {
            try {
                results[name] = await this.send(name, command);
            } catch (err) {
                results[name] = `ERROR: ${err.message}`;
            }
        }
        return results;
    }

    format(template, vars) {
        return template.replace(/\{(\w+)\}/g, (match, key) =>
            (key in vars && vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : ''
        ).replace(/\s+/g, ' ').trim();
    }

    // ---- High level helpers -------------------------------------------------

    /**
     * Relay a chat message originating from Discord/Web into the game as a
     * server announcement. Sends to all servers by default.
     */
    async relayChat(source, authorName, content, serverName = null) {
        const label = source === 'web' ? 'Web' : 'Discord';
        const message = `[${label}] ${authorName}: ${content}`;
        this.markRelayed(message);
        this.markRelayed(`${authorName}: ${content}`);
        const command = this.format(this.commands.chat, { message });
        if (serverName) return this.send(serverName, command);
        return this.sendAll(command);
    }

    markRelayed(text) {
        const value = (text || '').trim();
        if (!value) return;
        const now = Date.now();
        this.recentRelays.push({ value, at: now });
        // Prune expired entries.
        this.recentRelays = this.recentRelays.filter((r) => now - r.at < this.RELAY_ECHO_TTL_MS);
    }

    /**
     * True when an inbound webhook line looks like an echo of a message we just
     * relayed into the game (prevents Discord/Web -> game -> Discord loops).
     */
    wasRecentlyRelayed(line) {
        const value = (line || '').trim();
        if (!value) return false;
        const now = Date.now();
        this.recentRelays = this.recentRelays.filter((r) => now - r.at < this.RELAY_ECHO_TTL_MS);
        return this.recentRelays.some((r) => value.includes(r.value));
    }

    async announce(message, serverName = null) {
        const command = this.format(this.commands.announce, { message });
        if (serverName) return this.send(serverName, command);
        return this.sendAll(command);
    }

    async whisper(agid, message, serverName = null) {
        const command = this.format(this.commands.whisper, { agid, message });
        return this.send(serverName, command);
    }

    async getPlayers(serverName = null) {
        const command = this.format(this.commands.playerlist, {});
        return this.send(serverName, command);
    }

    async kick(agid, reason = '', serverName = null) {
        const command = this.format(this.commands.kick, { agid, reason });
        return this.send(serverName, command);
    }

    async ban(agid, hours = 0, reason = '', serverName = null) {
        const command = this.format(this.commands.ban, { agid, hours, reason });
        return this.send(serverName, command);
    }

    async heal(agid, serverName = null) {
        const command = this.format(this.commands.heal, { agid });
        return this.send(serverName, command);
    }

    async healAll(serverName = null) {
        const command = this.format(this.commands.healall, {});
        if (serverName) return this.send(serverName, command);
        return this.sendAll(command);
    }

    async teleport(agid, x, y, z, serverName = null) {
        const command = this.format(this.commands.teleport, { agid, x, y, z });
        return this.send(serverName, command);
    }

    /** Add Marks to a character (by AGID). Returns the server's response text. */
    async addMarks(agid, amount, serverName = null) {
        const command = this.format(this.commands.addmarks, { agid, amount });
        return this.send(serverName, command);
    }

    /** Remove Marks from a character (by AGID). Returns the server's response text. */
    async removeMarks(agid, amount, serverName = null) {
        const command = this.format(this.commands.removemarks, { agid, amount });
        return this.send(serverName, command);
    }

    /** Set a character's Marks total (by AGID). Returns the server's response text. */
    async setMarks(agid, amount, serverName = null) {
        const command = this.format(this.commands.setmarks, { agid, amount });
        return this.send(serverName, command);
    }

    status() {
        return this.serverNames().map((name) => ({
            name,
            host: this.servers.get(name).host,
            port: this.servers.get(name).port,
            connected: this.connections.has(name)
        }));
    }

    async disconnectAll() {
        this.shuttingDown = true;
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        for (const [name, rcon] of this.connections) {
            try { await rcon.end(); } catch { /* ignore */ }
            debug(`RCON [${name}]: disconnected.`);
        }
        this.connections.clear();
    }
}

module.exports = RconManager;

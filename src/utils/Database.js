const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { resolveDatabasePath } = require('./DatabasePaths');

class DatabaseManager {
    constructor(filePath = resolveDatabasePath(
        'application',
        'database.db',
        path.resolve(__dirname, '../../database.db')
    )) {
        this.db = new Database(filePath);
        this.db.pragma('journal_mode = WAL'); // Enable write-ahead logging for better concurrency
        this.initializeTables();
    }

    initializeTables() {
        // Guild settings table (for prefix, etc.)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id TEXT PRIMARY KEY,
                prefix TEXT DEFAULT '?'
            )
        `);

        // Users table (for linked Discord accounts)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                DID TEXT PRIMARY KEY,
                agid TEXT NOT NULL,
                marks INTEGER DEFAULT 0,
                inventory TEXT DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Web sessions table (for Discord OAuth2 sessions)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS web_sessions (
                session_id TEXT PRIMARY KEY,
                discord_id TEXT NOT NULL,
                access_token TEXT NOT NULL,
                refresh_token TEXT,
                username TEXT,
                discriminator TEXT,
                avatar TEXT,
                is_staff INTEGER DEFAULT 0,
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Staff roles table (maps Discord role IDs to staff levels)
        // Levels: 1 = Support, 2 = Moderator, 3 = Administrator
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS staff_roles (
                role_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                label TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tickets table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                channel_id TEXT,
                creator_id TEXT NOT NULL,
                creator_name TEXT NOT NULL,
                subject TEXT DEFAULT 'No subject',
                status TEXT DEFAULT 'open',
                claimed_by TEXT,
                claimed_by_name TEXT,
                closed_by TEXT,
                closed_by_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                closed_at DATETIME
            )
        `);
        const ticketColumns = new Set(
            this.db.prepare('PRAGMA table_info(tickets)').all().map(column => column.name)
        );
        if (!ticketColumns.has('ticket_mode')) {
            this.db.exec("ALTER TABLE tickets ADD COLUMN ticket_mode TEXT NOT NULL DEFAULT 'channel'");
        }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_type TEXT NOT NULL CHECK (author_type IN ('user', 'staff', 'system')),
                content TEXT NOT NULL,
                discord_message_id TEXT UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id)
            );
            CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id, id);
        `);
        this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_dm_ticket_per_user
            ON tickets(creator_id)
            WHERE ticket_mode = 'dm' AND status = 'open'
        `);

        // Ticket settings per guild
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_settings (
                guild_id TEXT PRIMARY KEY,
                category_id TEXT,
                log_channel_id TEXT,
                support_role_id TEXT,
                welcome_message TEXT DEFAULT 'Thank you for creating a ticket! A staff member will be with you shortly.',
                ticket_count INTEGER DEFAULT 0
            )
        `);

        // Ticket transcripts
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_transcripts (
                ticket_id INTEGER PRIMARY KEY,
                guild_id TEXT NOT NULL,
                transcript_html TEXT NOT NULL,
                message_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                creator_id TEXT NOT NULL,
                creator_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Suggested'
                    CHECK (status IN ('Suggested', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Declined')),
                decline_reason TEXT,
                declined_by TEXT,
                declined_by_name TEXT,
                declined_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_suggestions_status_updated
                ON suggestions(status, updated_at DESC);
            CREATE TABLE IF NOT EXISTS suggestion_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                suggestion_id INTEGER NOT NULL,
                actor_id TEXT NOT NULL,
                actor_name TEXT NOT NULL,
                action TEXT NOT NULL,
                from_status TEXT,
                to_status TEXT,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (suggestion_id) REFERENCES suggestions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_suggestion_activity_card
                ON suggestion_activity(suggestion_id, id DESC);
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS reaction_role_panels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                guild_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                message_id TEXT UNIQUE,
                content TEXT NOT NULL,
                mappings TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                updated_by_name TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Chat bridge messages log
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_bridge_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_id TEXT,
                content TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Chat mutes table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_mutes (
                user_id TEXT PRIMARY KEY,
                muted_by TEXT NOT NULL,
                muted_by_name TEXT NOT NULL,
                reason TEXT,
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Game players seen in-game (populated from Path of Titans join/chat events)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS game_players (
                agid TEXT PRIMARY KEY,
                player_name TEXT,
                server_name TEXT,
                online INTEGER DEFAULT 0,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Pending Discord <-> AGID link verifications (whisper-code flow)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS link_verifications (
                discord_id TEXT PRIMARY KEY,
                agid TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Role colors table (maps staff levels to hex colors, configurable via Discord role IDs)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS role_colors (
                level INTEGER PRIMARY KEY,
                label TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#8b949e',
                discord_role_id TEXT
            )
        `);

        // Seed default role colors if empty
        const colorCount = this.db.prepare('SELECT COUNT(*) as count FROM role_colors').get().count;
        if (colorCount === 0) {
            const defaultColors = [
                [0, 'Member', '#8b949e', null],
                [1, 'Support', '#3fb950', null],
                [2, 'Moderator', '#5865f2', null],
                [3, 'Administrator', '#da3633', null],
                [4, 'Owner', '#f0883e', null]
            ];
            const insertColor = this.db.prepare(
                'INSERT INTO role_colors (level, label, color, discord_role_id) VALUES (?, ?, ?, ?)'
            );
            for (const [level, label, color, roleId] of defaultColors) {
                insertColor.run(level, label, color, roleId);
            }
        }

        // OAuth2 state tokens (for cross-context CSRF protection in standalone client auth)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS client_oauth_states (
                state TEXT PRIMARY KEY,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Client auth tokens table (for standalone client token-based auth)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS client_tokens (
                token TEXT PRIMARY KEY,
                discord_id TEXT NOT NULL,
                username TEXT NOT NULL,
                global_name TEXT,
                discriminator TEXT,
                avatar TEXT,
                is_staff INTEGER DEFAULT 0,
                staff_level INTEGER DEFAULT 0,
                staff_label TEXT,
                roles TEXT DEFAULT '[]',
                refresh_token TEXT,
                discord_access_token TEXT,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        const clientTokenColumns = new Set(
            this.db.prepare('PRAGMA table_info(client_tokens)').all().map(column => column.name)
        );
        if (!clientTokenColumns.has('global_name')) {
            this.db.exec('ALTER TABLE client_tokens ADD COLUMN global_name TEXT');
        }

        // One-time auth codes (short-lived, exchanged by the standalone client for a token)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS client_auth_codes (
                code TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        `);
    }

    // --- Token hashing & at-rest encryption helpers ---
    // Client tokens are stored as SHA-256 hashes so a database leak does not
    // expose usable bearer credentials. Discord OAuth tokens are encrypted
    // with AES-256-GCM using a key derived from SESSION_SECRET.
    static hashToken(token) {
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    _encryptionKey() {
        const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET;
        if (!secret) return null;
        return crypto.createHash('sha256').update(String(secret)).digest();
    }

    _encrypt(plain) {
        if (plain == null) return null;
        const key = this._encryptionKey();
        if (!key) return String(plain); // No key configured (e.g. dev/test) — store as-is.
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    }

    _decrypt(value) {
        if (value == null) return null;
        if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value; // legacy/plaintext
        const key = this._encryptionKey();
        if (!key) return null;
        try {
            const [, , ivHex, tagHex, dataHex] = value.split(':');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
            return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
        } catch (err) {
            const { error } = require('./Console');
            error('Error decrypting value:', err);
            return null;
        }
    }

    // Guild Settings Methods
    getGuildPrefix(guildId) {
        try {
            const result = this.db.prepare('SELECT prefix FROM guild_settings WHERE guild_id = ?').get(guildId);
            return result ? result.prefix : null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting guild prefix:', err);
            return null;
        }
    }

    setGuildPrefix(guildId, prefix) {
        try {
            this.db.prepare('INSERT OR REPLACE INTO guild_settings (guild_id, prefix) VALUES (?, ?)').run(guildId, prefix);
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting guild prefix:', err);
        }
    }

    deleteGuildPrefix(guildId) {
        try {
            this.db.prepare('DELETE FROM guild_settings WHERE guild_id = ?').run(guildId);
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting guild prefix:', err);
        }
    }

    // User Methods
    getUserByDiscordId(discordId) {
        try {
            const result = this.db.prepare('SELECT * FROM users WHERE DID = ?').get(discordId);
            return result;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting user:', err);
            return null;
        }
    }

    userExists(discordId) {
        try {
            const result = this.db.prepare('SELECT DID FROM users WHERE DID = ?').get(discordId);
            return !!result;
        } catch (err) {
            const { error } = require('./Console');
            error('Error checking user existence:', err);
            return false;
        }
    }

    createUser(discordId, agid, marks = 0, inventory = []) {
        try {
            const inventoryJson = JSON.stringify(inventory);
            this.db.prepare('INSERT INTO users (DID, agid, marks, inventory) VALUES (?, ?, ?, ?)').run(
                discordId,
                agid,
                marks,
                inventoryJson
            );
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating user:', err);
        }
    }

    updateUser(discordId, data) {
        try {
            const fields = [];
            const values = [];
            
            for (const [key, value] of Object.entries(data)) {
                if (key !== 'DID') {
                    fields.push(`${key} = ?`);
                    values.push(key === 'inventory' ? JSON.stringify(value) : value);
                }
            }

            if (fields.length === 0) return;

            values.push(discordId);
            const query = `UPDATE users SET ${fields.join(', ')} WHERE DID = ?`;
            this.db.prepare(query).run(...values);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error updating user:', err);
        }
    }

    getAllUsers() {
        try {
            const results = this.db.prepare('SELECT * FROM users').all();
            return results.map(user => ({
                ...user,
                inventory: JSON.parse(user.inventory || '[]')
            }));
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting all users:', err);
            return [];
        }
    }

    deleteUser(discordId) {
        try {
            this.db.prepare('DELETE FROM users WHERE DID = ?').run(discordId);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting user:', err);
        }
    }

    checkpointWAL() {
        try {
            this.db.pragma('wal_checkpoint(RESTART)');
        } catch (err) {
            const { error } = require('./Console');
            error('Error checkpointing WAL:', err);
        }
    }

    // Staff Role Methods
    // Levels: 1 = Support, 2 = Moderator, 3 = Administrator
    static STAFF_LEVELS = {
        MEMBER: 0,
        STAFF_IN_TRAINING: 1,
        SUPPORT: 1,
        STAFF: 2,
        MODERATOR: 2,
        OWNER: 3,
        DEVELOPER: 4,
        ADMINISTRATOR: 4
    };
    static STAFF_LABELS = {
        0: 'Member',
        1: 'Staff in Training',
        2: 'Staff',
        3: 'Owner',
        4: 'Developer'
    };

    setStaffRole(roleId, guildId, level) {
        try {
            const label = DatabaseManager.STAFF_LABELS[level];
            if (!label) return false;
            this.db.prepare(
                'INSERT OR REPLACE INTO staff_roles (role_id, guild_id, level, label) VALUES (?, ?, ?, ?)'
            ).run(roleId, guildId, level, label);
            this.checkpointWAL();
            return true;
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting staff role:', err);
            return false;
        }
    }

    removeStaffRole(roleId) {
        try {
            this.db.prepare('DELETE FROM staff_roles WHERE role_id = ?').run(roleId);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error removing staff role:', err);
        }
    }

    getStaffRole(roleId) {
        try {
            return this.db.prepare('SELECT * FROM staff_roles WHERE role_id = ?').get(roleId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting staff role:', err);
            return null;
        }
    }

    getAllStaffRoles(guildId) {
        try {
            if (guildId) {
                return this.db.prepare('SELECT * FROM staff_roles WHERE guild_id = ? ORDER BY level DESC').all(guildId);
            }
            return this.db.prepare('SELECT * FROM staff_roles ORDER BY level DESC').all();
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting all staff roles:', err);
            return [];
        }
    }

    getStaffLevelForRoles(roleIds) {
        try {
            if (!roleIds || roleIds.length === 0) return 0;
            const placeholders = roleIds.map(() => '?').join(',');
            const result = this.db.prepare(
                `SELECT MAX(level) as max_level FROM staff_roles WHERE role_id IN (${placeholders})`
            ).get(...roleIds);
            return result?.max_level || 0;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting staff level for roles:', err);
            return 0;
        }
    }

    // Web Session Methods
    getWebSession(sessionId) {
        try {
            return this.db.prepare('SELECT * FROM web_sessions WHERE session_id = ?').get(sessionId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting web session:', err);
            return null;
        }
    }

    createWebSession(sessionId, data) {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO web_sessions
                (session_id, discord_id, access_token, refresh_token, username, discriminator, avatar, is_staff, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sessionId,
                data.discord_id,
                data.access_token,
                data.refresh_token || null,
                data.username || null,
                data.discriminator || null,
                data.avatar || null,
                data.is_staff ? 1 : 0,
                data.expires_at || null
            );
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating web session:', err);
        }
    }

    deleteWebSession(sessionId) {
        try {
            this.db.prepare('DELETE FROM web_sessions WHERE session_id = ?').run(sessionId);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting web session:', err);
        }
    }

    createSuggestion({ title, description, creatorId, creatorName }) {
        const create = this.db.transaction(() => {
            const result = this.db.prepare(`
                INSERT INTO suggestions (title, description, creator_id, creator_name)
                VALUES (?, ?, ?, ?)
            `).run(title, description, creatorId, creatorName);
            const suggestionId = Number(result.lastInsertRowid);
            this.db.prepare(`
                INSERT INTO suggestion_activity
                    (suggestion_id, actor_id, actor_name, action, to_status)
                VALUES (?, ?, ?, 'submitted', 'Suggested')
            `).run(suggestionId, creatorId, creatorName);
            return this.getSuggestion(suggestionId);
        });
        const suggestion = create();
        this.checkpointWAL();
        return suggestion;
    }

    createManagedSuggestion({ title, description, status, creatorId, creatorName }) {
        const create = this.db.transaction(() => {
            const result = this.db.prepare(`
                INSERT INTO suggestions (title, description, creator_id, creator_name, status)
                VALUES (?, ?, ?, ?, ?)
            `).run(title, description, creatorId, creatorName, status);
            const suggestionId = Number(result.lastInsertRowid);
            this.db.prepare(`
                INSERT INTO suggestion_activity
                    (suggestion_id, actor_id, actor_name, action, to_status)
                VALUES (?, ?, ?, 'created_by_developer', ?)
            `).run(suggestionId, creatorId, creatorName, status);
            return this.getSuggestion(suggestionId);
        });
        const suggestion = create();
        this.checkpointWAL();
        return suggestion;
    }

    getSuggestions() {
        return this.db.prepare(
            'SELECT * FROM suggestions ORDER BY updated_at DESC, id DESC'
        ).all();
    }

    getSuggestion(suggestionId) {
        return this.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId) || null;
    }

    getSuggestionActivity(suggestionId) {
        return this.db.prepare(
            'SELECT * FROM suggestion_activity WHERE suggestion_id = ? ORDER BY id DESC'
        ).all(suggestionId);
    }

    getReactionRolePanels() {
        return this.db.prepare(
            'SELECT * FROM reaction_role_panels ORDER BY updated_at DESC, id DESC'
        ).all();
    }

    getReactionRolePanel(panelId) {
        return this.db.prepare(
            'SELECT * FROM reaction_role_panels WHERE id = ?'
        ).get(panelId) || null;
    }

    getReactionRolePanelByMessageId(messageId) {
        return this.db.prepare(
            'SELECT * FROM reaction_role_panels WHERE message_id = ?'
        ).get(messageId) || null;
    }

    saveReactionRolePanel({
        id, name, guildId, channelId, messageId, content, mappings, updatedBy, updatedByName
    }) {
        if (id) {
            this.db.prepare(`
                UPDATE reaction_role_panels
                SET name = ?, guild_id = ?, channel_id = ?, message_id = ?, content = ?,
                    mappings = ?, updated_by = ?, updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                name, guildId, channelId, messageId || null, content, JSON.stringify(mappings),
                updatedBy, updatedByName, id
            );
            this.checkpointWAL();
            return this.getReactionRolePanel(id);
        }

        const result = this.db.prepare(`
            INSERT INTO reaction_role_panels
                (name, guild_id, channel_id, message_id, content, mappings, updated_by, updated_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            name, guildId, channelId, messageId || null, content, JSON.stringify(mappings),
            updatedBy, updatedByName
        );
        this.checkpointWAL();
        return this.getReactionRolePanel(Number(result.lastInsertRowid));
    }

    deleteReactionRolePanel(panelId) {
        const result = this.db.prepare(
            'DELETE FROM reaction_role_panels WHERE id = ?'
        ).run(panelId);
        if (result.changes) this.checkpointWAL();
        return result.changes > 0;
    }

    updateSuggestion(suggestionId, { title, description, status, actorId, actorName }) {
        const update = this.db.transaction(() => {
            const current = this.getSuggestion(suggestionId);
            if (!current) return null;
            this.db.prepare(`
                UPDATE suggestions
                SET title = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP
                    , decline_reason = CASE WHEN ? = 'Declined' THEN decline_reason ELSE NULL END
                    , declined_by = CASE WHEN ? = 'Declined' THEN declined_by ELSE NULL END
                    , declined_by_name = CASE WHEN ? = 'Declined' THEN declined_by_name ELSE NULL END
                    , declined_at = CASE WHEN ? = 'Declined' THEN declined_at ELSE NULL END
                WHERE id = ?
            `).run(title, description, status, status, status, status, status, suggestionId);
            if (current.status !== status) {
                this.db.prepare(`
                    INSERT INTO suggestion_activity
                        (suggestion_id, actor_id, actor_name, action, from_status, to_status)
                    VALUES (?, ?, ?, 'status_changed', ?, ?)
                `).run(suggestionId, actorId, actorName, current.status, status);
            }
            return this.getSuggestion(suggestionId);
        });
        const suggestion = update();
        this.checkpointWAL();
        return suggestion;
    }

    declineSuggestion(suggestionId, { reason, actorId, actorName }) {
        const decline = this.db.transaction(() => {
            const current = this.getSuggestion(suggestionId);
            if (!current) return null;
            if (current.status === 'Completed' || current.status === 'Declined') {
                const err = new Error('Completed or already declined cards cannot be declined.');
                err.code = 'SUGGESTION_CANNOT_BE_DECLINED';
                throw err;
            }

            const result = this.db.prepare(`
                UPDATE suggestions
                SET status = 'Declined', decline_reason = ?, declined_by = ?,
                    declined_by_name = ?, declined_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = ?
            `).run(reason, actorId, actorName, suggestionId, current.status);
            if (result.changes !== 1) {
                const err = new Error('This card changed while you were declining it. Refresh and try again.');
                err.code = 'SUGGESTION_CHANGED';
                throw err;
            }
            this.db.prepare(`
                INSERT INTO suggestion_activity
                    (suggestion_id, actor_id, actor_name, action, from_status, to_status, details)
                VALUES (?, ?, ?, 'declined', ?, 'Declined', ?)
            `).run(suggestionId, actorId, actorName, current.status, reason);
            return this.getSuggestion(suggestionId);
        });
        const suggestion = decline();
        this.checkpointWAL();
        return suggestion;
    }

    deleteSuggestion(suggestionId) {
        const remove = this.db.transaction(() => {
            this.db.prepare('DELETE FROM suggestion_activity WHERE suggestion_id = ?').run(suggestionId);
            return this.db.prepare('DELETE FROM suggestions WHERE id = ?').run(suggestionId).changes > 0;
        });
        const deleted = remove();
        if (deleted) this.checkpointWAL();
        return deleted;
    }

    // Chat Bridge Methods
    logBridgeMessage(source, authorName, authorId, content) {
        try {
            this.db.prepare(
                'INSERT INTO chat_bridge_messages (source, author_name, author_id, content) VALUES (?, ?, ?, ?)'
            ).run(source, authorName, authorId || null, content);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error logging bridge message:', err);
        }
    }

    getRecentBridgeMessages(limit = 50) {
        try {
            return this.db.prepare(
                'SELECT * FROM chat_bridge_messages ORDER BY timestamp DESC LIMIT ?'
            ).all(limit).reverse();
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting bridge messages:', err);
            return [];
        }
    }

    // Ticket Settings Methods
    getTicketSettings(guildId) {
        try {
            return this.db.prepare('SELECT * FROM ticket_settings WHERE guild_id = ?').get(guildId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting ticket settings:', err);
            return null;
        }
    }

    setTicketSettings(guildId, data) {
        try {
            const existing = this.getTicketSettings(guildId);
            if (existing) {
                const fields = [];
                const values = [];
                for (const [key, value] of Object.entries(data)) {
                    if (key !== 'guild_id') {
                        fields.push(`${key} = ?`);
                        values.push(value);
                    }
                }
                if (fields.length === 0) return;
                values.push(guildId);
                this.db.prepare(`UPDATE ticket_settings SET ${fields.join(', ')} WHERE guild_id = ?`).run(...values);
            } else {
                this.db.prepare(
                    'INSERT INTO ticket_settings (guild_id, category_id, log_channel_id, support_role_id, welcome_message) VALUES (?, ?, ?, ?, ?)'
                ).run(guildId, data.category_id || null, data.log_channel_id || null, data.support_role_id || null, data.welcome_message || 'Thank you for creating a ticket! A staff member will be with you shortly.');
            }
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting ticket settings:', err);
        }
    }

    incrementTicketCount(guildId) {
        try {
            const settings = this.getTicketSettings(guildId);
            const newCount = (settings?.ticket_count || 0) + 1;
            if (settings) {
                this.db.prepare('UPDATE ticket_settings SET ticket_count = ? WHERE guild_id = ?').run(newCount, guildId);
            } else {
                this.db.prepare('INSERT INTO ticket_settings (guild_id, ticket_count) VALUES (?, ?)').run(guildId, newCount);
            }
            this.checkpointWAL();
            return newCount;
        } catch (err) {
            const { error } = require('./Console');
            error('Error incrementing ticket count:', err);
            return 0;
        }
    }

    // Ticket Methods
    createTicket(guildId, channelId, creatorId, creatorName, subject) {
        try {
            const result = this.db.prepare(
                'INSERT INTO tickets (guild_id, channel_id, creator_id, creator_name, subject) VALUES (?, ?, ?, ?, ?)'
            ).run(guildId, channelId, creatorId, creatorName, subject || 'No subject');
            this.checkpointWAL();
            return result.lastInsertRowid;
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating ticket:', err);
            return null;
        }
    }

    createDmTicket(guildId, creatorId, creatorName, subject) {
        try {
            const result = this.db.prepare(
                "INSERT INTO tickets (guild_id, channel_id, creator_id, creator_name, subject, ticket_mode) VALUES (?, NULL, ?, ?, ?, 'dm')"
            ).run(guildId, creatorId, creatorName, subject || 'Support request');
            this.checkpointWAL();
            return result.lastInsertRowid;
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating DM ticket:', err);
            return null;
        }
    }

    deleteDmTicket(ticketId) {
        try {
            this.db.transaction(() => {
                this.db.prepare('DELETE FROM ticket_messages WHERE ticket_id = ?').run(ticketId);
                this.db.prepare("DELETE FROM tickets WHERE id = ? AND ticket_mode = 'dm' AND status = 'open'").run(ticketId);
            })();
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting failed DM ticket:', err);
        }
    }

    getTicket(ticketId) {
        try {
            return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting ticket:', err);
            return null;
        }
    }

    getTicketByChannelId(channelId) {
        try {
            return this.db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND status = ?').get(channelId, 'open') || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting ticket by channel:', err);
            return null;
        }
    }

    getOpenDmTicketByUser(creatorId) {
        try {
            return this.db.prepare(
                "SELECT * FROM tickets WHERE creator_id = ? AND ticket_mode = 'dm' AND status = 'open' ORDER BY created_at DESC LIMIT 1"
            ).get(creatorId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting open DM ticket:', err);
            return null;
        }
    }

    getOpenDmTicketById(ticketId) {
        try {
            return this.db.prepare(
                "SELECT * FROM tickets WHERE id = ? AND ticket_mode = 'dm' AND status = 'open'"
            ).get(ticketId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting open DM ticket by ID:', err);
            return null;
        }
    }

    addTicketMessage(ticketId, authorId, authorName, authorType, content, discordMessageId = null) {
        try {
            const result = this.db.prepare(`
                INSERT INTO ticket_messages
                    (ticket_id, author_id, author_name, author_type, content, discord_message_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ticketId, authorId, authorName, authorType, content, discordMessageId);
            this.checkpointWAL();
            return result.lastInsertRowid;
        } catch (err) {
            const { error } = require('./Console');
            error('Error adding ticket message:', err);
            return null;
        }
    }

    getTicketMessages(ticketId, afterId = 0) {
        try {
            return this.db.prepare(
                'SELECT * FROM ticket_messages WHERE ticket_id = ? AND id > ? ORDER BY id ASC'
            ).all(ticketId, afterId);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting ticket messages:', err);
            return [];
        }
    }

    getTicketsByGuild(guildId, status = null) {
        try {
            if (status) {
                return this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY created_at DESC').all(guildId, status);
            }
            return this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting tickets by guild:', err);
            return [];
        }
    }

    getTicketsByUser(creatorId) {
        try {
            return this.db.prepare('SELECT * FROM tickets WHERE creator_id = ? ORDER BY created_at DESC').all(creatorId);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting tickets by user:', err);
            return [];
        }
    }

    getAllTickets(limit = null) {
        try {
            if (limit === null) {
                return this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC').all();
            }
            return this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?').all(limit);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting all tickets:', err);
            return [];
        }
    }

    updateTicket(ticketId, data) {
        try {
            const fields = [];
            const values = [];
            for (const [key, value] of Object.entries(data)) {
                if (key !== 'id') {
                    fields.push(`${key} = ?`);
                    values.push(value);
                }
            }
            if (fields.length === 0) return;
            values.push(ticketId);
            this.db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error updating ticket:', err);
        }
    }

    closeTicket(ticketId, closedBy, closedByName) {
        try {
            const result = this.db.prepare(
                'UPDATE tickets SET status = ?, closed_by = ?, closed_by_name = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run('closed', closedBy, closedByName, ticketId);
            this.checkpointWAL();
            return result.changes > 0;
        } catch (err) {
            const { error } = require('./Console');
            error('Error closing ticket:', err);
            return false;
        }
    }

    // Transcript Methods
    saveTranscript(ticketId, guildId, transcriptHtml, messageCount) {
        try {
            this.db.prepare(
                'INSERT OR REPLACE INTO ticket_transcripts (ticket_id, guild_id, transcript_html, message_count) VALUES (?, ?, ?, ?)'
            ).run(ticketId, guildId, transcriptHtml, messageCount);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error saving transcript:', err);
        }
    }

    getTranscript(ticketId) {
        try {
            return this.db.prepare('SELECT * FROM ticket_transcripts WHERE ticket_id = ?').get(ticketId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting transcript:', err);
            return null;
        }
    }

    getTranscriptsByGuild(guildId) {
        try {
            return this.db.prepare(
                `SELECT t.*, tk.creator_name, tk.subject, tk.status, tk.created_at as ticket_created, tk.closed_at
                 FROM ticket_transcripts t
                 JOIN tickets tk ON t.ticket_id = tk.id
                 WHERE t.guild_id = ?
                 ORDER BY t.created_at DESC`
            ).all(guildId);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting transcripts by guild:', err);
            return [];
        }
    }

    getTicketStats(guildId) {
        try {
            const total = this.db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?').get(guildId)?.count || 0;
            const open = this.db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND status = ?').get(guildId, 'open')?.count || 0;
            const closed = this.db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND status = ?').get(guildId, 'closed')?.count || 0;
            return { total, open, closed };
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting ticket stats:', err);
            return { total: 0, open: 0, closed: 0 };
        }
    }

    // Chat Mute Methods
    setChatMute(userId, mutedBy, mutedByName, reason, expiresAt) {
        try {
            const result = this.db.prepare(
                'INSERT OR REPLACE INTO chat_mutes (user_id, muted_by, muted_by_name, reason, expires_at) VALUES (?, ?, ?, ?, ?)'
            ).run(userId, mutedBy, mutedByName, reason || null, expiresAt || null);
            this.checkpointWAL();
            return result.changes > 0;
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting chat mute:', err);
            return false;
        }
    }

    getChatMute(userId) {
        try {
            return this.db.prepare('SELECT * FROM chat_mutes WHERE user_id = ?').get(userId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting chat mute:', err);
            return null;
        }
    }

    removeChatMute(userId) {
        try {
            const result = this.db.prepare('DELETE FROM chat_mutes WHERE user_id = ?').run(userId);
            this.checkpointWAL();
            return result.changes > 0;
        } catch (err) {
            const { error } = require('./Console');
            error('Error removing chat mute:', err);
            return false;
        }
    }

    getAllChatMutes() {
        try {
            return this.db.prepare('SELECT * FROM chat_mutes ORDER BY created_at DESC').all();
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting all chat mutes:', err);
            return [];
        }
    }

    deleteBridgeMessage(messageId) {
        try {
            const result = this.db.prepare('DELETE FROM chat_bridge_messages WHERE id = ?').run(messageId);
            this.checkpointWAL();
            return result.changes > 0;
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting bridge message:', err);
            return false;
        }
    }

    // User lookup by AGID (Path of Titans Alderon Games ID)
    getUserByAgid(agid) {
        try {
            return this.db.prepare('SELECT * FROM users WHERE agid = ?').get(agid) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting user by AGID:', err);
            return null;
        }
    }

    // Game Player Methods (in-game presence tracked from PoT events)
    upsertGamePlayer(agid, playerName, serverName, online = 1) {
        try {
            this.db.prepare(`
                INSERT INTO game_players (agid, player_name, server_name, online, last_seen)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(agid) DO UPDATE SET
                    player_name = excluded.player_name,
                    server_name = excluded.server_name,
                    online = excluded.online,
                    last_seen = CURRENT_TIMESTAMP
            `).run(agid, playerName || null, serverName || null, online ? 1 : 0);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error upserting game player:', err);
        }
    }

    setGamePlayerOnline(agid, online) {
        try {
            this.db.prepare(
                'UPDATE game_players SET online = ?, last_seen = CURRENT_TIMESTAMP WHERE agid = ?'
            ).run(online ? 1 : 0, agid);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting game player online state:', err);
        }
    }

    getGamePlayer(agid) {
        try {
            return this.db.prepare('SELECT * FROM game_players WHERE agid = ?').get(agid) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting game player:', err);
            return null;
        }
    }

    getRecentGamePlayers(limit = 50) {
        try {
            return this.db.prepare(
                'SELECT * FROM game_players ORDER BY last_seen DESC LIMIT ?'
            ).all(limit);
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting recent game players:', err);
            return [];
        }
    }

    getOnlineGamePlayers() {
        try {
            return this.db.prepare(
                'SELECT * FROM game_players WHERE online = 1 ORDER BY last_seen DESC'
            ).all();
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting online game players:', err);
            return [];
        }
    }

    // Link Verification Methods (Discord <-> AGID whisper-code flow)
    createLinkVerification(discordId, agid, code, expiresAt) {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO link_verifications (discord_id, agid, code, expires_at)
                VALUES (?, ?, ?, ?)
            `).run(discordId, agid, code, expiresAt);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating link verification:', err);
        }
    }

    getLinkVerification(discordId) {
        try {
            return this.db.prepare('SELECT * FROM link_verifications WHERE discord_id = ?').get(discordId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting link verification:', err);
            return null;
        }
    }

    deleteLinkVerification(discordId) {
        try {
            this.db.prepare('DELETE FROM link_verifications WHERE discord_id = ?').run(discordId);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting link verification:', err);
        }
    }

    // Role Color Methods
    getRoleColor(level) {
        try {
            return this.db.prepare('SELECT * FROM role_colors WHERE level = ?').get(level) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting role color:', err);
            return null;
        }
    }

    getAllRoleColors() {
        try {
            return this.db.prepare('SELECT * FROM role_colors ORDER BY level DESC').all();
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting all role colors:', err);
            return [];
        }
    }

    setRoleColor(level, label, color, discordRoleId) {
        try {
            this.db.prepare(
                'INSERT OR REPLACE INTO role_colors (level, label, color, discord_role_id) VALUES (?, ?, ?, ?)'
            ).run(level, label, color, discordRoleId || null);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error setting role color:', err);
        }
    }

    getRoleColorByDiscordRoleId(roleId) {
        try {
            return this.db.prepare('SELECT * FROM role_colors WHERE discord_role_id = ?').get(roleId) || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting role color by Discord role ID:', err);
            return null;
        }
    }

    // Client Token Methods (for standalone chat client auth)
    createClientToken(token, data) {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO client_tokens
                (token, discord_id, username, global_name, discriminator, avatar, is_staff, staff_level, staff_label, roles, refresh_token, discord_access_token, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                DatabaseManager.hashToken(token),
                data.discord_id,
                data.username,
                data.global_name || null,
                data.discriminator || null,
                data.avatar || null,
                data.is_staff ? 1 : 0,
                data.staff_level || 0,
                data.staff_label || null,
                JSON.stringify(data.roles || []),
                this._encrypt(data.refresh_token || null),
                this._encrypt(data.discord_access_token || null),
                data.expires_at
            );
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating client token:', err);
        }
    }

    getClientToken(token) {
        try {
            const result = this.db.prepare('SELECT * FROM client_tokens WHERE token = ?').get(DatabaseManager.hashToken(token));
            if (result) {
                result.roles = JSON.parse(result.roles || '[]');
                result.refresh_token = this._decrypt(result.refresh_token);
                result.discord_access_token = this._decrypt(result.discord_access_token);
            }
            return result || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error getting client token:', err);
            return null;
        }
    }

    deleteClientToken(token) {
        try {
            this.db.prepare('DELETE FROM client_tokens WHERE token = ?').run(DatabaseManager.hashToken(token));
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting client token:', err);
        }
    }

    deleteExpiredClientTokens() {
        try {
            this.db.prepare('DELETE FROM client_tokens WHERE expires_at < ?').run(new Date().toISOString());
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting expired client tokens:', err);
        }
    }

    // Client OAuth State Methods (CSRF protection for cross-context auth flow)
    createOAuthState(state) {
        try {
            this.db.prepare('INSERT INTO client_oauth_states (state, created_at) VALUES (?, ?)').run(state, new Date().toISOString());
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating OAuth state:', err);
        }
    }

    consumeOAuthState(state) {
        try {
            const row = this.db.prepare('SELECT * FROM client_oauth_states WHERE state = ?').get(state);
            if (row) {
                this.db.prepare('DELETE FROM client_oauth_states WHERE state = ?').run(state);
                this.checkpointWAL();
                // Reject states older than 10 minutes (created_at stored as ISO string)
                const created = new Date(row.created_at);
                if (Date.now() - created.getTime() > 10 * 60 * 1000) return null;
            }
            return row || null;
        } catch (err) {
            const { error } = require('./Console');
            error('Error consuming OAuth state:', err);
            return null;
        }
    }

    deleteExpiredOAuthStates() {
        try {
            const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            this.db.prepare('DELETE FROM client_oauth_states WHERE created_at < ?').run(cutoff);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting expired OAuth states:', err);
        }
    }

    // One-Time Auth Code Methods (exchanged by the standalone client for a token)
    createAuthCode(code, token) {
        try {
            this.db.prepare('INSERT INTO client_auth_codes (code, token, created_at) VALUES (?, ?, ?)').run(code, token, new Date().toISOString());
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error creating auth code:', err);
        }
    }

    consumeAuthCode(code) {
        try {
            const row = this.db.prepare('SELECT * FROM client_auth_codes WHERE code = ?').get(code);
            if (!row) return null;
            this.db.prepare('DELETE FROM client_auth_codes WHERE code = ?').run(code);
            this.checkpointWAL();
            // Codes are valid for 5 minutes and single-use
            if (Date.now() - new Date(row.created_at).getTime() > 5 * 60 * 1000) return null;
            return row.token;
        } catch (err) {
            const { error } = require('./Console');
            error('Error consuming auth code:', err);
            return null;
        }
    }

    deleteExpiredAuthCodes() {
        try {
            const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            this.db.prepare('DELETE FROM client_auth_codes WHERE created_at < ?').run(cutoff);
            this.checkpointWAL();
        } catch (err) {
            const { error } = require('./Console');
            error('Error deleting expired auth codes:', err);
        }
    }

    close() {
        this.db.close();
    }
}

module.exports = DatabaseManager;

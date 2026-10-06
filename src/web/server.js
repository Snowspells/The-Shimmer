const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const xss = require('xss');
const { EmbedBuilder } = require('discord.js');
const { info, error, success, debug } = require('../utils/Console');
const { resolveWebPermissions, noWebPermissions, attachWebPermissions } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const ticketRoutes = require('./routes/tickets');
const chatRoutes = require('./routes/chat');
const suggestionRoutes = require('./routes/suggestions');
const reactionRoleRoutes = require('./routes/reaction-roles');
const clientAuthRoutes = require('./routes/client-auth');

class WebServer {
    constructor(client) {
        this.client = client;
        this.app = express();
        this.port = process.env.WEB_PORT || 3000;
        this.host = process.env.WEB_HOST || '0.0.0.0';
        const tlsKeyPath = process.env.WEB_TLS_KEY_PATH;
        const tlsCertPath = process.env.WEB_TLS_CERT_PATH;
        if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
            throw new Error('Configure both WEB_TLS_KEY_PATH and WEB_TLS_CERT_PATH to enable HTTPS.');
        }
        this.httpsEnabled = Boolean(tlsKeyPath && tlsCertPath);
        this.protocol = this.httpsEnabled ? 'https' : 'http';
        this.httpServer = this.httpsEnabled
            ? https.createServer({
                key: fs.readFileSync(path.resolve(tlsKeyPath)),
                cert: fs.readFileSync(path.resolve(tlsCertPath))
            }, this.app)
            : http.createServer(this.app);
        this.wsClients = new Map();
        this.wsConnectionsByIp = new Map();   // IP -> count (DDoS: max connections per IP)
        this.wsConnectionAttempts = new Map(); // IP -> { count, resetAt } (DDoS: connection rate)
        this.chatCooldowns = new Map();        // userId -> last message timestamp (slowmode)
        this.CHAT_COOLDOWN_MS = 1500;          // 1.5s between messages per user
        this.MAX_WS_PER_IP = 5;                // Max simultaneous WS connections per IP
        this.MAX_WS_CONNECTS_PER_MIN = 20;     // Max WS connection attempts per IP per minute
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.client.on('messageCreate', message => this.relayAiChannelMessage(message));
    }

    setupMiddleware() {
        this.app.set('trust proxy', 'loopback');
        this.app.set('view engine', 'ejs');
        this.app.set('views', path.join(__dirname, 'views'));

        // Security headers
        this.app.use(helmet({
            hsts: this.httpsEnabled ? { maxAge: 31536000, includeSubDomains: true } : false,
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", 'https://cdn.discordapp.com', 'data:'],
                    connectSrc: ["'self'", 'ws:', 'wss:'],
                    frameSrc: ["'self'"],
                    fontSrc: ["'self'"],
                    'upgrade-insecure-requests': this.httpsEnabled ? [] : null,
                }
            }
        }));

        // Rate limiting
        const generalLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 200,
            standardHeaders: true,
            legacyHeaders: false,
            message: { error: 'Too many requests, please try again later.' }
        });

        const authLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 15,
            standardHeaders: true,
            legacyHeaders: false,
            message: { error: 'Too many login attempts, please try again later.' }
        });

        const apiLimiter = rateLimit({
            windowMs: 1 * 60 * 1000,
            max: 60,
            standardHeaders: true,
            legacyHeaders: false,
            message: { error: 'API rate limit exceeded.' }
        });

        this.app.use(generalLimiter);

        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));
        this.app.use(express.static(path.join(__dirname, 'public')));

        this.sessionMiddleware = session({
            secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
            resave: false,
            saveUninitialized: false,
            name: 'echo.sid',
            cookie: {
                secure: process.env.NODE_ENV === 'production' || this.httpsEnabled,
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 24 * 60 * 60 * 1000 // 24 hours
            }
        });
        this.app.use(this.sessionMiddleware);

        // Apply stricter rate limits to sensitive routes
        this.app.use('/auth', authLimiter);
        this.app.use('/api', apiLimiter);

        this.app.use((req, res, next) => {
            req.discordClient = this.client;
            req.db = this.client.database;
            req.webServer = this;
            res.locals.user = req.session.user || null;
            res.locals.isLinkedMember = Boolean(
                req.session.user && this.client.database.getUserByDiscordId(req.session.user.id)
            );
            res.locals.aiChatChannelConfigured = Boolean(
                process.env.AI_CHAT_CHANNEL_ID || process.env.ALLOWED_CHANNEL_ID
            );
            next();
        });
    }

    setupRoutes() {
        this.app.get('/', attachWebPermissions, (req, res) => {
            res.render('index', {
                botName: 'The Shimmer',
                user: req.session.user || null
            });
        });

        this.app.use('/auth', authRoutes);
        this.app.use('/dashboard', dashboardRoutes);
        this.app.use('/admin', adminRoutes);
        this.app.use('/api', apiRoutes);
        this.app.use('/tickets', ticketRoutes);
        this.app.use('/chat', chatRoutes);
        this.app.use('/suggestions', suggestionRoutes);
        this.app.use('/admin/reaction-roles', reactionRoleRoutes);
        this.app.use('/auth/client', clientAuthRoutes);

        this.app.use((req, res) => {
            res.status(404).render('error', {
                title: '404 - Not Found',
                message: 'The page you are looking for does not exist.',
                user: req.session.user || null
            });
        });

        this.app.use((err, req, res, _next) => {
            error('Web server error:', err);
            res.status(500).render('error', {
                title: '500 - Server Error',
                message: 'An internal server error occurred.',
                user: req.session.user || null
            });
        });
    }

    getClientIp(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    }

    checkWsConnectionRate(ip) {
        const now = Date.now();
        const record = this.wsConnectionAttempts.get(ip);
        if (!record || now > record.resetAt) {
            this.wsConnectionAttempts.set(ip, { count: 1, resetAt: now + 60000 });
            return true;
        }
        record.count++;
        return record.count <= this.MAX_WS_CONNECTS_PER_MIN;
    }

    setupWebSocket() {
        this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws/chat' });

        this.wss.on('connection', (ws, req) => {
            const ip = this.getClientIp(req);

            // DDoS: Check connection rate per IP
            if (!this.checkWsConnectionRate(ip)) {
                debug(`WebSocket rate limited (connection flood): ${ip}`);
                ws.close(4008, 'Too many connection attempts');
                return;
            }

            // DDoS: Check max simultaneous connections per IP
            const currentCount = this.wsConnectionsByIp.get(ip) || 0;
            if (currentCount >= this.MAX_WS_PER_IP) {
                debug(`WebSocket max connections reached for IP: ${ip}`);
                ws.close(4008, 'Too many connections');
                return;
            }
            this.wsConnectionsByIp.set(ip, currentCount + 1);

            // Try token-based auth first (for standalone client)
            const url = new URL(req.url, 'http://localhost');
            const bearerToken = url.searchParams.get('token');

            if (bearerToken) {
                this.authenticateWithToken(ws, req, ip, bearerToken).catch(err => {
                    error('WebSocket token authentication failed:', err);
                    this.wsConnectionsByIp.set(ip, Math.max(0, (this.wsConnectionsByIp.get(ip) || 1) - 1));
                    ws.close(1011, 'Authentication failed');
                });
            } else {
                // Fall back to session-based auth (for web browser)
                const mockRes = { on() {}, end() {}, writeHead() {} };
                this.sessionMiddleware(req, mockRes, () => {
                    const user = req.session?.user;
                    if (!user) {
                        this.wsConnectionsByIp.set(ip, (this.wsConnectionsByIp.get(ip) || 1) - 1);
                        ws.close(4001, 'Not authenticated');
                        return;
                    }

                    resolveWebPermissions({ discordClient: this.client }, user).then(permissions => {
                        const linkedUser = this.client.database.getUserByDiscordId(user.id);
                        const roleColor = this.client.database.getRoleColor(permissions.staffLevel);
                        const enrichedUser = {
                            ...user,
                            ...permissions,
                            staffLevel: permissions.staffLevel,
                            staffLabel: permissions.staffLabel,
                            webPermissions: permissions,
                            agid: linkedUser?.agid || null,
                            roleColor: roleColor?.color || '#8b949e',
                            source: 'web'
                        };
                        this.registerClient(ws, enrichedUser, ip, 'web');
                    }).catch(err => {
                        error(`Could not refresh Discord staff role for WebSocket user ${user.id}:`, err);
                        const permissions = noWebPermissions();
                        this.registerClient(ws, {
                            ...user,
                            ...permissions,
                            webPermissions: permissions,
                            roleColor: '#8b949e',
                            source: 'web'
                        }, ip, 'web');
                    });
                });
            }
        });
    }

    handleChatMessage(clientId, msg) {
        const client = this.wsClients.get(clientId);
        if (!client) return;

        const { user } = client;

        // Check if user is muted
        const muteInfo = this.client.database.getChatMute(user.id);
        if (muteInfo) {
            const now = new Date();
            const expiresAt = muteInfo.expires_at ? new Date(muteInfo.expires_at) : null;
            if (!expiresAt || now < expiresAt) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: `You are muted${expiresAt ? ` until ${expiresAt.toLocaleString()}` : ''}: ${muteInfo.reason || 'No reason given'}`
                }));
                return;
            }
            // Mute expired, remove it
            this.client.database.removeChatMute(user.id);
        }

        if (msg.type === 'message') {
            const content = xss(msg.content?.trim() || '');
            if (!content || content.length === 0 || content.length > 1900) return;

            // Slowmode: enforce per-user cooldown
            const now = Date.now();
            const lastMsg = this.chatCooldowns.get(user.id) || 0;
            if (now - lastMsg < this.CHAT_COOLDOWN_MS) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'You are sending messages too fast. Please slow down.'
                }));
                return;
            }
            this.chatCooldowns.set(user.id, now);

            this.relayToAiChatChannel(user, content).catch(err => {
                error(`Website chat delivery failed for ${user.id}:`, err);
                if (client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Could not deliver your message to the Discord chat channel.'
                    }));
                }
            });
        }
    }

    getAiChatChannelId() {
        return process.env.AI_CHAT_CHANNEL_ID || process.env.ALLOWED_CHANNEL_ID || null;
    }

    getAiChannelMessage(message) {
        const webEmbed = message.author.id === this.client.user.id
            ? message.embeds.find(embed => embed.footer?.text?.startsWith('echo-web-chat:'))
            : null;
        const content = webEmbed
            ? webEmbed.description || ''
            : [
                message.content,
                ...[...message.attachments.values()].map(attachment =>
                    `Attachment: ${attachment.name || 'file'} (${attachment.url})`
                ),
                ...message.embeds.map(embed => [embed.title, embed.description].filter(Boolean).join('\n'))
            ].filter(Boolean).join('\n\n');
        if (!content) return null;

        const webUserId = webEmbed?.footer?.text.slice('echo-web-chat:'.length) || null;
        return {
            id: message.id,
            source: webEmbed ? 'web' : 'discord',
            author_name: webEmbed?.author?.name || message.author.globalName || message.author.username,
            author_id: webUserId || message.author.id,
            content,
            timestamp: message.createdAt?.toISOString() || new Date().toISOString()
        };
    }

    async sendAiChannelHistory(ws) {
        const channelId = this.getAiChatChannelId();
        if (!channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Discord chat channel is not configured.' }));
            return;
        }
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.messages) {
            throw new Error(`Configured AI chat channel ${channelId} is not an accessible text channel.`);
        }
        const fetched = await channel.messages.fetch({ limit: 50 });
        const messages = [...fetched.values()].reverse()
            .map(message => this.getAiChannelMessage(message))
            .filter(Boolean);
        ws.send(JSON.stringify({ type: 'history', channel_chat: true, messages }));
    }

    async relayToAiChatChannel(user, content) {
        const channelId = this.getAiChatChannelId();
        if (!channelId) throw new Error('AI_CHAT_CHANNEL_ID is required for website chat.');
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.send) {
            throw new Error(`Configured AI chat channel ${channelId} is not an accessible text channel.`);
        }

        const displayName = user.displayName || user.username;
        const embed = new EmbedBuilder()
            .setColor(0x6e56cf)
            .setAuthor({
                name: displayName,
                ...(user.avatar ? { iconURL: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` } : {})
            })
            .setDescription(content)
            .setFooter({ text: `echo-web-chat:${user.id}` })
            .setTimestamp();
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    relayAiChannelMessage(message) {
        const channelId = this.getAiChatChannelId();
        if (!channelId || message.channel.id !== channelId) return;
        const formatted = this.getAiChannelMessage(message);
        if (!formatted) return;
        this.broadcastToWebClients({ type: 'message', channel_chat: true, ...formatted });
    }

    async authenticateWithToken(ws, req, ip, token) {
        const tokenData = this.client.database.getClientToken(token);
        if (!tokenData || new Date(tokenData.expires_at) < new Date()) {
            this.wsConnectionsByIp.set(ip, (this.wsConnectionsByIp.get(ip) || 1) - 1);
            ws.close(4001, 'Invalid or expired token');
            return;
        }

        const linkedUser = this.client.database.getUserByDiscordId(tokenData.discord_id);
        let permissions;
        try {
            permissions = await resolveWebPermissions({ discordClient: this.client }, { id: tokenData.discord_id });
        } catch (err) {
            error(`Could not resolve Discord permissions for WebSocket user ${tokenData.discord_id}:`, err);
            permissions = noWebPermissions();
        }
        const effectiveLevel = permissions.staffLevel;
        const effectiveLabel = permissions.staffLabel;
        const roleColor = this.client.database.getRoleColor(effectiveLevel);

        const user = {
            id: tokenData.discord_id,
            username: tokenData.username,
            displayName: tokenData.global_name || tokenData.username,
            discriminator: tokenData.discriminator,
            avatar: tokenData.avatar,
            isStaff: permissions.isStaff,
            staffLevel: effectiveLevel,
            staffLabel: effectiveLabel,
            webPermissions: permissions,
            roles: tokenData.roles,
            agid: linkedUser?.agid || null,
            roleColor: roleColor?.color || '#8b949e',
            source: 'client'
        };

        this.registerClient(ws, user, ip, 'client');
    }

    registerClient(ws, user, ip, source) {
        const clientId = crypto.randomBytes(8).toString('hex');
        this.wsClients.set(clientId, { ws, user, ip, source });
        debug(`WebSocket connected: ${user.displayName || user.username} (${clientId}) from ${ip} via ${source}`);

        this.sendAiChannelHistory(ws).catch(err => {
            error('Could not load Discord channel history for web chat:', err);
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'error', message: 'Could not load Discord chat history.' }));
            }
        });

        // Send role colors config
        const roleColors = this.client.database.getAllRoleColors();
        ws.send(JSON.stringify({ type: 'role_colors', colors: roleColors }));

        // Send online users list and count
        this.broadcastOnlineUsers();

        ws.on('message', (data) => {
            if (data.length > 10240) {
                debug(`WebSocket oversized message from ${user.displayName || user.username}`);
                return;
            }
            try {
                const msg = JSON.parse(data.toString());
                this.handleChatMessage(clientId, msg);
            } catch (err) {
                debug(`WebSocket parse error: ${err.message}`);
            }
        });

        ws.on('close', () => {
            this.wsClients.delete(clientId);
            const ipCount = this.wsConnectionsByIp.get(ip) || 1;
            this.wsConnectionsByIp.set(ip, Math.max(0, ipCount - 1));
            debug(`WebSocket disconnected: ${user.username} (${clientId})`);
            this.broadcastOnlineUsers();
        });

        ws.on('error', (err) => {
            debug(`WebSocket error: ${err.message}`);
            this.wsClients.delete(clientId);
            const ipCount = this.wsConnectionsByIp.get(ip) || 1;
            this.wsConnectionsByIp.set(ip, Math.max(0, ipCount - 1));
        });
    }

    broadcastToWebClients(msg) {
        const data = JSON.stringify(msg);
        for (const [, client] of this.wsClients) {
            if (client.ws.readyState === 1) {
                client.ws.send(data);
            }
        }
    }

    broadcastOnlineCount() {
        const count = this.wsClients.size;
        const data = JSON.stringify({ type: 'online_count', count });
        for (const [, client] of this.wsClients) {
            if (client.ws.readyState === 1) {
                client.ws.send(data);
            }
        }
    }

    broadcastOnlineUsers() {
        const users = [];
        const seenIds = new Set();
        for (const [, client] of this.wsClients) {
            if (!seenIds.has(client.user.id)) {
                seenIds.add(client.user.id);
                users.push({
                    id: client.user.id,
                    username: client.user.displayName || client.user.username,
                    displayName: client.user.displayName || client.user.username,
                    avatar: client.user.avatar,
                    staffLevel: client.user.staffLevel || 0,
                    staffLabel: client.user.staffLabel || 'Member',
                    roleColor: client.user.roleColor || '#8b949e',
                    agid: client.user.agid || null,
                    source: client.source || 'web'
                });
            }
        }

        // Sort by staff level descending (Owner first, Member last)
        users.sort((a, b) => b.staffLevel - a.staffLevel);

        const data = JSON.stringify({ type: 'online_users', users, count: users.length });
        for (const [, client] of this.wsClients) {
            if (client.ws.readyState === 1) {
                client.ws.send(data);
            }
        }
        // Also broadcast count for legacy web clients
        this.broadcastOnlineCount();
    }

    relayToDiscord(username, content) {
        const bridgeChannelId = process.env.BRIDGE_CHANNEL_ID;
        if (!bridgeChannelId) return;

        try {
            const channel = this.client.channels?.cache?.get(bridgeChannelId);
            if (channel) {
                channel.send(`**[Web] ${username}:** ${content}`);
            }
        } catch (err) {
            debug(`Discord relay error: ${err.message}`);
        }
    }

    relayToGame(username, content, discordId) {
        // Relay into Path of Titans via RCON when configured.
        if (this.client.rcon?.isEnabled()) {
            this.client.rcon.relayChat('web', username, content)
                .catch(err => debug(`Game RCON relay error: ${err.message}`));
            return;
        }

        // Fallback: legacy HTTP webhook relay (for non-RCON game integrations).
        const gameWebhookUrl = process.env.GAME_WEBHOOK_URL;
        if (!gameWebhookUrl) return;

        fetch(gameWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': process.env.BRIDGE_API_KEY || ''
            },
            body: JSON.stringify({
                playerName: username,
                message: content,
                discordId: discordId,
                source: 'web'
            })
        }).catch(err => debug(`Game relay error: ${err.message}`));
    }

    // Called by the Discord bridge event to relay messages to web clients
    relayMessageToWeb(source, authorName, authorId, content) {
        const msg = {
            type: 'message',
            source,
            author_name: authorName,
            author_id: authorId,
            content,
            timestamp: new Date().toISOString()
        };
        this.broadcastToWebClients(msg);
    }

    start() {
        return new Promise((resolve) => {
            this.httpServer.listen(this.port, this.host, () => {
                const publicUrl = process.env.WEB_BASE_URL || `${this.protocol}://${this.host}:${this.port}`;
                success(`Web dashboard listening on ${this.host}:${this.port}; public URL: ${publicUrl}`);
                this.startTokenCleanup();
                resolve();
            });
        });
    }

    startTokenCleanup() {
        const runCleanup = () => {
            try {
                this.client.database.deleteExpiredClientTokens();
                this.client.database.deleteExpiredOAuthStates();
                this.client.database.deleteExpiredAuthCodes();
            } catch (err) {
                debug(`Token cleanup error: ${err.message}`);
            }
        };
        runCleanup();
        // Purge expired client tokens, OAuth states, and one-time codes every 10 minutes
        this.cleanupInterval = setInterval(runCleanup, 10 * 60 * 1000);
    }

    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (!this.httpServer?.listening) return Promise.resolve();

        for (const socket of this.wss?.clients || []) {
            socket.close(1001, 'Server shutting down');
        }
        this.wss?.close();

        return new Promise((resolve, reject) => {
            this.httpServer.close(err => {
                if (err) {
                    reject(err);
                    return;
                }
                info('Web server stopped.');
                resolve();
            });
        });
    }
}

module.exports = WebServer;

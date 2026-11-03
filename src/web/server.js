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
const DatabaseManager = require('../utils/Database');
const { info, error, success, debug } = require('../utils/Console');
const { createWebChatMarker, getWebChatUserId } = require('../utils/WebChatMarker');
const { resolveWebPermissions, noWebPermissions, attachWebPermissions } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const ticketRoutes = require('./routes/tickets');
const chatRoutes = require('./routes/chat');
const suggestionRoutes = require('./routes/suggestions');

const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Renders a <time> element the browser rewrites into the viewer's own timezone (see local-time.js).
function formatTimeTag(value, format = 'datetime', fallback = 'N/A') {
    if (value === null || value === undefined || value === '') return fallback;
    const text = String(value).trim();
    const date = new Date(SQLITE_UTC_TIMESTAMP.test(text) ? `${text.replace(' ', 'T')}Z` : text);
    if (Number.isNaN(date.getTime())) return fallback;
    const iso = date.toISOString();
    const shown = format === 'date' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
    return `<time class="local-time" data-format="${format}" datetime="${iso}">${shown}</time>`;
}
const bugRoutes = require('./routes/bugs');
const reactionRoleRoutes = require('./routes/reaction-roles');
const echoRoutes = require('./routes/echo');
const shopRoutes = require('./routes/shop');
const infractionRoutes = require('./routes/infractions');
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
        this.chatTypingUsers = new Map();
        this.CHAT_COOLDOWN_MS = 1500;          // 1.5s between messages per user
        this.MAX_WS_PER_IP = 5;                // Max simultaneous WS connections per IP
        this.MAX_WS_CONNECTS_PER_MIN = 20;     // Max WS connection attempts per IP per minute
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.client.on('messageCreate', message => this.relayChatChannelMessage(message));
        this.client.on('typingStart', typing => this.relayDiscordTyping(typing));
        this.client.on('messageReactionAdd', reaction => this.relayReactionUpdate(reaction));
        this.client.on('messageReactionRemove', reaction => this.relayReactionUpdate(reaction));
        this.client.on('messageReactionRemoveEmoji', reaction => this.relayReactionUpdate(reaction));
        this.client.on('messageReactionRemoveAll', message => this.relayReactionCleared(message));
        this.client.on('messageDelete', message => this.relayMessageDeleted(message));
        this.client.on('messageUpdate', (_old, message) => {
            if (message.partial) {
                message.fetch().then(full => this.relayMessageEdited(full)).catch(() => {});
            } else {
                this.relayMessageEdited(message);
            }
        });
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
                    imgSrc: ["'self'", 'https://cdn.discordapp.com', 'https://media.discordapp.net', 'data:'],
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
            res.locals.staffChatConfigured = Boolean(process.env.STAFF_CHAT_CHANNEL_ID);
            res.locals.timeTag = formatTimeTag;
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
        this.app.use('/echo', echoRoutes);
        this.app.use('/shop', shopRoutes);
        this.app.use('/infractions', infractionRoutes);
        this.app.use('/admin', adminRoutes);
        this.app.use('/api', apiRoutes);
        this.app.use('/tickets', ticketRoutes);
        this.app.use('/chat', chatRoutes);
        this.app.use('/suggestions', suggestionRoutes);
        this.app.use('/bugs', bugRoutes);
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

        // Drop half-open sockets (sleeping laptops, proxies that silently time out) so they stop
        // holding per-IP slots and so clients notice the loss and reconnect.
        this.wsHeartbeat = setInterval(() => {
            for (const socket of this.wss.clients) {
                if (socket.isAlive === false) {
                    socket.terminate();
                    continue;
                }
                socket.isAlive = false;
                socket.ping();
            }
        }, 30000);
        this.wsHeartbeat.unref?.();
        this.wss.on('close', () => clearInterval(this.wsHeartbeat));

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

            // Release the per-IP slot exactly once, whatever stage the socket dies in.
            // Sockets that close while authentication is still pending used to leak their slot,
            // eventually locking the user out with "Too many connections".
            ws.once('close', () => {
                const remaining = (this.wsConnectionsByIp.get(ip) || 1) - 1;
                if (remaining > 0) this.wsConnectionsByIp.set(ip, remaining);
                else this.wsConnectionsByIp.delete(ip);
            });
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            // Try token-based auth first (for standalone client)
            const url = new URL(req.url, 'http://localhost');
            const bearerToken = url.searchParams.get('token');

            if (bearerToken) {
                this.authenticateWithToken(ws, req, ip, bearerToken).catch(err => {
                    error('WebSocket token authentication failed:', err);
                    ws.close(1011, 'Authentication failed');
                });
            } else {
                // Fall back to session-based auth (for web browser)
                const mockRes = { on() {}, end() {}, writeHead() {} };
                this.sessionMiddleware(req, mockRes, () => {
                    const user = req.session?.user;
                    if (!user) {
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
        if (msg.type === 'select_chat') {
            const channelKey = msg.channel === 'staff' ? 'staff' : 'community';
            if (!this.canAccessChatChannel(user, channelKey)) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'You do not have access to the staff chat.'
                }));
                return;
            }
            const previousChannel = client.activeChatChannel || 'community';
            this.setChatTypingUser(
                `web:${clientId}`,
                user.id,
                user.displayName || user.username,
                'web',
                false,
                previousChannel
            );
            client.activeChatChannel = channelKey;
            this.sendChatHistory(client.ws, channelKey).catch(err => {
                error(`Could not load ${channelKey} Discord chat history:`, err);
                if (client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({
                        type: 'error',
                        message: `Could not load ${channelKey} chat history.`
                    }));
                }
            });
            this.broadcastChatTypingUsers(channelKey);
            return;
        }

        if (msg.type === 'ping') {
            client.ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }

        if (msg.type === 'unread_check') {
            this.sendChatUnreadCounts(client, msg.last_seen).catch(err => {
                error('Could not compute unread chat counts:', err);
            });
            return;
        }

        const channelKey = client.activeChatChannel || 'community';
        if (!this.canAccessChatChannel(user, channelKey)) return;
        if (msg.type === 'typing') {
            if (msg.active === true && this.client.database.getChatMute(user.id)) return;
            this.setChatTypingUser(
                `web:${clientId}`,
                user.id,
                user.displayName || user.username,
                'web',
                msg.active === true,
                channelKey
            );
            return;
        }

        // Check if user is muted
        const muteInfo = this.client.database.getChatMute(user.id);
        if (muteInfo) {
            const now = new Date();
            const expiresAt = muteInfo.expires_at ? new Date(muteInfo.expires_at) : null;
            if (!expiresAt || now < expiresAt) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: `You are muted${expiresAt ? ` until ${expiresAt.toUTCString()}` : ''}: ${muteInfo.reason || 'No reason given'}`
                }));
                return;
            }
            // Mute expired, remove it
            this.client.database.removeChatMute(user.id);
        }

        if (msg.type === 'message') {
            this.setChatTypingUser(
                `web:${clientId}`,
                user.id,
                user.displayName || user.username,
                'web',
                false,
                channelKey
            );
            // xss() escapes < and >, which would break Discord timestamps such as <t:1700000000:F>.
            const content = xss(msg.content?.trim() || '')
                .replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (match, seconds, style) => `<t:${seconds}${style ? `:${style}` : ''}>`)
                .replace(/^&gt;(?:&gt;&gt;)?(?= |$)/gm, quote => quote.replace(/&gt;/g, '>'));
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

            const replyTo = typeof msg.reply_to === 'string' && /^\d{15,22}$/.test(msg.reply_to)
                ? msg.reply_to
                : null;
            this.relayToChatChannel(user, content, channelKey, replyTo).catch(err => {
                error(`Website chat delivery failed for ${user.id}:`, err);
                if (client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({
                        type: 'error',
                        message: `Could not deliver your message to the ${channelKey} Discord chat channel.`
                    }));
                }
            });
        }
    }

    getChatChannelId(channelKey) {
        return channelKey === 'staff'
            ? process.env.STAFF_CHAT_CHANNEL_ID || null
            : this.getAiChatChannelId();
    }

    canAccessChatChannel(user, channelKey) {
        if (channelKey !== 'staff') return true;
        return Boolean(process.env.STAFF_CHAT_CHANNEL_ID) &&
            process.env.STAFF_CHAT_CHANNEL_ID !== this.getAiChatChannelId() &&
            (user.staffLevel || 0) >= DatabaseManager.STAFF_LEVELS.STAFF_IN_TRAINING;
    }

    getAiChatChannelId() {
        return process.env.AI_CHAT_CHANNEL_ID || process.env.ALLOWED_CHANNEL_ID || null;
    }

    // Maps every mention token in the content to a display name for the web client to render.
    collectMentionNames(message, content) {
        const names = {};
        for (const [, userId, roleId, channelId] of content.matchAll(/<@!?(\d{15,22})>|<@&(\d{15,22})>|<#(\d{15,22})>/g)) {
            if (roleId) {
                names[`&${roleId}`] = message.guild?.roles?.cache?.get(roleId)?.name || 'Unknown Role';
            } else if (channelId) {
                names[`#${channelId}`] = message.guild?.channels?.cache?.get(channelId)?.name
                    || this.client.channels.cache.get(channelId)?.name || 'unknown-channel';
            } else {
                const user = message.mentions?.users?.get(userId) ||
                    message.guild?.members?.cache?.get(userId)?.user ||
                    this.client.users.cache.get(userId);
                names[userId] = user?.globalName || user?.username || 'Unknown User';
            }
        }
        return names;
    }

    describeAttachments(message) {
        return [...message.attachments.values()].map(attachment => ({
            id: attachment.id,
            name: attachment.name || 'file',
            url: attachment.url,
            content_type: attachment.contentType || null,
            is_image: Boolean(attachment.contentType?.startsWith('image/')) ||
                /\.(png|jpe?g|gif|webp|avif)$/i.test(attachment.name || ''),
            spoiler: Boolean(attachment.spoiler),
            width: attachment.width || null,
            height: attachment.height || null,
            size: attachment.size || 0
        }));
    }

    describeReactions(message) {
        return [...(message.reactions?.cache?.values() || [])]
            .filter(reaction => reaction.count > 0)
            .map(reaction => ({
                name: reaction.emoji.name,
                id: reaction.emoji.id || null,
                animated: Boolean(reaction.emoji.animated),
                count: reaction.count
            }));
    }

    getAiChannelMessage(message) {
        const webEmbed = message.author.id === this.client.user.id
            ? message.embeds.find(embed => getWebChatUserId(embed))
            : null;
        const content = webEmbed
            ? webEmbed.description || ''
            : [
                message.content,
                ...message.embeds.map(embed => [embed.title, embed.description].filter(Boolean).join('\n'))
            ].filter(Boolean).join('\n\n');
        const attachments = webEmbed ? [] : this.describeAttachments(message);
        if (!content && attachments.length === 0) return null;

        const webUserId = getWebChatUserId(webEmbed);
        return {
            id: message.id,
            source: webEmbed ? 'web' : 'discord',
            author_name: webEmbed?.author?.name || message.member?.displayName || message.author.globalName || message.author.username,
            author_id: webUserId || message.author.id,
            avatar_url: webEmbed
                ? webEmbed.author?.iconURL || null
                : (message.member || message.author).displayAvatarURL({ extension: 'png', size: 64 }),
            content,
            attachments,
            mention_names: this.collectMentionNames(message, content),
            mentions_everyone: Boolean(message.mentions?.everyone),
            mentioned_user_ids: [...(message.mentions?.users?.keys() || [])],
            reactions: this.describeReactions(message),
            timestamp: message.createdAt?.toISOString() || new Date().toISOString()
        };
    }

    // Adds the data that needs an async lookup (the replied-to message) to the base payload.
    async buildChatMessage(message) {
        const payload = this.getAiChannelMessage(message);
        if (!payload) return null;
        if (!message.reference?.messageId) return payload;

        let referenced = null;
        try {
            referenced = await message.fetchReference();
        } catch {
            // The original was deleted or is outside the fetched channel.
        }
        const base = referenced ? this.getAiChannelMessage(referenced) : null;
        const replyText = base
            ? (base.content || (base.attachments.length ? '[Attachment]' : '')).replace(/\s+/g, ' ')
            : '';
        payload.reply = {
            id: message.reference.messageId,
            missing: !base,
            author_name: base?.author_name || null,
            author_id: base?.author_id || null,
            content: replyText.length > 140 ? `${replyText.slice(0, 140)}…` : replyText,
            mention_names: base?.mention_names || {}
        };
        if (base) {
            payload.mentions_reply_author = payload.mentioned_user_ids.includes(base.author_id);
        }
        return payload;
    }
    async sendAiChannelHistory(ws) {
        return this.sendChatHistory(ws, 'community');
    }

    async sendChatHistory(ws, channelKey) {
        const channelId = this.getChatChannelId(channelKey);
        if (!channelId) {
            ws.send(JSON.stringify({ type: 'error', message: `${channelKey} chat channel is not configured.` }));
            return;
        }
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.messages) {
            throw new Error(`Configured ${channelKey} chat channel ${channelId} is not an accessible text channel.`);
        }
        const fetched = await channel.messages.fetch({ limit: 50 });
        const messages = (await Promise.all([...fetched.values()].reverse()
            .map(message => this.buildChatMessage(message))))
            .filter(Boolean);
        ws.send(JSON.stringify({
            type: 'history',
            channel_chat: true,
            chat_channel: channelKey,
            messages
        }));
    }

    async sendChatUnreadCounts(client, lastSeen) {
        const isSnowflake = value => typeof value === 'string' && /^\d{1,25}$/.test(value);
        const counts = {};
        const latest = {};
        for (const channelKey of ['community', 'staff']) {
            const channelId = this.getChatChannelId(channelKey);
            if (!channelId || !this.canAccessChatChannel(client.user, channelKey)) continue;
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isTextBased() || !channel.messages) continue;
            const seenId = isSnowflake(lastSeen?.[channelKey]) ? lastSeen[channelKey] : null;
            const fetched = await channel.messages.fetch(seenId ? { after: seenId, limit: 100 } : { limit: 1 });
            const ordered = [...fetched.values()].sort((a, b) =>
                (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
            latest[channelKey] = ordered.length ? ordered[ordered.length - 1].id : seenId;
            counts[channelKey] = seenId
                ? ordered
                    .map(message => this.getAiChannelMessage(message))
                    .filter(message => message && message.author_id !== client.user.id).length
                : 0;
        }
        if (client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'unread_counts', counts, latest }));
        }
    }

    async relayToChatChannel(user, content, channelKey = 'community', replyTo = null) {
        const channelId = this.getChatChannelId(channelKey);
        if (!channelId) throw new Error(`${channelKey} chat channel is not configured.`);
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.send) {
            throw new Error(`Configured ${channelKey} chat channel ${channelId} is not an accessible text channel.`);
        }

        const displayName = user.displayName || user.username;
        const embed = new EmbedBuilder()
            .setColor(0x6e56cf)
            .setAuthor({
                name: displayName,
                ...(user.avatar ? { iconURL: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` } : {})
            })
            .setDescription(content)
            .setFooter({ text: createWebChatMarker(user.id) })
            .setTimestamp();
        await channel.send({
            embeds: [embed],
            allowedMentions: { parse: [], repliedUser: false },
            ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {})
        });
    }

    getChatKeyForChannel(channelId) {
        if (channelId && channelId === this.getAiChatChannelId()) return 'community';
        if (channelId && channelId === process.env.STAFF_CHAT_CHANNEL_ID) return 'staff';
        return null;
    }

    relayChatChannelMessage(message) {
        const channelKey = this.getChatKeyForChannel(message.channel.id);
        if (!channelKey) return;
        this.buildChatMessage(message).then(formatted => {
            if (formatted) this.broadcastChatChannelMessage(channelKey, formatted);
        }).catch(err => error(`Could not relay ${channelKey} Discord message to web chat:`, err));
    }

    // Pushes the current reaction list for a message so web clients can redraw it.
    async relayReactionUpdate(reaction) {
        try {
            if (reaction.partial) reaction = await reaction.fetch();
            const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
            const channelKey = this.getChatKeyForChannel(message.channelId);
            if (!channelKey) return;
            this.broadcastChatChannelEvent(channelKey, {
                type: 'reactions',
                message_id: message.id,
                reactions: this.describeReactions(message)
            });
        } catch (err) {
            debug(`Could not relay reaction update: ${err.message}`);
        }
    }

    relayReactionCleared(message) {
        const channelKey = this.getChatKeyForChannel(message.channelId);
        if (!channelKey) return;
        this.broadcastChatChannelEvent(channelKey, {
            type: 'reactions',
            message_id: message.id,
            reactions: this.describeReactions(message)
        });
    }

    relayMessageDeleted(message) {
        const channelKey = this.getChatKeyForChannel(message.channelId);
        if (!channelKey) return;
        this.broadcastChatChannelEvent(channelKey, { type: 'message_deleted', message_id: message.id });
    }

    relayMessageEdited(message) {
        const channelKey = this.getChatKeyForChannel(message.channelId);
        if (!channelKey) return;
        this.buildChatMessage(message).then(formatted => {
            if (formatted) this.broadcastChatChannelEvent(channelKey, { type: 'message_edited', ...formatted });
        }).catch(err => debug(`Could not relay edited message: ${err.message}`));
    }

    broadcastChatChannelEvent(channelKey, event) {
        const data = JSON.stringify({ channel_chat: true, chat_channel: channelKey, ...event });
        for (const client of this.wsClients.values()) {
            if (!this.canAccessChatChannel(client.user, channelKey) || client.ws.readyState !== 1) continue;
            client.ws.send(data);
        }
    }

    broadcastChatChannelMessage(channelKey, message) {
        const data = JSON.stringify({
            type: 'message',
            channel_chat: true,
            chat_channel: channelKey,
            ...message
        });
        for (const client of this.wsClients.values()) {
            if (!this.canAccessChatChannel(client.user, channelKey) ||
                client.ws.readyState !== 1) continue;
            client.ws.send(data);
        }
    }

    async authenticateWithToken(ws, req, ip, token) {
        const tokenData = this.client.database.getClientToken(token);
        if (!tokenData || new Date(tokenData.expires_at) < new Date()) {
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
        // The socket may have closed while permissions were being resolved.
        if (ws.readyState !== 1) return;
        const clientId = crypto.randomBytes(8).toString('hex');
        const canAccessStaffChat = this.canAccessChatChannel(user, 'staff');
        const communityChatAvailable = Boolean(this.getAiChatChannelId());
        const activeChatChannel = communityChatAvailable
            ? 'community'
            : canAccessStaffChat ? 'staff' : 'community';
        this.wsClients.set(clientId, {
            ws,
            user,
            ip,
            source,
            activeChatChannel
        });
        debug(`WebSocket connected: ${user.displayName || user.username} (${clientId}) from ${ip} via ${source}`);

        this.sendChatHistory(ws, activeChatChannel).catch(err => {
            error(`Could not load ${activeChatChannel} Discord chat history for web chat:`, err);
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Could not load ${activeChatChannel} Discord chat history.`
                }));
            }
        });
        ws.send(JSON.stringify({
            type: 'chat_config',
            community_chat_available: communityChatAvailable,
            staff_chat_available: canAccessStaffChat
        }));

        // Send role colors config
        const roleColors = this.client.database.getAllRoleColors();
        ws.send(JSON.stringify({ type: 'role_colors', colors: roleColors }));
        const initialTypingUsers = [...this.chatTypingUsers.values()]
            .filter(typing => typing.channelKey === activeChatChannel)
            .map(({ userId, username, source }) => ({ id: userId, username, source }));
        ws.send(JSON.stringify({
            type: 'typing_users',
            chat_channel: activeChatChannel,
            users: initialTypingUsers
        }));

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
            this.setChatTypingUser(
                `web:${clientId}`,
                user.id,
                user.displayName || user.username,
                'web',
                false,
                this.wsClients.get(clientId)?.activeChatChannel || 'community'
            );
            this.wsClients.delete(clientId);
            debug(`WebSocket disconnected: ${user.username} (${clientId})`);
            this.broadcastOnlineUsers();
        });

        // 'close' always follows 'error' and does the cleanup.
        ws.on('error', (err) => {
            debug(`WebSocket error: ${err.message}`);
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

    setChatTypingUser(key, userId, username, source, active, channelKey = 'community') {
        const existing = this.chatTypingUsers.get(key);
        if (existing?.timer) clearTimeout(existing.timer);

        if (!active) {
            this.chatTypingUsers.delete(key);
            this.broadcastChatTypingUsers(existing?.channelKey || channelKey);
            return;
        }

        const timer = setTimeout(() => {
            this.chatTypingUsers.delete(key);
            this.broadcastChatTypingUsers(channelKey);
        }, 6000);
        timer.unref?.();
        this.chatTypingUsers.set(key, { userId, username, source, channelKey, timer });
        this.broadcastChatTypingUsers(channelKey);
    }

    relayDiscordTyping(typing) {
        const channelKey = typing.channel?.id === this.getAiChatChannelId()
            ? 'community'
            : typing.channel?.id === process.env.STAFF_CHAT_CHANNEL_ID
                ? 'staff'
                : null;
        if (!channelKey || !typing.channel?.id || typing.user?.bot) return;
        this.setChatTypingUser(
            `discord:${channelKey}:${typing.user.id}`,
            typing.user.id,
            typing.user.globalName || typing.user.username,
            'discord',
            true,
            channelKey
        );
    }

    broadcastChatTypingUsers(channelKey = 'community') {
        const data = JSON.stringify({
            type: 'typing_users',
            chat_channel: channelKey,
            users: [...this.chatTypingUsers.values()]
                .filter(typing => typing.channelKey === channelKey)
                .map(({ userId, username, source }) => ({
                id: userId,
                username,
                source
                }))
        });
        for (const client of this.wsClients.values()) {
            if (client.activeChatChannel !== channelKey ||
                !this.canAccessChatChannel(client.user, channelKey) ||
                client.ws.readyState !== 1) continue;
            client.ws.send(data);
        }
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

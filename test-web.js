/**
 * Test harness: starts the web server with a mock Discord client
 * and seeds ticket data for testing web views.
 */
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const DatabaseManager = require('./src/utils/Database');

// Create a mock Discord client with just enough to satisfy the web server
const db = new DatabaseManager('./test-database.db');

const mockClient = {
    database: db,
    guilds: { cache: { size: 3 } }
};

// Seed test data
console.log('Seeding test data...');

const guildId = 'test-guild-123';
process.env.STAFF_GUILD_ID = guildId;

db.setTicketSettings(guildId, {
    category_id: 'cat-001',
    log_channel_id: 'log-001',
    support_role_id: 'role-001',
    welcome_message: 'Welcome to your ticket! A staff member will help you shortly.'
});

// Create open tickets
const ticket1Id = db.createTicket(guildId, 'chan-001', 'user-001', 'TestUser', 'Bot not responding in #general');
const ticket2Id = db.createTicket(guildId, 'chan-002', 'user-002', 'AnotherUser', 'How do I link my account?');
const ticket3Id = db.createTicket(guildId, 'chan-003', 'user-001', 'TestUser', 'Requesting mod access');

// Claim ticket 1
db.updateTicket(ticket1Id, { claimed_by: 'staff-001', claimed_by_name: 'StaffMember' });

// Close ticket 3 with a transcript
db.closeTicket(ticket3Id, 'staff-002', 'AdminUser');
const transcriptHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Transcript - Ticket #${ticket3Id}</title>
    <style>
        body { background: #36393f; color: #dcddde; font-family: 'Whitney', 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 20px; }
        .header { background: #2f3136; padding: 16px; border-radius: 8px; margin-bottom: 16px; }
        .header h1 { color: #fff; margin: 0 0 8px 0; font-size: 20px; }
        .header p { margin: 4px 0; color: #b9bbbe; font-size: 14px; }
        .message { display: flex; padding: 4px 16px; margin: 2px 0; }
        .message:hover { background: #32353b; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; background: #5865f2; margin-right: 16px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; flex-shrink: 0; }
        .content { flex: 1; }
        .author { color: #fff; font-weight: 500; font-size: 15px; }
        .timestamp { color: #72767d; font-size: 12px; margin-left: 8px; }
        .text { color: #dcddde; font-size: 15px; line-height: 1.375; margin-top: 2px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ticket #${ticket3Id} — Requesting mod access</h1>
        <p>Created by: TestUser (user-001)</p>
        <p>Channel: #ticket-0003</p>
        <p>Created: 2024-01-15 10:00:00</p>
    </div>
    <div class="message">
        <div class="avatar">T</div>
        <div class="content">
            <span class="author">TestUser</span>
            <span class="timestamp">01/15/2024 10:00 AM</span>
            <div class="text">Hello, I'd like to request moderator access for the server.</div>
        </div>
    </div>
    <div class="message">
        <div class="avatar">A</div>
        <div class="content">
            <span class="author">AdminUser</span>
            <span class="timestamp">01/15/2024 10:05 AM</span>
            <div class="text">Hi TestUser! I can help with that. Let me review your activity and get back to you.</div>
        </div>
    </div>
    <div class="message">
        <div class="avatar">A</div>
        <div class="content">
            <span class="author">AdminUser</span>
            <span class="timestamp">01/15/2024 10:15 AM</span>
            <div class="text">Your request has been approved! I'll close this ticket now.</div>
        </div>
    </div>
</body>
</html>`;
db.saveTranscript(ticket3Id, guildId, transcriptHtml, 3);

// Create test users
db.createUser('user-001', 'AGID-TEST-001', 500, ['sword', 'shield']);
db.createUser('staff-001', 'AGID-STAFF-001', 1000, []);

// Create bridge messages
db.logBridgeMessage('discord', 'TestUser', 'user-001', 'Hello from Discord!');
db.logBridgeMessage('game', 'GamePlayer', null, 'Hey there from the game!');
db.logBridgeMessage('web', 'WebUser', 'user-003', 'Chatting from the website!');

console.log(`Created tickets: #${ticket1Id} (open, claimed), #${ticket2Id} (open), #${ticket3Id} (closed with transcript)`);

// Build Express app manually to control route ordering
const app = express();
const port = process.env.WEB_PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'web', 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src', 'web', 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Mock webServer for chat moderation routes
const mockWebServer = {
    wsClients: new Map(),
    broadcastToWebClients() {}
};

// Inject mock client/db into every request
app.use((req, res, next) => {
    req.discordClient = mockClient;
    req.db = db;
    req.webServer = mockWebServer;
    res.locals.user = req.session.user || null;
    next();
});

// ---- Test login routes (BEFORE real routes) ----
app.get('/test/login-staff', (req, res) => {
    req.session.user = {
        id: 'staff-001',
        username: 'StaffMember',
        discriminator: '0001',
        avatar: null,
        isStaff: true,
        staffLevel: 3,
        staffLabel: 'Administrator',
        roles: []
    };
    res.redirect('/');
});

app.get('/test/login-user', (req, res) => {
    req.session.user = {
        id: 'user-001',
        username: 'TestUser',
        discriminator: '0002',
        avatar: null,
        isStaff: false,
        staffLevel: 0,
        staffLabel: null,
        roles: []
    };
    res.redirect('/');
});

app.get('/test/login-other', (req, res) => {
    req.session.user = {
        id: 'user-999',
        username: 'OtherUser',
        discriminator: '9999',
        avatar: null,
        isStaff: false,
        staffLevel: 0,
        staffLabel: null,
        roles: []
    };
    res.redirect('/');
});

app.get('/test/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ---- Real routes ----
app.get('/', (req, res) => {
    res.render('index', {
        botName: 'The Shimmer',
        user: req.session.user || null
    });
});

const authRoutes = require('./src/web/routes/auth');
const dashboardRoutes = require('./src/web/routes/dashboard');
const adminRoutes = require('./src/web/routes/admin');
const apiRoutes = require('./src/web/routes/api');
const ticketRoutes = require('./src/web/routes/tickets');
const chatRoutes = require('./src/web/routes/chat');

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/tickets', ticketRoutes);
app.use('/chat', chatRoutes);

// 404 catch-all
app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Not Found',
        message: 'The page you are looking for does not exist.',
        user: req.session.user || null
    });
});

// Error handler
app.use((err, req, res, _next) => {
    console.error('Web server error:', err);
    res.status(500).render('error', {
        title: '500 - Server Error',
        message: 'An internal server error occurred.',
        user: req.session.user || null
    });
});

app.listen(port, () => {
    console.log(`Test web server running at http://localhost:${port}`);
    console.log('Login as staff:  http://localhost:3000/test/login-staff');
    console.log('Login as user:   http://localhost:3000/test/login-user');
    console.log('Login as other:  http://localhost:3000/test/login-other');
    console.log('Logout:          http://localhost:3000/test/logout');
});

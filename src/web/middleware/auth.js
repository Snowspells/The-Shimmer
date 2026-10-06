const DatabaseManager = require('../../utils/Database');
const { resolveStaffLevel } = require('../../utils/StaffAccess');
const { error, warn } = require('../../utils/Console');

const STAFF_LEVELS = DatabaseManager.STAFF_LEVELS;

const WEB_PERMISSIONS = Object.freeze({
    VIEW_STAFF_PANEL: 'canViewStaffPanel',
    MANAGE_CHAT: 'canManageChat',
    MANAGE_SERVER: 'canManageServer',
    KICK_PLAYERS: 'canKickPlayers',
    BAN_PLAYERS: 'canBanPlayers',
    MANAGE_TICKETS: 'canManageTickets',
    MANAGE_ECONOMY: 'canManageEconomy',
    REFRESH_COMMANDS: 'canRefreshCommands'
});

function resolveUser(req) {
    if (req.session.user) return req.session.user;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const tokenData = req.db.getClientToken(token);
        if (tokenData && new Date(tokenData.expires_at) >= new Date()) {
            return {
                id: tokenData.discord_id,
                username: tokenData.username,
                displayName: tokenData.global_name || tokenData.username,
                discriminator: tokenData.discriminator,
                avatar: tokenData.avatar,
                isStaff: !!tokenData.is_staff,
                staffLevel: tokenData.staff_level || 0,
                staffLabel: tokenData.staff_label || null,
                roles: tokenData.roles
            };
        }
    }

    return null;
}

async function resolveWebPermissions(req, user) {
    const staffLevel = await resolveStaffLevel(req.discordClient, user.id);
    const isStaffInTraining = staffLevel >= STAFF_LEVELS.STAFF_IN_TRAINING;
    const isStaff = staffLevel >= STAFF_LEVELS.STAFF;
    const isOwner = staffLevel >= STAFF_LEVELS.OWNER;
    const isDeveloper = staffLevel >= STAFF_LEVELS.DEVELOPER;

    return {
        canViewStaffPanel: isStaff,
        canManageChat: isStaff,
        canManageServer: isStaff,
        canKickPlayers: isStaff,
        canBanPlayers: isStaff,
        canManageTickets: isStaffInTraining,
        canManageEconomy: isStaff,
        canRefreshCommands: isOwner,
        canManageAllCommands: isDeveloper,
        staffLevel,
        staffLabel: DatabaseManager.STAFF_LABELS[staffLevel] || 'Member',
        isStaff: isStaffInTraining
    };
}

function noWebPermissions() {
    return {
        canViewStaffPanel: false,
        canManageChat: false,
        canManageServer: false,
        canKickPlayers: false,
        canBanPlayers: false,
        canManageTickets: false,
        canManageEconomy: false,
        canRefreshCommands: false,
        canManageAllCommands: false,
        staffLevel: 0,
        staffLabel: 'Member',
        isStaff: false
    };
}

function attachWebPermissions(req, _res, next) {
    const user = resolveUser(req);
    if (!user) return next();

    resolveWebPermissions(req, user).then(permissions => {
        req.webPermissions = permissions;
        req.session.user = { ...user, ...permissions, webPermissions: permissions };
        next();
    }).catch(err => {
        warn(`Could not refresh Discord role permissions for ${user.id}; hiding staff-only controls: ${err.message}`);
        const permissions = noWebPermissions();
        req.webPermissions = permissions;
        req.session.user = { ...user, ...permissions, webPermissions: permissions };
        next();
    });
}

function sendPermissionResolutionError(req, res, user, err) {
    error(`Could not resolve current Discord permissions for ${user.id}:`, err);
    if (req.headers.authorization || req.headers.accept?.includes('application/json')) {
        return res.status(503).json({ error: 'Could not verify Discord permissions. Please try again.' });
    }
    return res.status(503).render('error', {
        title: '503 - Permission Check Failed',
        message: 'Could not verify your current Discord permissions. Please try again.',
        user
    });
}

function requireAuth(req, res, next) {
    const user = resolveUser(req);
    if (!user) {
        if (req.headers.authorization || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        return res.redirect('/auth/login');
    }
    if (!req.session.user) req.session.user = user;
    next();
}

function loadWebPermissions(req, res, next) {
    const user = resolveUser(req);
    if (!user) {
        if (req.headers.authorization || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        return res.redirect('/auth/login');
    }

    resolveWebPermissions(req, user).then(permissions => {
        req.webPermissions = permissions;
        req.session.user = { ...user, ...permissions, webPermissions: permissions };
        next();
    }).catch(err => sendPermissionResolutionError(req, res, user, err));
}

function requireStaff(requiredPermission = WEB_PERMISSIONS.VIEW_STAFF_PANEL) {
    const requiredPermissions = Array.isArray(requiredPermission)
        ? requiredPermission
        : [requiredPermission];
    return (req, res, next) => {
        loadWebPermissions(req, res, () => {
            if (requiredPermissions.some(permission => req.webPermissions[permission])) return next();
            if (req.headers.authorization || req.headers.accept?.includes('application/json')) {
                return res.status(403).json({ error: 'Insufficient Discord permissions' });
            }
            return res.status(403).render('error', {
                title: '403 - Forbidden',
                message: 'Your Discord roles do not grant the required permission.',
                user: req.session.user
            });
        });
    };
}

module.exports = {
    requireAuth,
    requireStaff,
    resolveWebPermissions,
    loadWebPermissions,
    attachWebPermissions,
    noWebPermissions,
    WEB_PERMISSIONS,
    STAFF_LEVELS
};

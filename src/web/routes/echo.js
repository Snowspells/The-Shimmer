const express = require('express');
const { requireAuth, attachWebPermissions } = require('../middleware/auth');
const { EchoError } = require('../../utils/EchoManager');
const config = require('../../utils/EchoConfig');

const router = express.Router();

function manager(req) {
    return req.discordClient.echo;
}

function fail(req, res, err) {
    const known = err instanceof EchoError;
    res.status(known ? 400 : 500).render('error', {
        title: known ? 'Action Failed' : 'Error',
        message: known ? err.message : 'Something went wrong. Please try again.',
        user: req.session.user
    });
}

router.get('/', requireAuth, attachWebPermissions, (req, res) => {
    const user = req.session.user;
    const linkedAccount = req.db.getUserByDiscordId(user.id);
    if (!linkedAccount) {
        return res.render('echo', { user, linkedAccount: null, tiers: [], species: [], items: [], assignments: [] });
    }
    const echo = manager(req);
    res.render('echo', {
        user,
        linkedAccount,
        tiers: config.getTiers(),
        species: config.getSpecies(),
        items: echo.getEchoItems(user.id).map(item => ({
            ...item,
            definition: config.getEcho(item.tier, item.name)
        })),
        assignments: echo.getAssignments(user.id)
    });
});

router.post('/assign', requireAuth, (req, res) => {
    try {
        manager(req).assign(req.session.user.id, String(req.body.itemId || ''), String(req.body.species || ''));
        res.redirect('/echo');
    } catch (err) {
        fail(req, res, err);
    }
});

router.post('/unassign', requireAuth, (req, res) => {
    manager(req).unassign(req.session.user.id, String(req.body.itemId || ''));
    res.redirect('/echo');
});

module.exports = router;

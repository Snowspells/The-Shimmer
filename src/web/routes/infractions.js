const express = require('express');
const { requireAuth, attachWebPermissions } = require('../middleware/auth');
const { InfractionError, getSettings } = require('../../utils/InfractionManager');

const router = express.Router();

router.get('/', requireAuth, attachWebPermissions, (req, res) => {
    const user = req.session.user;
    const linkedAccount = req.db.getUserByDiscordId(user.id);
    const manager = req.discordClient.infractions;
    const settings = getSettings();
    res.render('infractions', {
        user,
        linkedAccount,
        settings,
        points: linkedAccount ? manager.activePoints(linkedAccount.agid) : 0,
        infractions: linkedAccount ? manager.getInfractions(linkedAccount.agid) : [],
        appeals: linkedAccount ? manager.getAppealsFor(user.id) : []
    });
});

router.post('/:id/appeal', requireAuth, (req, res) => {
    try {
        req.discordClient.infractions.fileAppeal(req.session.user.id, Number(req.params.id), req.body.message);
        res.redirect('/infractions');
    } catch (err) {
        const known = err instanceof InfractionError;
        res.status(known ? 400 : 500).render('error', {
            title: known ? 'Appeal Failed' : 'Error',
            message: known ? err.message : 'Something went wrong. Please try again.',
            user: req.session.user
        });
    }
});

module.exports = router;

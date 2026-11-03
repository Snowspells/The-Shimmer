const express = require('express');
const { requireAuth, attachWebPermissions } = require('../middleware/auth');
const { EchoError } = require('../../utils/EchoManager');
const config = require('../../utils/EchoConfig');

const router = express.Router();

router.get('/', requireAuth, attachWebPermissions, (req, res) => {
    const user = req.session.user;
    const linkedAccount = req.db.getUserByDiscordId(user.id);
    const items = config.getShopItems();
    const categories = [...new Set(items.map(item => item.category))];
    res.render('shop', {
        user,
        linkedAccount,
        categories: categories.map(name => ({ name, items: items.filter(item => item.category === name) })),
        purchased: typeof req.query.purchased === 'string' ? req.query.purchased.slice(0, 100) : null
    });
});

router.post('/buy', requireAuth, (req, res) => {
    try {
        const item = req.discordClient.echo.purchase(req.session.user.id, String(req.body.id || ''));
        res.redirect(`/shop?purchased=${encodeURIComponent(item.name)}`);
    } catch (err) {
        const known = err instanceof EchoError;
        res.status(known ? 400 : 500).render('error', {
            title: known ? 'Purchase Failed' : 'Error',
            message: known ? err.message : 'Something went wrong. Please try again.',
            user: req.session.user
        });
    }
});

module.exports = router;

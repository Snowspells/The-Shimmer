const express = require('express');
const { requireAuth, attachWebPermissions } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, attachWebPermissions, (req, res) => {
    const user = req.session.user;
    const linkedAccount = req.db.getUserByDiscordId(user.id);

    let inventory = [];
    if (linkedAccount && linkedAccount.inventory) {
        try {
            inventory = typeof linkedAccount.inventory === 'string'
                ? JSON.parse(linkedAccount.inventory)
                : linkedAccount.inventory;
        } catch {
            inventory = [];
        }
    }

    res.render('dashboard', {
        user,
        linkedAccount,
        inventory
    });
});

module.exports = router;

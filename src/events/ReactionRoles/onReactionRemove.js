const { handleReactionRole } = require('../../utils/ReactionRoles');
const Event = require('../../structure/Event');

module.exports = new Event({
    event: 'messageReactionRemove',
    once: false,
    run: (client, reaction, user) => handleReactionRole(client, reaction, user, 'remove')
}).toJSON();

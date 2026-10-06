require('dotenv').config();
const fs = require('fs');
const DiscordBot = require('./client/DiscordBot');
const WebServer = require('./web/server');
const RconManager = require('./utils/RconManager');

fs.writeFileSync('./terminal.log', '', 'utf-8');
const client = new DiscordBot();

module.exports = client;

client.connect();

const web = new WebServer(client);
client.webServer = web;
web.start();

// Path of Titans RCON integration (no-op when no RCON server is configured)
const rcon = new RconManager();
client.rcon = rcon;
rcon.connectAll();

const { error, info } = require('./utils/Console');
process.on('unhandledRejection', (err) => error('Unhandled Rejection', err));
process.on('uncaughtException', (err) => error('Uncaught Exception', err));

let shutdownPromise;
const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        info(`Shutting down after ${signal}...`);
        let shutdownFailed = false;
        const runShutdownStep = async (label, operation) => {
            try {
                await operation();
            } catch (err) {
                shutdownFailed = true;
                error(`Failed to stop ${label}:`, err);
            }
        };

        await runShutdownStep('web server', () => web.stop());
        await runShutdownStep('RCON connections', () => rcon.disconnectAll());
        client.stopStatusRotation();
        await runShutdownStep('Discord client', () => client.destroy());
        await runShutdownStep('database', () => client.database.close());
        process.exitCode = shutdownFailed ? 1 : 0;
    })();
    return shutdownPromise;
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
/**
 * Marks "bank" logic shared by the Discord slash commands (and the future
 * in-game PlayerCommand handler).
 *
 * Model:
 *   - The bot's `users.marks` column is the player's stored ("Inventory") balance.
 *   - The live game holds the character's in-game Marks, adjusted over RCON with
 *     `addmarks` / `removemarks` (targeted by AGID).
 *
 * Withdraw (Inventory -> in-game): cap is the bot balance, which the bot knows
 *   exactly. We deduct from the DB first, then `addmarks` in-game, rolling the
 *   DB change back if the RCON call fails.
 *
 * Deposit (in-game -> Inventory): we `removemarks` in-game first and only credit
 *   the bot balance if the server's reply does NOT look like a failure. PoT has
 *   no command to read a character's Marks, so the deposit cap relies on
 *   `removemarks` refusing/erroring when the character lacks the funds. The
 *   failure detection is overridable via RCON_MARKS_FAIL_REGEX.
 */

const DEFAULT_FAIL_REGEX =
    /(not enough|insufficient|do(?:es)?n'?t have|have enough|cannot|can'?t|no (?:such )?player|not found|offline|invalid|unknown|no permission|error|fail)/i;

function failRegex() {
    const env = process.env.RCON_MARKS_FAIL_REGEX;
    if (env) {
        try {
            const m = env.match(/^\/(.*)\/([a-z]*)$/i);
            return m ? new RegExp(m[1], m[2]) : new RegExp(env, 'i');
        } catch {
            /* fall through to default */
        }
    }
    return DEFAULT_FAIL_REGEX;
}

/** Heuristic: does an RCON reply indicate the marks change failed? */
function looksLikeFailure(response) {
    return failRegex().test((response || '').toString());
}

function validateAmount(amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

/**
 * Move Marks from the bot balance into the game.
 * @returns {Promise<object>} result with `ok` and a `code` on failure.
 */
async function withdraw({ client, discordId, amount, serverName = null }) {
    const n = validateAmount(amount);
    if (n === null) return { ok: false, code: 'bad_amount' };

    if (!client.rcon?.isEnabled()) return { ok: false, code: 'rcon_disabled' };

    const user = client.database.getUserByDiscordId(discordId);
    if (!user) return { ok: false, code: 'not_linked' };

    // Reserve the funds in the DB first (atomic, refuses to go negative).
    const adj = client.database.adjustMarks(discordId, -n);
    if (!adj.ok) {
        if (adj.reason === 'insufficient') {
            return { ok: false, code: 'insufficient_bank', balance: adj.marks };
        }
        if (adj.reason === 'no_user') return { ok: false, code: 'not_linked' };
        return { ok: false, code: 'db_error' };
    }

    // Push into the game; roll the DB change back on failure.
    try {
        const response = await client.rcon.addMarks(user.agid, n, serverName);
        if (looksLikeFailure(response)) {
            client.database.adjustMarks(discordId, n);
            return { ok: false, code: 'ingame_failed', response, agid: user.agid };
        }
        return { ok: true, amount: n, balance: adj.marks, agid: user.agid, response };
    } catch (err) {
        client.database.adjustMarks(discordId, n);
        return { ok: false, code: 'rcon_error', error: err.message, agid: user.agid };
    }
}

/**
 * Move Marks from the game into the bot balance.
 * @returns {Promise<object>} result with `ok` and a `code` on failure.
 */
async function deposit({ client, discordId, amount, serverName = null }) {
    const n = validateAmount(amount);
    if (n === null) return { ok: false, code: 'bad_amount' };

    if (!client.rcon?.isEnabled()) return { ok: false, code: 'rcon_disabled' };

    const user = client.database.getUserByDiscordId(discordId);
    if (!user) return { ok: false, code: 'not_linked' };

    // Take it out of the game first; only credit the bank if that succeeded.
    let response;
    try {
        response = await client.rcon.removeMarks(user.agid, n, serverName);
    } catch (err) {
        return { ok: false, code: 'rcon_error', error: err.message, agid: user.agid };
    }

    if (looksLikeFailure(response)) {
        return { ok: false, code: 'ingame_failed', response, agid: user.agid };
    }

    const adj = client.database.adjustMarks(discordId, n);
    if (!adj.ok) {
        // We removed in-game but couldn't credit — put it back in the game.
        try { await client.rcon.addMarks(user.agid, n, serverName); } catch { /* best effort */ }
        if (adj.reason === 'no_user') return { ok: false, code: 'not_linked' };
        return { ok: false, code: 'db_error' };
    }

    return { ok: true, amount: n, balance: adj.marks, agid: user.agid, response };
}

module.exports = { deposit, withdraw, looksLikeFailure };

const MARKER_START = '\u2063';
const MARKER_END = '\u2063';
const ZERO_BIT = '\u200b';
const ONE_BIT = '\u200c';

function createWebChatMarker(userId) {
    const id = String(userId);
    if (!/^\d+$/.test(id)) throw new Error('Web chat marker requires a numeric Discord user ID.');

    const bits = [...id]
        .map(digit => Number(digit).toString(2).padStart(4, '0'))
        .join('');
    const invisibleBits = [...bits].map(bit => bit === '0' ? ZERO_BIT : ONE_BIT).join('');
    return `${MARKER_START}${invisibleBits}${MARKER_END}`;
}

function getWebChatUserId(embed) {
    const footer = embed?.footer?.text;
    if (typeof footer !== 'string') return null;

    const legacyPrefix = 'echo-web-chat:';
    if (footer.startsWith(legacyPrefix)) {
        const legacyId = footer.slice(legacyPrefix.length);
        return /^\d+$/.test(legacyId) ? legacyId : null;
    }

    const match = footer.match(/\u2063([\u200b\u200c]+)\u2063/);
    if (!match || match[1].length % 4 !== 0) return null;

    const bits = [...match[1]]
        .map(bit => bit === ZERO_BIT ? '0' : '1')
        .join('');
    let userId = '';
    for (let index = 0; index < bits.length; index += 4) {
        userId += Number.parseInt(bits.slice(index, index + 4), 2).toString(10);
    }
    return /^\d+$/.test(userId) ? userId : null;
}

module.exports = { createWebChatMarker, getWebChatUserId };

(() => {
    const widget = document.getElementById('mini-chat');
    if (!widget) return;

    const panel = document.getElementById('mini-chat-panel');
    const messages = document.getElementById('mini-chat-messages');
    const status = document.getElementById('mini-chat-status');
    const typing = document.getElementById('mini-chat-typing');
    const error = document.getElementById('mini-chat-error');
    const form = document.getElementById('mini-chat-form');
    const input = document.getElementById('mini-chat-input');
    const title = document.getElementById('mini-chat-title');
    const tabs = [...widget.querySelectorAll('[data-chat-channel]')];
    const staffTab = tabs.find(tab => tab.dataset.chatChannel === 'staff');
    let activeChannel = 'community';
    let socket;
    let reconnectTimer;
    let typingStopTimer;
    let lastTypingSentAt = 0;
    let reconnectAttempts = 0;
    let heartbeatTimer;
    let lastReceivedAt = 0;
    let replyTarget = null;
    let mentionNames = {};
    const myId = widget.dataset.userId;
    const replyBar = document.getElementById('mini-chat-reply');
    const replyLabel = document.getElementById('mini-chat-reply-label');
    const replyCancel = document.getElementById('mini-chat-reply-cancel');
    let muted = false;
    const unread = { community: 0, staff: 0 };
    const latestId = { community: null, staff: null };
    const storageKey = `miniChat:${widget.dataset.userId}`;

    // Discord timestamp markup: <t:UNIX> or <t:UNIX:STYLE>, shown in the viewer's timezone.
    const DISCORD_TIMESTAMP = /(?:<|&lt;)t:(-?\d{1,13})(?::([tTdDfFR]))?(?:>|&gt;)/g;
    const TIMESTAMP_FORMATS = {
        t: { timeStyle: 'short' },
        T: { timeStyle: 'medium' },
        d: { dateStyle: 'short' },
        D: { dateStyle: 'long' },
        f: { dateStyle: 'long', timeStyle: 'short' },
        F: { dateStyle: 'full', timeStyle: 'short' }
    };
    const RELATIVE_UNITS = [
        ['year', 31536000], ['month', 2592000], ['day', 86400],
        ['hour', 3600], ['minute', 60], ['second', 1]
    ];

    function formatRelative(date) {
        const seconds = Math.round((date.getTime() - Date.now()) / 1000);
        const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
        for (const [unit, size] of RELATIVE_UNITS) {
            if (Math.abs(seconds) >= size || unit === 'second') {
                return formatter.format(Math.trunc(seconds / size), unit);
            }
        }
        return '';
    }

    function formatDiscordTimestamp(date, style) {
        if (style === 'R') return formatRelative(date);
        return new Intl.DateTimeFormat(undefined, TIMESTAMP_FORMATS[style] || TIMESTAMP_FORMATS.f).format(date);
    }

    // \x60 is a backtick.
    const INLINE_PATTERN = new RegExp([
        '\\\\(?<esc>[\\\\*_~\\x60|])',
        '(?<tick>\\x60{1,2})(?!\\x60)(?<code>[\\s\\S]+?)(?<!\\x60)\\k<tick>(?!\\x60)',
        '<t:(?<secs>-?\\d{1,13})(?::(?<style>[tTdDfFR]))?>',
        '\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|',
        '\\*\\*\\*(?<bolditalic>[\\s\\S]+?)\\*\\*\\*',
        '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*',
        '__(?<underline>[\\s\\S]+?)__',
        '~~(?<strike>[\\s\\S]+?)~~',
        '\\*(?!\\s)(?<italicStar>[^*\\n]+?)\\*',
        '(?<![A-Za-z0-9_])_(?!\\s)(?<italicUnder>[^_\\n]+?)_(?![A-Za-z0-9_])',
        '<(?<anim>a?):(?<ename>\\w{2,32}):(?<eid>\\d{15,22})>',
        '<(?<mkind>@!?|@&|#)(?<mid>\\d{15,22})>',
        '@(?<everyone>everyone|here)\\b',
        '(?<url>https?:\\/\\/[^\\s<]+)'
    ].join('|'), 'g');

    function wrap(tag, text, className) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        renderInline(el, text);
        return el;
    }

    function renderInline(container, text) {
        let last = 0;
        for (const match of text.matchAll(INLINE_PATTERN)) {
            const g = match.groups;
            let node = null;
            if (g.esc) {
                node = document.createTextNode(g.esc);
            } else if (g.code !== undefined) {
                node = document.createElement('code');
                node.className = 'discord-code';
                node.textContent = g.code.trim();
            } else if (g.secs !== undefined) {
                const date = new Date(Number(g.secs) * 1000);
                if (Number.isNaN(date.getTime())) continue;
                const style = g.style || 'f';
                node = document.createElement('time');
                node.className = 'discord-timestamp';
                node.dateTime = date.toISOString();
                node.title = formatDiscordTimestamp(date, 'F');
                node.dataset.style = style;
                node.textContent = formatDiscordTimestamp(date, style);
            } else if (g.spoiler !== undefined) {
                node = wrap('span', g.spoiler, 'discord-spoiler');
                node.addEventListener('click', () => node.classList.add('revealed'));
            } else if (g.bolditalic !== undefined) {
                node = document.createElement('strong');
                node.append(wrap('em', g.bolditalic));
            } else if (g.bold !== undefined) {
                node = wrap('strong', g.bold);
            } else if (g.underline !== undefined) {
                node = wrap('u', g.underline);
            } else if (g.strike !== undefined) {
                node = wrap('s', g.strike);
            } else if (g.italicStar !== undefined || g.italicUnder !== undefined) {
                node = wrap('em', g.italicStar ?? g.italicUnder);
            } else if (g.eid !== undefined) {
                node = document.createElement('img');
                node.className = 'discord-emoji';
                node.alt = `:${g.ename}:`;
                node.title = `:${g.ename}:`;
                node.loading = 'lazy';
                node.src = `https://cdn.discordapp.com/emojis/${g.eid}.${g.anim ? 'gif' : 'png'}?size=32`;
            } else if (g.mid !== undefined) {
                const key = g.mkind === '@&' ? `&${g.mid}` : g.mkind === '#' ? `#${g.mid}` : g.mid;
                const name = mentionNames[key] || (g.mkind === '#' ? 'unknown-channel' : g.mkind === '@&' ? 'Unknown Role' : 'Unknown User');
                node = document.createElement('span');
                node.className = 'discord-mention';
                if (g.mkind !== '#' && g.mkind !== '@&' && g.mid === myId) node.classList.add('discord-mention-self');
                node.textContent = `${g.mkind === '#' ? '#' : '@'}${name}`;
            } else if (g.everyone !== undefined) {
                node = document.createElement('span');
                node.className = 'discord-mention';
                node.textContent = `@${g.everyone}`;
            } else if (g.url) {
                const trimmed = g.url.replace(/[.,;:!?)\]]+$/, '');
                node = document.createElement('a');
                node.href = trimmed;
                node.target = '_blank';
                node.rel = 'noopener noreferrer';
                node.textContent = trimmed;
                if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
                container.append(node);
                last = match.index + trimmed.length;
                continue;
            }
            if (!node) continue;
            if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
            container.append(node);
            last = match.index + match[0].length;
        }
        if (last < text.length) container.append(document.createTextNode(text.slice(last)));
    }

    function renderLines(container, text) {
        const lines = text.split('\n');
        let plain = [];
        const flush = () => {
            if (plain.length) renderInline(container, plain.join('\n'));
            plain = [];
        };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let m;
            if ((m = line.match(/^(#{1,3}) +(.+)$/))) {
                flush();
                container.append(wrap('div', m[2], 'discord-heading discord-h' + m[1].length));
            } else if ((m = line.match(/^-# +(.+)$/))) {
                flush();
                container.append(wrap('div', m[1], 'discord-subtext'));
            } else if (/^>>> ?/.test(line)) {
                flush();
                const quote = document.createElement('blockquote');
                quote.className = 'discord-quote';
                renderLines(quote, [line.replace(/^>>> ?/, ''), ...lines.slice(i + 1)].join('\n'));
                container.append(quote);
                return;
            } else if (/^> ?/.test(line)) {
                flush();
                const quoted = [];
                while (i < lines.length && /^> ?/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ''));
                i--;
                const quote = document.createElement('blockquote');
                quote.className = 'discord-quote';
                renderLines(quote, quoted.join('\n'));
                container.append(quote);
            } else if ((m = line.match(/^\s*[-*] +(.+)$/))) {
                flush();
                container.append(wrap('div', '\u2022 ' + m[1], 'discord-list-item'));
            } else {
                plain.push(line);
            }
        }
        flush();
    }

    // Renders Discord markdown as DOM nodes only, so message text is never parsed as HTML.
    function renderMessageContent(container, text) {
        let last = 0;
        for (const match of text.matchAll(/```(?:[A-Za-z0-9_+-]*\n)?([\s\S]*?)```/g)) {
            if (match.index > last) renderLines(container, text.slice(last, match.index).replace(/^\n|\n$/g, ''));
            const pre = document.createElement('pre');
            pre.className = 'discord-codeblock';
            pre.textContent = match[1].replace(/\n$/, '');
            container.append(pre);
            last = match.index + match[0].length;
        }
        if (last < text.length) renderLines(container, text.slice(last).replace(/^\n/, ''));
    }

    setInterval(() => {
        document.querySelectorAll('.discord-timestamp[data-style="R"]').forEach(el => {
            el.textContent = formatRelative(new Date(el.dateTime));
        });
    }, 30000);

    function loadStored() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
            return {
                open: stored.open === true,
                channel: stored.channel === 'staff' ? 'staff' : 'community',
                lastSeen: {
                    community: typeof stored.lastSeen?.community === 'string' ? stored.lastSeen.community : null,
                    staff: typeof stored.lastSeen?.staff === 'string' ? stored.lastSeen.staff : null
                }
            };
        } catch {
            return { open: false, channel: 'community', lastSeen: { community: null, staff: null } };
        }
    }

    const stored = loadStored();
    const lastSeen = stored.lastSeen;

    function saveStored() {
        try {
            window.localStorage.setItem(storageKey, JSON.stringify({
                open: !panel.hidden,
                channel: activeChannel,
                lastSeen
            }));
        } catch {
            // Storage can be unavailable (private mode); the chat still works for this page.
        }
    }

    function newerId(a, b) {
        if (!a) return b;
        if (!b) return a;
        try { return BigInt(b) > BigInt(a) ? b : a; } catch { return a; }
    }

    function noteLatest(channel, id) {
        if (id) latestId[channel] = newerId(latestId[channel], String(id));
    }

    function renderUnread() {
        widget.querySelectorAll('[data-unread-channel]').forEach(badge => {
            const count = unread[badge.dataset.unreadChannel] || 0;
            badge.hidden = count === 0;
            badge.textContent = count > 99 ? '99+' : String(count);
        });
    }

    function markSeen(channel) {
        if (latestId[channel]) lastSeen[channel] = newerId(lastSeen[channel], latestId[channel]);
        unread[channel] = 0;
        renderUnread();
        saveStored();
    }
    const seenMessages = new Map([
        ['community', new Set()],
        ['staff', new Set()]
    ]);

    function setPanelOpen(open, focus = true) {
        panel.hidden = !open;
        if (open) {
            messages.scrollTop = messages.scrollHeight;
            requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
            if (focus) input.focus();
            markSeen(activeChannel);
        }
        saveStored();
    }

    function setActiveChannel(channel, requestHistory = true) {
        activeChannel = channel === 'staff' ? 'staff' : 'community';
        tabs.forEach(tab => {
            const selected = tab.dataset.chatChannel === activeChannel;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
        });
        const chatTitle = activeChannel === 'staff' ? 'Staff Chat' : 'Community Chat';
        title.textContent = chatTitle;
        input.placeholder = activeChannel === 'staff'
            ? 'Message the staff channel…'
            : 'Message this Discord channel…';
        if (!panel.hidden) markSeen(activeChannel);
        saveStored();
        messages.replaceChildren();
        const placeholder = document.createElement('p');
        placeholder.className = 'mini-chat-placeholder';
        placeholder.textContent = 'Loading messages…';
        messages.append(placeholder);
        typing.hidden = true;
        typing.textContent = '';
        clearReply();
        showError('');
        if (requestHistory && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'select_chat', channel: activeChannel }));
        }
    }

    function plainWithMentions(text, names) {
        return text.replace(/<@!?(\d{15,22})>/g, (_m, id) => `@${names[id] || 'Unknown User'}`)
            .replace(/<@&(\d{15,22})>/g, (_m, id) => `@${names[`&${id}`] || 'Unknown Role'}`)
            .replace(/<#(\d{15,22})>/g, (_m, id) => `#${names[`#${id}`] || 'unknown-channel'}`)
            .replace(/<a?:(\w{2,32}):\d{15,22}>/g, ':$1:');
    }

    function buildReplyPreview(reply) {
        const el = document.createElement('div');
        el.className = 'mini-chat-reply-preview';
        if (reply.missing) {
            el.textContent = '↪ Original message unavailable';
            return el;
        }
        const name = document.createElement('strong');
        name.textContent = `↪ ${reply.author_name || 'Unknown'}`;
        const snippet = document.createElement('span');
        snippet.textContent = ` ${plainWithMentions(reply.content || '', reply.mention_names || {})}`;
        el.append(name, snippet);
        el.addEventListener('click', () => {
            const target = findRow(reply.id);
            if (!target) return;
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('mini-chat-flash');
            window.setTimeout(() => target.classList.remove('mini-chat-flash'), 1500);
        });
        return el;
    }

    const ALLOWED_MEDIA_HOST = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;

    function buildAttachments(attachments) {
        const wrap = document.createElement('div');
        wrap.className = 'mini-chat-attachments';
        for (const file of attachments) {
            if (!ALLOWED_MEDIA_HOST.test(file.url || '')) continue;
            const link = document.createElement('a');
            link.href = file.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            if (file.is_image) {
                const img = document.createElement('img');
                img.className = 'mini-chat-attachment-image';
                img.loading = 'lazy';
                img.alt = file.name;
                img.title = file.name;
                img.src = file.url;
                img.addEventListener('error', () => {
                    link.textContent = file.name;
                    img.remove();
                });
                link.append(img);
            } else {
                link.className = 'mini-chat-attachment-file';
                link.textContent = `📎 ${file.name}`;
            }
            wrap.append(link);
        }
        return wrap;
    }

    function renderReactions(container, reactions) {
        container.replaceChildren();
        for (const reaction of reactions || []) {
            const chip = document.createElement('span');
            chip.className = 'mini-chat-reaction';
            if (reaction.id) {
                const img = document.createElement('img');
                img.className = 'discord-emoji';
                img.alt = `:${reaction.name}:`;
                img.title = `:${reaction.name}:`;
                img.loading = 'lazy';
                img.src = `https://cdn.discordapp.com/emojis/${encodeURIComponent(reaction.id)}.${reaction.animated ? 'gif' : 'png'}?size=32`;
                chip.append(img);
            } else {
                chip.append(document.createTextNode(reaction.name || '?'));
            }
            const count = document.createElement('span');
            count.className = 'mini-chat-reaction-count';
            count.textContent = String(reaction.count);
            chip.append(count);
            container.append(chip);
        }
        container.hidden = container.children.length === 0;
    }

    function findRow(id) {
        return [...messages.children].find(row => row.dataset.messageId === id);
    }

    function startReply(message) {
        replyTarget = message.id;
        replyLabel.textContent = `Replying to ${message.author_name || 'message'}`;
        replyBar.hidden = false;
        input.focus();
    }

    function clearReply() {
        replyTarget = null;
        replyBar.hidden = true;
    }
    replyCancel.addEventListener('click', clearReply);

    function addMessage(message, replaceRow = null) {
        const channelMessages = seenMessages.get(activeChannel);
        if (!replaceRow && message.id && channelMessages.has(message.id)) return;
        if (message.id) channelMessages.add(message.id);

        const wasAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 4;

        const placeholder = messages.querySelector('.mini-chat-placeholder');
        if (placeholder) placeholder.remove();

        const row = document.createElement('article');
        row.className = `mini-chat-message mini-chat-${message.source === 'web' ? 'web' : 'discord'}`;
        const header = document.createElement('div');
        header.className = 'mini-chat-message-header';
        const author = document.createElement('strong');
        author.textContent = message.author_name || 'Discord';
        const time = document.createElement('time');
        if (message.timestamp) {
            const parsedTime = new Date(message.timestamp);
            if (!Number.isNaN(parsedTime.getTime())) {
                time.dateTime = parsedTime.toISOString();
                time.textContent = parsedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        }
        header.append(author, time);

        const body = document.createElement('div');
        body.className = 'mini-chat-message-body';
        const avatar = document.createElement('div');
        avatar.className = 'mini-chat-avatar';
        avatar.textContent = (message.author_name || '?').trim().charAt(0).toUpperCase();
        if (message.avatar_url && /^https:\/\/cdn\.discordapp\.com\//.test(message.avatar_url)) {
            const img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.src = message.avatar_url;
            img.addEventListener('error', () => img.remove());
            avatar.append(img);
        }
        const text = document.createElement('div');
        text.className = 'mini-chat-message-text';
        mentionNames = message.mention_names || {};
        const content = document.createElement('p');
        renderMessageContent(content, message.content || '');
        text.append(header);
        if (message.reply) text.prepend(buildReplyPreview(message.reply));
        if (message.content) text.append(content);
        if (message.attachments?.length) text.append(buildAttachments(message.attachments));
        const reactionBar = document.createElement('div');
        reactionBar.className = 'mini-chat-reactions';
        text.append(reactionBar);
        renderReactions(reactionBar, message.reactions);

        if (message.id) {
            row.dataset.messageId = message.id;
            const replyButton = document.createElement('button');
            replyButton.type = 'button';
            replyButton.className = 'mini-chat-reply-btn';
            replyButton.textContent = 'Reply';
            replyButton.addEventListener('click', () => startReply(message));
            header.append(replyButton);
        }
        const pinged = message.mentions_everyone ||
            (message.mentioned_user_ids || []).includes(myId);
        if (pinged && message.author_id !== myId) row.classList.add('mini-chat-mentioned');
        body.append(avatar, text);
        row.append(body);
        if (replaceRow) replaceRow.replaceWith(row);
        else messages.append(row);

        while (messages.children.length > 100) messages.firstElementChild.remove();
        // Only follow new messages if the reader was already at the very bottom.
        if (wasAtBottom) messages.scrollTop = messages.scrollHeight;
    }

    function showError(message) {
        error.textContent = message || '';
    }

    function showTypingUsers(users) {
        const names = [...new Set(users
            .filter(user => user.id !== widget.dataset.userId)
            .map(user => user.username)
            .filter(Boolean))];
        typing.textContent = names.length === 0
            ? ''
            : names.length === 1
                ? `${names[0]} is typing…`
                : names.length === 2
                    ? `${names[0]} and ${names[1]} are typing…`
                    : `${names[0]}, ${names[1]}, and others are typing…`;
        typing.hidden = names.length === 0;
    }

    function sendTyping(active) {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'typing', active }));
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts) + Math.random() * 500;
        reconnectAttempts += 1;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function connect() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/chat`);
        socket = ws;

        ws.addEventListener('open', () => {
            if (socket !== ws) return;
            reconnectAttempts = 0;
            lastReceivedAt = Date.now();
            startHeartbeat();
            status.textContent = 'Online';
            showError('');
            if (activeChannel !== 'community') {
                socket.send(JSON.stringify({ type: 'select_chat', channel: activeChannel }));
            }
            socket.send(JSON.stringify({ type: 'unread_check', last_seen: lastSeen }));
            if (reconnectTimer) {
                window.clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        });

        ws.addEventListener('message', event => {
            if (socket !== ws) return;
            lastReceivedAt = Date.now();
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                showError('Received an invalid chat update.');
                return;
            }

            if (data.type === 'history' && data.channel_chat) {
                if (data.chat_channel !== activeChannel) return;
                seenMessages.get(activeChannel).clear();
                messages.replaceChildren();
                data.messages.forEach(message => addMessage(message));
                noteLatest(activeChannel, data.messages[data.messages.length - 1]?.id);
                if (!panel.hidden) markSeen(activeChannel);
                if (data.messages.length === 0) {
                    const placeholder = document.createElement('p');
                    placeholder.className = 'mini-chat-placeholder';
                    placeholder.textContent = 'No recent messages.';
                    messages.append(placeholder);
                }
                const scrollToEnd = () => { messages.scrollTop = messages.scrollHeight; };
                scrollToEnd();
                requestAnimationFrame(scrollToEnd);
                setTimeout(scrollToEnd, 150);
            } else if (data.type === 'message' && data.channel_chat) {
                const channelKey = data.chat_channel === 'staff' ? 'staff' : 'community';
                noteLatest(channelKey, data.id);
                if (channelKey !== activeChannel || panel.hidden) {
                    if (data.author_id !== widget.dataset.userId) {
                        unread[channelKey] += 1;
                        renderUnread();
                    }
                    if (channelKey !== activeChannel) return;
                }
                addMessage(data);
                if (!panel.hidden) markSeen(activeChannel);
            } else if (data.type === 'pong') {
                // Receipt alone refreshes lastReceivedAt.
            } else if (data.channel_chat && data.type === 'reactions') {
                if (data.chat_channel !== activeChannel) return;
                const row = findRow(data.message_id);
                const bar = row?.querySelector('.mini-chat-reactions');
                if (bar) renderReactions(bar, data.reactions);
            } else if (data.channel_chat && data.type === 'message_deleted') {
                if (data.chat_channel !== activeChannel) return;
                findRow(data.message_id)?.remove();
                seenMessages.get(activeChannel).delete(data.message_id);
                if (replyTarget === data.message_id) clearReply();
            } else if (data.channel_chat && data.type === 'message_edited') {
                if (data.chat_channel !== activeChannel) return;
                const row = findRow(data.id);
                if (row) addMessage(data, row);
            } else if (data.type === 'typing_users' && Array.isArray(data.users)) {
                if (data.chat_channel !== activeChannel) return;
                showTypingUsers(data.users);
            } else if (data.type === 'chat_config') {
                if (staffTab) staffTab.hidden = !data.staff_chat_available;
                const communityTab = tabs.find(tab => tab.dataset.chatChannel === 'community');
                if (communityTab) communityTab.hidden = !data.community_chat_available;
                if (activeChannel === 'staff' && !data.staff_chat_available) {
                    setActiveChannel('community');
                }
                if (activeChannel === 'community' &&
                    !data.community_chat_available &&
                    data.staff_chat_available) {
                    setActiveChannel('staff');
                }
            } else if (data.type === 'unread_counts') {
                for (const channel of ['community', 'staff']) {
                    if (!(channel in (data.counts || {}))) continue;
                    noteLatest(channel, data.latest?.[channel]);
                    if (!lastSeen[channel]) lastSeen[channel] = data.latest?.[channel] || null;
                    unread[channel] = Number(data.counts[channel]) || 0;
                    if (channel === activeChannel && !panel.hidden) markSeen(channel);
                }
                renderUnread();
                saveStored();
            } else if (data.type === 'error') {
                showError(data.message);
            } else if (data.type === 'muted') {
                muted = true;
                input.disabled = true;
                showError(`Chat muted: ${data.reason || 'No reason given'}`);
            } else if (data.type === 'unmuted') {
                muted = false;
                input.disabled = false;
                showError('');
            }
        });

        ws.addEventListener('close', event => {
            if (socket !== ws) return;
            stopHeartbeat();
            showTypingUsers([]);
            if (event.code === 4001) {
                // Session expired: retrying cannot succeed until the user signs in again.
                status.textContent = 'Signed out';
                showError('Your session has expired. Reload the page or log in again to reconnect.');
                return;
            }
            status.textContent = 'Reconnecting';
            scheduleReconnect();
        });

        ws.addEventListener('error', () => {
            if (socket === ws) status.textContent = 'Connection error';
        });
    }

    // The browser cannot see WebSocket protocol pings, so probe with an app-level ping. A socket
    // that stays silent (laptop sleep, proxy timeout) is abandoned and replaced.
    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = window.setInterval(() => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            if (Date.now() - lastReceivedAt > 60000) {
                const stale = socket;
                socket = null;
                stopHeartbeat();
                try { stale.close(); } catch { /* already gone */ }
                status.textContent = 'Reconnecting';
                reconnectAttempts = 0;
                connect();
                return;
            }
            socket.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
    }

    function stopHeartbeat() {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    const retryNow = () => {
        // A tab that slept may hold a socket that looks open but is dead; ping to verify it.
        if (socket?.readyState === WebSocket.OPEN) {
            if (Date.now() - lastReceivedAt > 45000) socket.send(JSON.stringify({ type: 'ping' }));
            return;
        }
        if (socket && socket.readyState === WebSocket.CONNECTING) return;
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connect();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) retryNow();
    });

    tabs.forEach(tab => tab.addEventListener('click', () => {
        if (tab.hidden || tab.dataset.chatChannel === activeChannel) return;
        setActiveChannel(tab.dataset.chatChannel);
    }));

    input.addEventListener('input', () => {
        if (!input.value.trim() || muted) {
            window.clearTimeout(typingStopTimer);
            sendTyping(false);
            return;
        }
        const now = Date.now();
        if (now - lastTypingSentAt >= 1000) {
            sendTyping(true);
            lastTypingSentAt = now;
        }
        window.clearTimeout(typingStopTimer);
        typingStopTimer = window.setTimeout(() => sendTyping(false), 1800);
    });

    form.addEventListener('submit', event => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content || muted) return;
        if (socket?.readyState !== WebSocket.OPEN) {
            showError('Chat is reconnecting. Please try again shortly.');
            return;
        }
        window.clearTimeout(typingStopTimer);
        sendTyping(false);
        socket.send(JSON.stringify({ type: 'message', content, ...(replyTarget ? { reply_to: replyTarget } : {}) }));
        clearReply();
        input.value = '';
        showError('');
    });

    if (stored.channel === 'staff') setActiveChannel('staff', false);
    setPanelOpen(true, false);
    // The chat is docked under the sticky navbar, so track the navbar's (wrapping) height.
    const navbar = document.querySelector('.navbar');
    const syncNavHeight = () => {
        document.documentElement.style.setProperty('--chat-top', `px`);
    };
    syncNavHeight();
    window.addEventListener('resize', syncNavHeight);
    renderUnread();
    connect();
})();

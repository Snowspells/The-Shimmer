(() => {
    const widget = document.getElementById('mini-chat');
    if (!widget) return;

    const toggle = document.getElementById('mini-chat-toggle');
    const close = document.getElementById('mini-chat-close');
    const panel = document.getElementById('mini-chat-panel');
    const messages = document.getElementById('mini-chat-messages');
    const status = document.getElementById('mini-chat-status');
    const error = document.getElementById('mini-chat-error');
    const form = document.getElementById('mini-chat-form');
    const input = document.getElementById('mini-chat-input');
    let socket;
    let reconnectTimer;
    let muted = false;
    const seenMessages = new Set();

    function setPanelOpen(open) {
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            messages.scrollTop = messages.scrollHeight;
            input.focus();
        }
    }

    function addMessage(message) {
        if (message.id && seenMessages.has(message.id)) return;
        if (message.id) seenMessages.add(message.id);

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

        const content = document.createElement('p');
        content.textContent = message.content || '';
        row.append(header, content);
        messages.append(row);

        while (messages.children.length > 100) messages.firstElementChild.remove();
        if (panel.hidden || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120) {
            messages.scrollTop = messages.scrollHeight;
        }
    }

    function showError(message) {
        error.textContent = message || '';
    }

    function connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}/ws/chat`);

        socket.addEventListener('open', () => {
            status.textContent = 'Online';
            showError('');
            if (reconnectTimer) {
                window.clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        });

        socket.addEventListener('message', event => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                showError('Received an invalid chat update.');
                return;
            }

            if (data.type === 'history' && data.channel_chat) {
                messages.replaceChildren();
                data.messages.forEach(addMessage);
                if (data.messages.length === 0) {
                    const placeholder = document.createElement('p');
                    placeholder.className = 'mini-chat-placeholder';
                    placeholder.textContent = 'No recent messages.';
                    messages.append(placeholder);
                }
            } else if (data.type === 'message' && data.channel_chat) {
                addMessage(data);
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

        socket.addEventListener('close', () => {
            status.textContent = 'Reconnecting';
            if (!reconnectTimer) reconnectTimer = window.setTimeout(connect, 3000);
        });

        socket.addEventListener('error', () => {
            status.textContent = 'Connection error';
        });
    }

    toggle.addEventListener('click', () => setPanelOpen(panel.hidden));
    close.addEventListener('click', () => setPanelOpen(false));

    form.addEventListener('submit', event => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content || muted) return;
        if (socket?.readyState !== WebSocket.OPEN) {
            showError('Chat is reconnecting. Please try again shortly.');
            return;
        }
        socket.send(JSON.stringify({ type: 'message', content }));
        input.value = '';
        showError('');
    });

    connect();
})();

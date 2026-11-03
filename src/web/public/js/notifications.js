(() => {
    const bar = document.getElementById('notification-bar');
    if (!bar) return;

    const totalElement = document.getElementById('notification-total');
    const countsElement = document.getElementById('notification-counts');
    const eventsElement = document.getElementById('notification-events');
    const errorElement = document.getElementById('notification-error');
    const loadMoreButton = document.getElementById('notification-load-more');
    const toggleButton = document.getElementById('notification-toggle');
    const panelElement = document.getElementById('notification-panel');
    const badgeElement = document.getElementById('notification-badge');

    function setOpen(open) {
        panelElement.hidden = !open;
        toggleButton.setAttribute('aria-expanded', String(open));
    }
    toggleButton.addEventListener('click', () => setOpen(panelElement.hidden));
    document.addEventListener('click', event => {
        if (!bar.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setOpen(false);
    });
    const labels = {
        ticket_message: ['Ticket messages', '/tickets'],
        marks_changed: ['Marks changes', '/dashboard#account-marks'],
        inventory_changed: ['Inventory changes', '/dashboard#account-inventory'],
        suggestion_comment: ['Suggestion comments', '/suggestions'],
        suggestion_update: ['Suggestion updates', '/suggestions'],
        bug_update: ['Bug reports & status changes', '/bugs'],
        bug_comment: ['Bug comments', '/bugs']
    };
    const renderedEventIds = new Set();
    let nextBeforeId = null;
    let initialLoad = true;
    let loadingOlder = false;
    let lastTotal = null;

    function link(text, href, className) {
        const anchor = document.createElement('a');
        anchor.textContent = text;
        anchor.href = href;
        anchor.className = className;
        return anchor;
    }

    function renderEvent(notification, prepend = false) {
        if (renderedEventIds.has(notification.id)) return;
        renderedEventIds.add(notification.id);
        const formatted = window.formatServerDate ? window.formatServerDate(notification.created_at) : '';
        const when = formatted ? ` · ${formatted}` : '';
        const anchor = link(
            `${notification.title}: ${notification.message}${when}`,
            notification.href,
            'notification-event'
        );
        if (prepend) eventsElement.prepend(anchor);
        else eventsElement.append(anchor);
    }

    async function fetchNotifications(before = null) {
        const url = before === null
            ? '/api/notifications'
            : `/api/notifications?before=${encodeURIComponent(before)}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Notifications request failed (${response.status}).`);
        return response.json();
    }

    async function refresh() {
        try {
            const data = await fetchNotifications();
            const total = Number(data.total) || 0;
            totalElement.textContent = total === 1 ? '1 unread update' : `${total} unread updates`;
            badgeElement.hidden = total === 0;
            badgeElement.textContent = total > 99 ? '99+' : String(total);
            countsElement.replaceChildren();

            for (const [category, countValue] of Object.entries(data.counts || {})) {
                const count = Number(countValue) || 0;
                const categoryInfo = labels[category];
                if (count < 1 || !categoryInfo) continue;
                countsElement.append(link(
                    `${categoryInfo[0]}: ${count}`,
                    categoryInfo[1],
                    'notification-count'
                ));
            }

            const isInitialLoad = initialLoad;
            if (isInitialLoad) {
                eventsElement.replaceChildren();
                renderedEventIds.clear();
            }
            const currentEvents = data.notifications || [];
            if (isInitialLoad) {
                for (const notification of currentEvents) renderEvent(notification);
            } else {
                for (const notification of [...currentEvents].reverse()) {
                    renderEvent(notification, true);
                }
            }
            initialLoad = false;
            if (isInitialLoad || (lastTotal !== null && total > lastTotal && !nextBeforeId)) {
                nextBeforeId = data.nextBeforeId;
            }
            loadMoreButton.hidden = !nextBeforeId;
            if (total === 0) {
                eventsElement.replaceChildren();
                renderedEventIds.clear();
                nextBeforeId = null;
                loadMoreButton.hidden = true;
            }
            errorElement.hidden = true;
            errorElement.textContent = '';
            bar.setAttribute('aria-busy', 'false');
            lastTotal = total;
        } catch (err) {
            console.error('Could not refresh notifications:', err);
            errorElement.textContent = 'Updates could not be loaded. Refresh the page to try again.';
            errorElement.hidden = false;
            bar.setAttribute('aria-busy', 'false');
        }
    }

    loadMoreButton.addEventListener('click', async () => {
        if (!nextBeforeId || loadingOlder) return;
        loadingOlder = true;
        loadMoreButton.disabled = true;
        errorElement.hidden = true;
        try {
            const data = await fetchNotifications(nextBeforeId);
            for (const notification of data.notifications || []) renderEvent(notification);
            nextBeforeId = data.nextBeforeId;
            loadMoreButton.hidden = !data.hasMore;
        } catch (err) {
            console.error('Could not load older notifications:', err);
            errorElement.textContent = 'Older updates could not be loaded. Please try again.';
            errorElement.hidden = false;
        } finally {
            loadingOlder = false;
            loadMoreButton.disabled = false;
        }
    });

    refresh();
    window.setInterval(refresh, 30000);
})();

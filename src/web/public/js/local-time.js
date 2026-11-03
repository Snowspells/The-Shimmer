// Server timestamps are UTC (SQLite stores "YYYY-MM-DD HH:MM:SS" without a zone).
// Show every one of them in the viewer's own timezone.
(() => {
    const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    function parseServerDate(value) {
        if (value instanceof Date) return value;
        const text = String(value ?? '').trim();
        return new Date(SQLITE_UTC.test(text) ? `${text.replace(' ', 'T')}Z` : text);
    }

    function formatServerDate(value, format = 'datetime') {
        const date = parseServerDate(value);
        if (Number.isNaN(date.getTime())) return '';
        if (format === 'date') return date.toLocaleDateString();
        if (format === 'time') return date.toLocaleTimeString();
        return date.toLocaleString();
    }

    function localizeTimes(root = document) {
        root.querySelectorAll('time.local-time[datetime]').forEach(el => {
            const text = formatServerDate(el.getAttribute('datetime'), el.dataset.format);
            if (text) el.textContent = text;
        });
    }

    window.parseServerDate = parseServerDate;
    window.formatServerDate = formatServerDate;
    window.localizeTimes = localizeTimes;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => localizeTimes());
    else localizeTimes();
})();

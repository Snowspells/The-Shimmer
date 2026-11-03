document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.suggestion-delete-form')) return;

    if (!window.confirm('Permanently delete this card and its progress history?')) {
        event.preventDefault();
    }
});

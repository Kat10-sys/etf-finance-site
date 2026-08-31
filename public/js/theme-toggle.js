(function () {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function updateIcon() {
    btn.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
  }

  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (e) {
      // localStorage unavailable (private browsing, etc.) — theme just won't persist
    }
    updateIcon();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });

  updateIcon();
})();

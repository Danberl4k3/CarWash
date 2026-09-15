(() => {
  // Check and apply saved theme
  try {
    const theme = localStorage.getItem('theme');
    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {}

  const updateThemeIcons = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.textContent = isDark ? '☀️' : '🌙';
      btn.setAttribute('title', isDark ? 'Modo claro' : 'Modo oscuro');
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateThemeIcons);
  } else {
    updateThemeIcons();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-toggle-btn');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('theme', 'light'); } catch (err) {}
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('theme', 'dark'); } catch (err) {}
    }
    updateThemeIcons();
  });
})();


// Shared keyboard and disclosure behavior; works with live-replaced board cards.
(() => {
  const menus = () => [...document.querySelectorAll('.admin-nav-more[open], .card-more-menu[open]')];
  document.addEventListener('pointerdown', event => {
    menus().forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      menus().forEach(menu => {
        if (menu.contains(document.activeElement)) menu.querySelector('summary')?.focus();
        menu.open = false;
      });
    }
    const filter = event.target.closest('article[data-summary-filter]');
    if (filter && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      filter.click();
    }
  });
})();

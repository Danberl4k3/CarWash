(() => {
  const board = document.querySelector('[data-live-board]');
  if (!board) return;
  window.setInterval(() => {
    if (document.visibilityState === 'visible') window.location.reload();
  }, 30000);
})();

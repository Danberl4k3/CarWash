(() => {
  const board = document.querySelector('[data-live-board]');
  if (!board) return;

  async function silentRefresh(fetchPromise) {
    try {
      const res = await (fetchPromise || fetch(window.location.href));
      if (!res.ok) return;
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      
      const newBoard = doc.querySelector('[data-live-board]');
      if (newBoard && board) board.innerHTML = newBoard.innerHTML;
      
      const newSummary = doc.querySelector('.summary-grid');
      const currentSummary = document.querySelector('.summary-grid');
      if (newSummary && currentSummary) currentSummary.innerHTML = newSummary.innerHTML;
    } catch (e) {
      // Ignore network errors
    }
  }

  // Auto-refresh every 30s silently instead of full page reload
  window.setInterval(() => {
    if (document.visibilityState === 'visible') silentRefresh();
  }, 30000);

  // Handle quick action buttons without full page reload
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.closest('.quick-actions')) return;
    
    e.preventDefault();
    const btn = e.submitter;
    const formData = new FormData(form);
    if (btn && btn.name) {
      formData.append(btn.name, btn.value);
    }
    
    if (btn) {
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
    }

    const postPromise = fetch(form.action, {
      method: 'POST',
      body: new URLSearchParams(formData),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    await silentRefresh(postPromise);
  });
})();

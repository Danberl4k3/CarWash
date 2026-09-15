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
      
      // Re-apply search filter if active
      const searchInput = document.getElementById('board-search');
      if (searchInput && searchInput.value) {
        searchInput.dispatchEvent(new Event('input'));
      }
    } catch (e) {
      // Ignore network errors
    }
  }

  // Auto-refresh every 30s silently instead of full page reload
  window.setInterval(() => {
    if (document.visibilityState === 'visible') silentRefresh();
  }, 30000);

  // Handle quick action buttons without full page reload
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[type="submit"][name="action"]');
    if (!btn) return;
    
    const form = btn.closest('form');
    if (!form || !form.closest('.quick-actions')) return;
    
    e.preventDefault(); // Stop normal form submission

    const formData = new FormData(form);
    formData.append(btn.name, btn.value);
    
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';

    const params = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      if (key !== 'action') {
        params.append(key, value);
      }
    }
    params.append(btn.name, btn.value);

    try {
      const url = form.getAttribute('action');
      const postPromise = fetch(url, {
        method: 'POST',
        body: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      await silentRefresh(postPromise);
    } catch (err) {
      console.error('Quick action failed:', err);
    } finally {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
    }
  });

  // Handle board searching
  const searchInput = document.getElementById('board-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase().trim();
      const cards = document.querySelectorAll('.vehicle-card');
      
      cards.forEach(card => {
        const plate = card.querySelector('.plate-number')?.textContent?.toLowerCase() || '';
        const name = card.querySelector('p')?.textContent?.toLowerCase() || '';
        if (plate.includes(term) || name.includes(term)) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    });
  }
})();

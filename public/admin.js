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

      const newNextUp = doc.querySelector('.next-up-card-container');
      const currentNextUp = document.querySelector('.next-up-card-container');
      if (newNextUp && currentNextUp) currentNextUp.innerHTML = newNextUp.innerHTML;
      
      // Re-apply search filter if active
      const searchInput = document.getElementById('board-search');
      if (searchInput && searchInput.value) {
        searchInput.dispatchEvent(new Event('input'));
      }
      applyEmptyHoursFilter();
      updateWashTimers();
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
    if (!form || (!form.closest('.quick-actions') && !form.closest('.next-up-action'))) return;
    
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

  // Toggle empty hours filter
  const filterBtn = document.getElementById('toggle-empty-hours');
  function applyEmptyHoursFilter() {
    if (!filterBtn) return;
    const hideEmpty = localStorage.getItem('hideEmptyHours') === 'true';
    filterBtn.classList.toggle('active', hideEmpty);
    const textSpan = filterBtn.querySelector('.filter-text');
    if (textSpan) textSpan.textContent = hideEmpty ? 'Ver todas' : 'Solo con autos';
    document.querySelectorAll('.pickup-column').forEach(col => {
      const hasEmpty = !!col.querySelector('.empty-slot');
      col.classList.toggle('column-hidden', hideEmpty && hasEmpty);
    });
  }

  if (filterBtn) {
    applyEmptyHoursFilter();
    filterBtn.addEventListener('click', () => {
      const current = localStorage.getItem('hideEmptyHours') === 'true';
      localStorage.setItem('hideEmptyHours', String(!current));
      applyEmptyHoursFilter();
    });
  }

  // Live Wash Timer for vehicles in_progress
  function updateWashTimers() {
    let hasFinishedWashing = false;
    document.querySelectorAll('[data-wash-timer]').forEach(timer => {
      const card = timer.closest('.vehicle-card');
      if (!card) return;
      const startedAt = card.dataset.startedAt;
      const vehicleType = card.dataset.vehicleType;
      if (!startedAt) return;
      const startedMs = Date.parse(startedAt);
      if (isNaN(startedMs)) return;

      const durationMinutes = (vehicleType === 'small_suv' || vehicleType === 'large_suv') ? 45 : 30;
      const elapsedMs = Date.now() - startedMs;
      const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
      const remainingMinutes = Math.max(0, durationMinutes - elapsedMinutes);
      const percent = Math.min(100, Math.max(0, (elapsedMs / (durationMinutes * 60 * 1000)) * 100));

      const remainEl = timer.querySelector('.wash-timer-remain');
      const fillEl = timer.querySelector('.wash-progress-bar');
      const labelEl = timer.querySelector('.wash-timer-label');

      if (remainingMinutes > 0) {
        if (remainEl) remainEl.textContent = `faltan ${remainingMinutes} min`;
        if (labelEl) labelEl.textContent = `⏳ Lavando (${durationMinutes} min)`;
        if (fillEl) fillEl.style.width = `${percent}%`;
      } else {
        if (remainEl) remainEl.textContent = '¡Completado!';
        if (labelEl) labelEl.textContent = '✨ Listo para entregar';
        if (fillEl) fillEl.style.width = '100%';
        hasFinishedWashing = true;
      }
    });

    if (hasFinishedWashing) {
      silentRefresh();
    }
  }

  window.setInterval(updateWashTimers, 5000);
  updateWashTimers();
})();

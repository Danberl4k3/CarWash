(() => {
  const board = document.querySelector('[data-live-board]');
  if (!board) return;

  // Web Audio API Synthesizer Chime
  function playBookingChime() {
    if (localStorage.getItem('adminSoundEnabled') === 'false') return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const now = ctx.currentTime;

      // Nota 1: D5 (587.33 Hz)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      // Nota 2: A5 (880.00 Hz)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880.0, now + 0.14);
      gain2.gain.setValueAtTime(0.35, now + 0.14);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.14);
      osc2.stop(now + 0.65);
    } catch (e) {
      // Ignorar bloqueos de autoplay del navegador antes de interacción
    }
  }

  // Toast flotante para notificaciones instantáneas
  function showToast(message) {
    let toast = document.getElementById('admin-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'admin-toast';
      toast.className = 'admin-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 4000);
  }

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

      const newCash = doc.querySelector('.cash-breakdown-panel');
      const currentCash = document.querySelector('.cash-breakdown-panel');
      if (newCash && currentCash) {
        const wasOpen = currentCash.hasAttribute('open');
        currentCash.innerHTML = newCash.innerHTML;
        if (wasOpen) currentCash.setAttribute('open', '');
        else currentCash.removeAttribute('open');
      }

      const newNextUp = doc.querySelector('.next-up-card-container');
      const currentNextUp = document.querySelector('.next-up-card-container');
      if (newNextUp && currentNextUp) currentNextUp.innerHTML = newNextUp.innerHTML;

      // Reaplicar filtros activos
      applyFilters();
      applyEmptyHoursFilter();
      updateWashTimers();
    } catch (e) {
      // Ignorar errores de red temporales
    }
  }

  // Conexión Server-Sent Events (SSE) para tiempo real instantáneo
  function initSSE() {
    if (!window.EventSource) return;
    try {
      const sse = new EventSource('/admin/events');
      sse.addEventListener('booking_created', () => {
        playBookingChime();
        showToast('🚗 ¡Nueva reserva registrada!');
        silentRefresh();
      });
      sse.addEventListener('booking_updated', () => {
        silentRefresh();
      });
      sse.addEventListener('refresh', () => {
        silentRefresh();
      });
    } catch (err) {
      console.warn('SSE fallback to polling');
    }
  }

  initSSE();

  // Polling de respaldo cada 30s por si la pestaña estuvo suspendida
  window.setInterval(() => {
    if (document.visibilityState === 'visible') silentRefresh();
  }, 30000);

  // Control de fecha interactivo
  const dateInput = document.getElementById('admin-date-input');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        window.location.href = `/admin?date=${encodeURIComponent(dateInput.value)}`;
      }
    });
  }

  // Control de sonido (Activar / Silenciar)
  const soundBtn = document.getElementById('toggle-sound-btn');
  function updateSoundBtn() {
    if (!soundBtn) return;
    const enabled = localStorage.getItem('adminSoundEnabled') !== 'false';
    const icon = soundBtn.querySelector('.sound-icon');
    const label = soundBtn.querySelector('.sound-label');
    if (icon) icon.textContent = enabled ? '🔔' : '🔕';
    if (label) label.textContent = enabled ? 'Avisos activos' : 'Silenciado';
    soundBtn.classList.toggle('is-muted', !enabled);
  }

  if (soundBtn) {
    updateSoundBtn();
    soundBtn.addEventListener('click', () => {
      const current = localStorage.getItem('adminSoundEnabled') !== 'false';
      localStorage.setItem('adminSoundEnabled', String(!current));
      updateSoundBtn();
      if (!current) playBookingChime();
    });
  }

  // Manejo de acciones rápidas sin recarga de página completa
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[type="submit"][name="action"]');
    if (!btn) return;

    const form = btn.closest('form');
    if (!form || (!form.closest('.quick-actions') && !form.closest('.next-up-action'))) return;

    e.preventDefault();

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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const response = await postPromise;
      if (!response.ok || new URL(response.url).pathname === '/admin/login') {
        showToast('No se pudo guardar. Recarga la página e inicia sesión si es necesario.');
        return;
      }
      // Actualizar la fecha que el usuario está consultando, incluida una fecha histórica.
      await silentRefresh();
    } catch (err) {
      console.error('Quick action failed:', err);
    } finally {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
    }
  });

  // Sistema de filtrado por estado, pago, búsqueda y ocultar terminados+pagados
  let currentFilter = 'all';
  const toggleHideDonePaid = document.getElementById('toggle-hide-done-paid');

  function applyFilters() {
    const searchInput = document.getElementById('board-search');
    const term = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const hideDonePaid = toggleHideDonePaid ? toggleHideDonePaid.checked : true;

    const cards = document.querySelectorAll('.vehicle-card');
    let visibleCount = 0;
    let hiddenDonePaidCount = 0;

    cards.forEach((card) => {
      const status = card.dataset.status || '';
      const paymentStatus = card.dataset.paymentStatus || '';
      const plate = card.querySelector('.plate-number')?.textContent?.toLowerCase() || '';
      const name = card.querySelector('.card-customer')?.textContent?.toLowerCase() || '';
      const service = card.querySelector('.card-service-name')?.textContent?.toLowerCase() || '';

      const matchesSearch = !term || plate.includes(term) || name.includes(term) || service.includes(term);

      let matchesCategory = true;
      if (currentFilter === 'in_progress') {
        matchesCategory = status === 'in_progress';
      } else if (currentFilter === 'completed') {
        matchesCategory = status === 'completed';
      } else if (currentFilter === 'paid') {
        matchesCategory = paymentStatus === 'paid';
      } else if (currentFilter === 'pending_payment') {
        matchesCategory = paymentStatus !== 'paid';
      } else if (currentFilter === 'pending') {
        matchesCategory = status === 'pending';
      }

      const isDoneAndPaid = status === 'completed' && paymentStatus === 'paid';
      let shouldHideDonePaid = false;
      // Ocultar si está activo el toggle y el auto está terminado y pagado
      if (hideDonePaid && isDoneAndPaid && currentFilter === 'all' && !term) {
        shouldHideDonePaid = true;
        hiddenDonePaidCount++;
      }

      if (matchesSearch && matchesCategory && !shouldHideDonePaid) {
        card.style.display = '';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });

    // Actualizar contadores en la cabecera de cada columna de hora
    document.querySelectorAll('.pickup-column').forEach((col) => {
      const cardsInCol = col.querySelectorAll('.vehicle-card');
      const visibleInCol = Array.from(cardsInCol).filter((c) => c.style.display !== 'none').length;
      const countSpan = col.querySelector('header > span');
      const displayCount = term || currentFilter !== 'all' || hideDonePaid ? visibleInCol : cardsInCol.length;
      if (countSpan) countSpan.textContent = displayCount;
      const hourCount = col.querySelector('.hour-count');
      if (hourCount) hourCount.textContent = `· ${displayCount} carro${displayCount === 1 ? '' : 's'}`;

      let emptyNote = col.querySelector('.empty-filter-note');
      if (visibleInCol === 0 && cardsInCol.length > 0) {
        if (!emptyNote) {
          emptyNote = document.createElement('div');
          emptyNote.className = 'empty-filter-note';
          col.querySelector('.pickup-stack')?.appendChild(emptyNote);
        }
        emptyNote.textContent = 'Sin autos en este filtro';
        emptyNote.style.display = '';
      } else if (emptyNote) {
        emptyNote.style.display = 'none';
      }
    });

    // Actualizar texto del contador de estado
    const counterEl = document.getElementById('filtered-counter');
    if (counterEl) {
      if (hiddenDonePaidCount > 0 && currentFilter === 'all') {
        counterEl.innerHTML = `👁️ <b>${hiddenDonePaidCount}</b> terminados y cobrados ocultos`;
      } else {
        counterEl.textContent = `${visibleCount} vehículo${visibleCount === 1 ? '' : 's'}`;
      }
    }

    const result = document.getElementById('plate-search-result');
    if (result) {
      result.replaceChildren();
      result.hidden = term.length < 2;
      if (term.length >= 2) {
        const match = [...cards].find((card) => card.querySelector('.plate-number')?.textContent?.toLowerCase().includes(term));
        if (match) {
          const title = document.createElement('strong');
          title.textContent = `${match.querySelector('.plate-number')?.textContent.trim()} · ${match.querySelector('.card-model')?.textContent.trim().replace(/^·\s*/, '') || 'Vehículo'}`;
          const details = document.createElement('span');
          details.textContent = `${match.querySelector('.card-service-name')?.textContent.trim() || 'Sin servicio'} · ${match.querySelector('.status-badge')?.textContent.trim() || ''} · ${match.querySelector('.payment-badge')?.textContent.trim() || ''}`;
          const link = document.createElement('a');
          link.href = `#${match.id}`;
          link.textContent = 'Ver en agenda →';
          result.append(title, details, link);
        } else {
          result.textContent = 'No se encontró esa placa en la fecha seleccionada.';
        }
      }
    }
  }

  function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    applyFilters();
  }

  // Clicks en píldoras de filtro
  document.querySelectorAll('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFilter(btn.dataset.filter);
    });
  });

  // Clicks en tarjetas de resumen superior (Vehículos, Pendientes, En proceso, Terminados, Cobrado)
  document.addEventListener('click', (event) => {
    const item = event.target.closest('[data-summary-filter]');
    if (!item) return;
    setFilter(item.dataset.summaryFilter);
    document.querySelector('.board-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Toggle de ocultar terminados y pagados (activado por defecto)
  if (toggleHideDonePaid) {
    const savedToggle = localStorage.getItem('hideDonePaidBookings');
    if (savedToggle !== null) {
      toggleHideDonePaid.checked = savedToggle === 'true';
    } else {
      toggleHideDonePaid.checked = true;
    }
    toggleHideDonePaid.addEventListener('change', () => {
      localStorage.setItem('hideDonePaidBookings', String(toggleHideDonePaid.checked));
      applyFilters();
    });
  }

  // Búsqueda en el tablero
  const searchInput = document.getElementById('board-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      applyFilters();
    });
  }

  applyFilters();

  // Ocultar horas vacías
  const filterBtn = document.getElementById('toggle-empty-hours');
  function applyEmptyHoursFilter() {
    if (!filterBtn) return;
    const hideEmpty = localStorage.getItem('hideEmptyHours') === 'true';
    filterBtn.classList.toggle('active', hideEmpty);
    const textSpan = filterBtn.querySelector('.filter-text');
    if (textSpan) textSpan.textContent = hideEmpty ? 'Ver todas' : 'Solo con autos';
    document.querySelectorAll('.pickup-column').forEach((col) => {
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

  // Temporizador en vivo para vehículos en progreso
  const completionRefreshRequested = new Set();
  function updateWashTimers() {
    let hasFinishedWashing = false;
    document.querySelectorAll('[data-wash-timer]').forEach((timer) => {
      const card = timer.closest('.vehicle-card');
      if (!card) return;
      const startedAt = card.dataset.startedAt;
      const vehicleType = card.dataset.vehicleType;
      if (!startedAt) return;
      const startedMs = Date.parse(startedAt);
      if (isNaN(startedMs)) return;

      const durationMinutes = vehicleType === 'small_suv' || vehicleType === 'large_suv' ? 45 : 30;
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
        const completionKey = `${card.id}:${startedAt}`;
        if (!completionRefreshRequested.has(completionKey)) {
          completionRefreshRequested.add(completionKey);
          hasFinishedWashing = true;
        }
      }
    });

    if (hasFinishedWashing) {
      silentRefresh();
    }
  }

  // Animación de datos actualizados tras regresar al panel
  function checkUpdatedParam() {
    const urlParams = new URLSearchParams(window.location.search);
    const updatedId = urlParams.get('updated');
    if (!updatedId) return;

    const targetCard = document.getElementById(`booking-${updatedId}`);
    if (targetCard) {
      setTimeout(() => {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);

      targetCard.classList.add('card-just-updated');

      const badge = document.createElement('div');
      badge.className = 'updated-floating-badge';
      badge.innerHTML = '✨ ¡Datos actualizados!';
      targetCard.prepend(badge);

      setTimeout(() => {
        targetCard.classList.remove('card-just-updated');
        badge.classList.add('fade-out');
        setTimeout(() => badge.remove(), 600);
      }, 4000);
    }
  }

  checkUpdatedParam();

  window.setInterval(updateWashTimers, 5000);
  updateWashTimers();
})();

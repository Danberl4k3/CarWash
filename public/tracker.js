(() => {
  const trackerEl = document.querySelector('[data-booking-tracker]');
  if (!trackerEl) return;

  const code = trackerEl.dataset.code;
  if (!code) return;

  const statusBadge = document.getElementById('tracker-status-badge');
  const timerCard = document.getElementById('tracker-timer-card');
  const timerRemain = document.getElementById('tracker-timer-remain');
  const timerBar = document.getElementById('tracker-timer-bar');
  const steps = document.querySelectorAll('.tracker-step');

  const statusOrder = ['pending', 'in_progress', 'completed'];

  function updateSteps(status) {
    const currentIdx = statusOrder.indexOf(status);
    steps.forEach((step, idx) => {
      const isPast = currentIdx > idx;
      const isCurrent = currentIdx === idx;
      step.classList.toggle('step-done', isPast);
      step.classList.toggle('step-current', isCurrent);
      step.classList.toggle('step-waiting', !isPast && !isCurrent);
    });

    const progressTrack = document.getElementById('tracker-stepper-progress');
    if (progressTrack) {
      const percentage = currentIdx <= 0 ? 15 : currentIdx === 1 ? 55 : 100;
      progressTrack.style.width = `${percentage}%`;
    }
  }

  function updateTimer(startedAt, durationMinutes) {
    if (!startedAt || !timerCard) {
      if (timerCard) timerCard.style.display = 'none';
      return;
    }
    const startedMs = Date.parse(startedAt);
    if (isNaN(startedMs)) return;

    timerCard.style.display = 'block';
    const elapsedMs = Date.now() - startedMs;
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
    const remaining = Math.max(0, durationMinutes - elapsedMinutes);
    const percent = Math.min(100, Math.max(0, (elapsedMs / (durationMinutes * 60 * 1000)) * 100));

    if (timerRemain) {
      timerRemain.textContent = remaining > 0 ? `aprox. ${remaining} min restantes` : '¡Lavado casi listo!';
    }
    if (timerBar) {
      timerBar.style.width = `${percent}%`;
    }
  }

  async function checkStatus() {
    try {
      const res = await fetch(`/api/reserva/${encodeURIComponent(code)}/status`);
      if (!res.ok) return;
      const data = await res.json();

      if (statusBadge) {
        statusBadge.textContent = data.statusLabel;
        statusBadge.className = `status-badge badge-${data.status}`;
      }

      updateSteps(data.status);

      if (data.status === 'in_progress' && data.startedWashingAt) {
        updateTimer(data.startedWashingAt, data.durationMinutes || 30);
      } else if (timerCard) {
        timerCard.style.display = 'none';
      }

      const paymentBadge = document.getElementById('tracker-payment-badge');
      if (paymentBadge) {
        paymentBadge.textContent = data.paymentStatus === 'paid' ? 'Pagado ✓' : 'Pendiente de pago';
        paymentBadge.className = `payment-badge badge-${data.paymentStatus}`;
      }
    } catch {
      // Ignorar errores transitorios de red
    }
  }

  // Intervalo de sondeo en segundo plano
  window.setInterval(checkStatus, 8000);
  window.setInterval(() => {
    const startedAt = trackerEl.dataset.startedAt;
    const duration = Number(trackerEl.dataset.duration || 30);
    if (startedAt && trackerEl.dataset.status === 'in_progress') {
      updateTimer(startedAt, duration);
    }
  }, 3000);
})();

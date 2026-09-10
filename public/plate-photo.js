(() => {
  const form = document.querySelector('#booking-form');
  const input = form?.querySelector('[data-plate-photo]');
  const status = form?.querySelector('[data-photo-status]');
  const suggestion = form?.querySelector('[data-photo-suggestion]');
  const plate = form?.querySelector('[name="plate"]');
  if (!form || !input || !plate) return;
  const normalize = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!window.Tesseract) { if (status) status.textContent = 'No se pudo activar la lectura; ingresa la placa manualmente.'; return; }
    if (status) status.textContent = 'Leyendo placa en el dispositivo...';
    try {
      const worker = await window.Tesseract.createWorker('eng', 1, { logger: (info) => { if (info.status === 'recognizing text' && status) status.textContent = `Leyendo placa... ${Math.round(info.progress * 100)}%`; } });
      const result = await worker.recognize(file);
      await worker.terminate();
      const candidates = String(result.data.text || '').toUpperCase().match(/[A-Z0-9]{6,8}/g) || [];
      const detected = candidates.map(normalize).find((value) => /^[A-Z0-9]{6,8}$/.test(value));
      if (!detected) throw new Error('not-found');
      if (suggestion) { suggestion.textContent = `Placa detectada: ${detected}`; suggestion.hidden = false; }
      if (status) status.textContent = 'Revisa la lectura y confirma para consultar los datos.';
      const confirm = form.querySelector('[data-use-photo-plate]');
      if (confirm) { confirm.hidden = false; confirm.onclick = () => { plate.value = detected; plate.dispatchEvent(new Event('input', { bubbles: true })); plate.dispatchEvent(new Event('blur', { bubbles: true })); confirm.hidden = true; }; }
    } catch { if (status) status.textContent = 'No se pudo leer la placa. Toma otra foto con buena luz o ingrésala manualmente.'; }
  });
})();

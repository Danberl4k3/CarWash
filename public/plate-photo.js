(() => {
  'use strict';
  const form = document.querySelector('#booking-form');
  if (!form) return;
  const fileInput = form.querySelector('[data-plate-photo]');
  const plateInput = form.querySelector('[name="plate"]');
  const status = form.querySelector('[data-photo-status]');
  const suggestion = form.querySelector('[data-photo-suggestion]');
  const useButton = form.querySelector('[data-use-photo-plate]');
  if (!fileInput || !plateInput) return;

  const patterns = [
    { regex: /^[A-Z]{3}\d{3}$/, format: (value) => `${value.slice(0, 3)}-${value.slice(3)}` },
    { regex: /^[A-Z]{2}\d{4}$/, format: (value) => `${value.slice(0, 2)}-${value.slice(2)}` },
  ];
  const setStatus = (message) => { if (status) status.textContent = message || ''; };
  const hideSuggestion = () => {
    if (suggestion) { suggestion.hidden = true; suggestion.textContent = ''; }
    if (useButton) useButton.hidden = true;
  };
  const findPlate = (text) => {
    const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (let index = 0; index < clean.length; index += 1) {
      const candidate = clean.slice(index, index + 6);
      for (const pattern of patterns) if (pattern.regex.test(candidate)) return pattern.format(candidate);
    }
    return null;
  };
  const loadImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    image.src = url;
  });
  const processedImage = (image) => {
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * 2));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * 2));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const values = pixels.data;
    for (let index = 0; index < values.length; index += 4) {
      const gray = 0.299 * values[index] + 0.587 * values[index + 1] + 0.114 * values[index + 2];
      const contrast = Math.max(0, Math.min(255, 1.6 * gray - 76.8));
      values[index] = contrast; values[index + 1] = contrast; values[index + 2] = contrast;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  };
  const recognize = async (worker, source) => {
    const result = await worker.recognize(source);
    const plate = findPlate(result?.data?.text);
    return plate ? { plate, confidence: Number(result?.data?.confidence || 0) } : null;
  };

  async function readPlate(file) {
    hideSuggestion();
    if (!window.Tesseract?.createWorker) {
      setStatus('No se pudo cargar el lector. Ingresa la placa manualmente.');
      return;
    }
    setStatus('Procesando imagen...');
    let worker;
    try {
      const image = await loadImage(file);
      worker = await window.Tesseract.createWorker('eng', 1, { logger: () => {} });
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
        tessedit_pageseg_mode: '7',
      });
      setStatus('Reconociendo placa...');
      const results = [await recognize(worker, image), await recognize(worker, processedImage(image))].filter(Boolean);
      if (!results.length) {
        setStatus('No se detectó la placa. Toma una foto más cercana y con buena luz.');
        return;
      }
      results.sort((first, second) => second.confidence - first.confidence);
      const best = results[0];
      setStatus('Revisa la placa detectada:');
      if (suggestion) { suggestion.textContent = best.plate; suggestion.hidden = false; }
      if (useButton) {
        useButton.hidden = false;
        useButton.onclick = (event) => {
          event.preventDefault();
          plateInput.value = best.plate;
          plateInput.dispatchEvent(new Event('input', { bubbles: true }));
          plateInput.dispatchEvent(new Event('blur', { bubbles: true }));
          hideSuggestion();
          setStatus(`Placa aplicada: ${best.plate}`);
        };
      }
    } catch {
      setStatus('No se pudo procesar la foto. Ingresa la placa manualmente.');
    } finally {
      if (worker) { try { await worker.terminate(); } catch {} }
    }
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void readPlate(file);
    else hideSuggestion();
  });
})();

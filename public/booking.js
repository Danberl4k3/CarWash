(() => {
  const form = document.querySelector('#booking-form');
  if (!form) return;

  let catalog = [];
  try {
    catalog = JSON.parse(form.dataset.catalog || '[]');
  } catch {
    catalog = [];
  }

  const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
  const selectedValue = (name) => {
    const checked = form.querySelector(`[name="${name}"]:checked`);
    if (checked) return checked.value;
    return form.querySelector(`[name="${name}"]`)?.value || '';
  };

  const selectedVehicle = () => selectedValue('vehicleType');
  const selectedBaseId = () => Number(selectedValue('baseServiceId'));
  const selectedBase = () => catalog.find((service) => service.id === selectedBaseId());
  const selectedAddons = () => [...form.querySelectorAll('[name="addonServiceIds"]:checked')]
    .map((input) => catalog.find((service) => service.id === Number(input.value)))
    .filter(Boolean);

  function servicePrice(service) {
    return Number(service?.prices?.[selectedVehicle()] || 0);
  }

  function refreshPrices() {
    document.querySelectorAll('[data-service-price]').forEach((element) => {
      const service = catalog.find((item) => item.id === Number(element.dataset.servicePrice));
      const cents = servicePrice(service);
      element.textContent = cents ? money.format(cents / 100) : 'Por definir';
    });
    const total = [selectedBase(), ...selectedAddons()].reduce((sum, service) => sum + servicePrice(service), 0);
    const totalElement = document.querySelector('#booking-total');
    if (totalElement) totalElement.textContent = money.format(total / 100);
  }

  function refreshAddonRules() {
    const base = selectedBase();
    form.querySelectorAll('[data-incompatible-interior="1"]').forEach((label) => {
      const input = label.querySelector('input');
      const disabled = base?.slug === 'interior';
      input.disabled = disabled;
      if (disabled) input.checked = false;
      label.classList.toggle('is-disabled', disabled);
      label.title = disabled ? 'No disponible con lavado interior' : '';
    });
    refreshPrices();
  }

  function refreshVehicleRules() {
    const motorcycle = selectedVehicle() === 'motorcycle';
    const baseInputs = [...form.querySelectorAll('[name="baseServiceId"]')];
    const baseChoices = baseInputs.flatMap((input) =>
      input.tagName === 'SELECT' ? [...input.querySelectorAll('option')] : [input],
    );
    baseChoices.forEach((input) => {
      const isMotorcycleService = input.dataset.slug === 'motorcycle-wash';
      const option = input.tagName === 'OPTION' ? input : input.closest('label');
      const hidden = motorcycle ? !isMotorcycleService : isMotorcycleService;
      if (option) {
        option.hidden = hidden;
        option.style.display = hidden ? 'none' : '';
      }
      if (input.tagName !== 'OPTION') input.disabled = hidden;
    });

    // Moto solo tiene lavado simple (ocultar adicionales para motos)
    const addonFieldset = form.querySelector('.addon-grid')?.closest('fieldset');
    if (addonFieldset) {
      addonFieldset.hidden = motorcycle;
      addonFieldset.style.display = motorcycle ? 'none' : '';
      if (motorcycle) {
        form.querySelectorAll('[name="addonServiceIds"]').forEach((input) => {
          input.checked = false;
        });
      }
    }

    const selected = baseChoices.find((input) =>
      !input.disabled
      && (input.tagName === 'OPTION' ? input.selected : input.checked)
      && !(input.tagName === 'OPTION' ? input.hidden : input.closest('label')?.hidden),
    );
    if (!selected) {
      const next = baseChoices.find((input) => !input.disabled && !input.hidden);
      if (next) {
        if (next.tagName === 'OPTION') next.selected = true;
        else next.checked = true;
      }
    }
    refreshAddonRules();
  }

  function refreshPickupOptions() {
    const pickup = form.querySelector('#pickup-time');
    if (!pickup || pickup.tagName !== 'SELECT') return;
    const previous = pickup.value;
    pickup.replaceChildren(new Option('Selecciona una hora', ''));
    for (let total = 0; total < 24 * 60; total += 10) {
      const hour = Math.floor(total / 60); const minute = total % 60;
      const option = document.createElement('option'); option.value = `${hour}:${String(minute).padStart(2, '0')}`;
      option.textContent = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'p. m.' : 'a. m.'}`;
      pickup.appendChild(option);
    }
    if ([...pickup.options].some((o) => o.value === previous)) pickup.value = previous;
    refreshPhoneRule();
  }

  function refreshPhoneRule() {
    const required = false;
    const phone = form.querySelector('#phone');
    const optional = form.querySelector('#phone-optional');
    const rule = form.querySelector('#phone-rule');
    if (phone) phone.required = required;
    if (optional) optional.textContent = required ? 'Obligatorio' : 'Opcional';
    if (rule) rule.hidden = !required;
    form.querySelector('#phone-field')?.classList.toggle('required-field', required);
  }

  form.addEventListener('change', (event) => {
    const name = event.target?.name;
    if (name === 'vehicleType') refreshVehicleRules();
    if (name === 'baseServiceId') refreshAddonRules();
    if (name === 'addonServiceIds') refreshPrices();
    if (name === 'pickupTime') refreshPhoneRule();
    if (name === 'dropoffHour' || name === 'dropoffMinute') refreshPickupOptions();
  });

  // Uppercase for license plate & auto-lookup
  // Uppercase for license plate, OCR & auto-lookup
  const plateInput = form.querySelector('input[name="plate"]');
  const scanBtn = form.querySelector('#btn-scan-plate');
  const lookupBtn = form.querySelector('#btn-lookup-plate');
  const cameraInput = form.querySelector('#plate-camera-input');
  const feedbackEl = form.querySelector('#plate-feedback');

  function showFeedback(html, type = 'info', autoHide = 0) {
    if (!feedbackEl) return;
    feedbackEl.className = `plate-feedback plate-feedback-${type}`;
    feedbackEl.innerHTML = html;
    feedbackEl.style.display = 'block';
    if (autoHide > 0) {
      clearTimeout(feedbackEl._hideTimer);
      feedbackEl._hideTimer = setTimeout(() => {
        feedbackEl.style.display = 'none';
      }, autoHide);
    }
  }

  function applyVehicleData(data) {
    const nameInput = form.querySelector('input[name="name"]');
    const modelInput = form.querySelector('input[name="model"]');
    if (nameInput && !nameInput.value && data.name) {
      nameInput.value = data.name;
    }
    const modelText = data.fullModel || data.model || data.modelo;
    if (modelInput && modelText) {
      modelInput.value = modelText;
      modelInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (data.vehicleType) {
      const typeRadio = form.querySelector(`input[name="vehicleType"][value="${data.vehicleType}"]`);
      if (typeRadio) {
        typeRadio.checked = true;
        typeRadio.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const typeSelect = form.querySelector('select[name="vehicleType"]');
        if (typeSelect) {
          typeSelect.value = data.vehicleType;
          typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  }

  let lastLookupPlate = '';
  async function performPlateLookup(force = false) {
    if (!plateInput) return;
    const plate = plateInput.value.trim().toUpperCase();
    if (plate.length < 4) return;
    if (!force && plate === lastLookupPlate) return;
    lastLookupPlate = plate;

    showFeedback('<span class="plate-spinner"></span> Consultando placa en SUNARP / Sistema...', 'loading');

    try {
      const res = await fetch('/api/placa/consultar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placa: plate }),
      });

      if (!res.ok) {
        showFeedback('No se pudo consultar la placa', 'warning', 4000);
        return;
      }

      const data = await res.json();
      if (data && data.found) {
        applyVehicleData(data);
        const sourceLabel = data.source === 'local' ? 'Cliente registrado' : 'SUNARP oficial';
        const modelDesc = data.fullModel || data.modelo || data.model || '';
        const typeDesc = data.vehicleTypeLabel ? ` · ${data.vehicleTypeLabel}` : '';
        showFeedback(`✓ <strong>${sourceLabel}:</strong> ${modelDesc}${typeDesc}`, 'success', 6000);
      } else {
        showFeedback(`ℹ️ Placa <strong>${plate}</strong> no encontrada en SUNARP. Puedes continuar con el registro manual.`, 'info', 5000);
      }
    } catch {
      showFeedback('Error de conexión al consultar la placa', 'warning', 4000);
    }
  }

  function compressImage(file, maxDimension = 1200, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let width = img.width;
          let height = img.height;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleOcrUpload(file) {
    if (!file) return;
    showFeedback('<span class="plate-spinner"></span> Escaneando placa con OCR...', 'loading');

    try {
      const base64Data = await compressImage(file);
      const res = await fetch('/api/placa/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Data, autoLookup: true }),
      });

      if (!res.ok) {
        showFeedback('Error en el servicio de escaneo OCR', 'warning', 5000);
        return;
      }

      const ocrResult = await res.json();
      if (ocrResult.legible && ocrResult.placa) {
        if (plateInput) {
          plateInput.value = ocrResult.placa;
          plateInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const confidencePct = Math.round((ocrResult.confianza || 0.95) * 100);
        let msg = `✓ Placa: <strong>${ocrResult.placa}</strong> (${confidencePct}% confianza)`;
        if (ocrResult.notas) {
          msg += `<br><small style="color:var(--text-muted)">Nota: ${ocrResult.notas}</small>`;
        }

        if (ocrResult.vehicle && ocrResult.vehicle.found) {
          applyVehicleData(ocrResult.vehicle);
          const vehicleDesc = ocrResult.vehicle.fullModel || ocrResult.vehicle.modelo || '';
          const typeDesc = ocrResult.vehicle.vehicleTypeLabel ? ` · ${ocrResult.vehicle.vehicleTypeLabel}` : '';
          msg += `<br>🚗 <strong>SUNARP:</strong> ${vehicleDesc}${typeDesc}`;
        }

        showFeedback(msg, 'success', 8000);
      } else {
        const errorMsg = ocrResult.notas || 'No se detectó placa legible en la imagen. Intenta enfocar más cerca.';
        showFeedback(`⚠️ ${errorMsg}`, 'warning', 6000);
      }
    } catch {
      showFeedback('No se pudo procesar la imagen para OCR', 'warning', 5000);
    }
  }

  if (scanBtn && cameraInput) {
    scanBtn.addEventListener('click', () => {
      cameraInput.click();
    });
    cameraInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        handleOcrUpload(file);
      }
      cameraInput.value = '';
    });
  }

  if (lookupBtn) {
    lookupBtn.addEventListener('click', () => {
      performPlateLookup(true);
    });
  }

  if (plateInput) {
    plateInput.addEventListener('input', () => {
      const start = plateInput.selectionStart;
      const end = plateInput.selectionEnd;
      plateInput.value = plateInput.value.toUpperCase();
      if (start !== null && end !== null) {
        plateInput.setSelectionRange(start, end);
      }
      if (plateInput.value.trim().length >= 6) {
        clearTimeout(plateInput._timer);
        plateInput._timer = setTimeout(() => performPlateLookup(false), 900);
      }
    });
    plateInput.addEventListener('blur', () => performPlateLookup(false));
  }

  // Auto-capitalization for customer name and model
  const capitalize = (str) => {
    return str
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  [form.querySelector('input[name="name"]'), form.querySelector('input[name="model"]')].forEach((input) => {
    if (!input) return;
    input.addEventListener('blur', () => {
      if (input.value) {
        input.value = capitalize(input.value);
      }
    });
  });

  form.addEventListener('submit', (event) => {
    if (plateInput) plateInput.value = plateInput.value.toUpperCase().trim();
    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput && nameInput.value.trim()) nameInput.value = capitalize(nameInput.value);
    const modelInput = form.querySelector('input[name="model"]');
    if (modelInput && modelInput.value.trim()) modelInput.value = capitalize(modelInput.value);

  });
  form.querySelectorAll('[data-pickup-offset]').forEach((button) => button.addEventListener('click', () => {
    const dropoffHour = Number(form.querySelector('#dropoff-hour')?.value || 0);
    const dropoffMinute = Number(form.querySelector('#dropoff-minute')?.value || 0);
    const base = dropoffHour * 60 + dropoffMinute;
    const target = (base + Number(button.dataset.pickupOffset)) % 1440;
    const pickup = form.querySelector('#pickup-time');
    if (!pickup) return;
    const hour = Math.floor(target / 60);
    const minute = target % 60;
    if (pickup.tagName === 'SELECT') {
      pickup.value = `${hour}:${String(minute).padStart(2, '0')}`;
    } else {
      pickup.value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    pickup.dispatchEvent(new Event('input', { bubbles: true }));
    pickup.dispatchEvent(new Event('change', { bubbles: true }));
  }));

  refreshAddonRules();
  refreshVehicleRules();
  refreshPickupOptions();
  form.querySelector('#pickup-time')?.dispatchEvent(new Event('change'));
  refreshPhoneRule();
})();

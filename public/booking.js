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

  function servicePrice(service, vehType = selectedVehicle()) {
    return Number(service?.prices?.[vehType] || 0);
  }

  function refreshPrices() {
    document.querySelectorAll('[data-service-price]').forEach((element) => {
      const service = catalog.find((item) => item.id === Number(element.dataset.servicePrice));
      const cents = servicePrice(service);
      element.textContent = cents ? money.format(cents / 100) : 'Por definir';
    });
    
    // Total del carro activo
    const carTotal = [selectedBase(), ...selectedAddons()].reduce((sum, service) => sum + servicePrice(service), 0);
    const carActiveTotalEl = document.querySelector('#car-active-total');
    if (carActiveTotalEl) carActiveTotalEl.textContent = money.format(carTotal / 100);

    // Actualizar datos del carro activo en memoria
    saveActiveCarFromForm();
    updateGlobalTotals();
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

  // =========================================================================
  // GESTIÓN MULTI-CARROS (POR DEFECTO 2 TARJETITAS)
  // =========================================================================
  const defaultDropoffHour = Number(form.querySelector('#dropoff-hour')?.value || form.dataset.nowHour || 8);
  const defaultDropoffMinute = Number(form.querySelector('#dropoff-minute')?.value || 0);

  let cars = [
    {
      id: 1,
      plate: '',
      model: '',
      name: '',
      phone: '',
      paymentMethod: 'yape',
      notes: '',
      vehicleType: 'car',
      dropoffHour: defaultDropoffHour,
      dropoffMinute: defaultDropoffMinute,
      pickupTime: '',
      baseServiceId: null,
      addonServiceIds: [],
    },
    {
      id: 2,
      plate: '',
      model: '',
      name: '',
      phone: '',
      paymentMethod: 'yape',
      notes: '',
      vehicleType: 'small_suv',
      dropoffHour: defaultDropoffHour,
      dropoffMinute: defaultDropoffMinute,
      pickupTime: '',
      baseServiceId: null,
      addonServiceIds: [],
    },
  ];

  let activeCarIndex = 0;

  function calculateCarCost(car) {
    if (!car) return 0;
    const base = catalog.find((s) => s.id === Number(car.baseServiceId));
    let cents = servicePrice(base, car.vehicleType);
    if (car.addonServiceIds && car.addonServiceIds.length) {
      car.addonServiceIds.forEach((id) => {
        const addon = catalog.find((s) => s.id === Number(id));
        cents += servicePrice(addon, car.vehicleType);
      });
    }
    return cents;
  }

  function updateGlobalTotals() {
    let grandTotalCents = 0;
    cars.forEach((car, idx) => {
      if (idx === activeCarIndex) {
        const carTotal = [selectedBase(), ...selectedAddons()].reduce((sum, service) => sum + servicePrice(service), 0);
        grandTotalCents += carTotal;
      } else {
        grandTotalCents += calculateCarCost(car);
      }
    });

    const totalElement = document.querySelector('#booking-total');
    if (totalElement) totalElement.textContent = money.format(grandTotalCents / 100);

    const countBadge = document.querySelector('#cars-count-badge');
    if (countBadge) countBadge.textContent = `${cars.length} ${cars.length === 1 ? 'carro' : 'carros'}`;

    const totalCountEl = document.querySelector('#booking-cars-total-count');
    if (totalCountEl) totalCountEl.textContent = `${cars.length} ${cars.length === 1 ? 'carro' : 'carros'}`;

    renderCarCardsBadges();
  }

  function renderCarCards() {
    const container = document.querySelector('#car-cards-container');
    if (!container) return;

    let html = '';
    cars.forEach((car, index) => {
      const isActive = index === activeCarIndex;
      const cost = (index === activeCarIndex)
        ? [selectedBase(), ...selectedAddons()].reduce((sum, s) => sum + servicePrice(s), 0)
        : calculateCarCost(car);
      const displayPlate = car.plate.trim() || `Carro #${index + 1}`;
      const vehLabel = {
        car: 'Auto',
        small_suv: 'SUV pequeña',
        large_suv: 'SUV grande',
        motorcycle: 'Moto',
        pickup: 'Pickup',
      }[car.vehicleType] || 'Auto';

      html += `
        <div class="car-tab-card ${isActive ? 'active' : ''}" data-car-index="${index}">
          <div class="car-tab-top">
            <span class="car-number-badge">Carro ${index + 1}</span>
            ${cars.length > 1 ? `
              <button type="button" class="btn-delete-car" title="Eliminar vehículo" data-remove-index="${index}">✕</button>
            ` : ''}
          </div>
          <div class="car-tab-plate">${displayPlate}</div>
          <div class="car-tab-details">
            <span>${vehLabel}</span>
            <span class="car-tab-price">${money.format(cost / 100)}</span>
          </div>
        </div>
      `;
    });

    html += `
      <button type="button" class="btn-add-car-card" id="btn-add-car">
        <div class="plus-icon">+</div>
        <span>Agregar Carro</span>
      </button>
    `;

    container.innerHTML = html;

    container.querySelectorAll('.car-tab-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-car')) return;
        const idx = parseInt(card.getAttribute('data-car-index'), 10);
        switchActiveCar(idx);
      });
    });

    container.querySelectorAll('.btn-delete-car').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-remove-index'), 10);
        removeCar(idx);
      });
    });

    document.querySelector('#btn-add-car')?.addEventListener('click', addNewCar);
  }

  function renderCarCardsBadges() {
    const cards = document.querySelectorAll('#car-cards-container .car-tab-card');
    cards.forEach((card, idx) => {
      const car = cars[idx];
      if (!car) return;
      const cost = (idx === activeCarIndex)
        ? [selectedBase(), ...selectedAddons()].reduce((sum, s) => sum + servicePrice(s), 0)
        : calculateCarCost(car);
      const plateEl = card.querySelector('.car-tab-plate');
      if (plateEl) plateEl.textContent = car.plate.trim() || `Carro #${idx + 1}`;
      const priceEl = card.querySelector('.car-tab-price');
      if (priceEl) priceEl.textContent = money.format(cost / 100);
    });
  }

  function saveActiveCarFromForm() {
    const car = cars[activeCarIndex];
    if (!car) return;

    const plateInput = form.querySelector('input[name="plate"]');
    if (plateInput) car.plate = plateInput.value.trim().toUpperCase();

    const modelInput = form.querySelector('input[name="model"]');
    if (modelInput) car.model = modelInput.value.trim();

    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput) car.name = nameInput.value.trim();

    const phoneInput = form.querySelector('input[name="phone"]');
    if (phoneInput) car.phone = phoneInput.value.trim();

    const paymentSelect = form.querySelector('select[name="paymentMethod"]');
    if (paymentSelect) car.paymentMethod = paymentSelect.value;

    const notesText = form.querySelector('textarea[name="notes"]');
    if (notesText) car.notes = notesText.value.trim();

    car.vehicleType = selectedVehicle();
    car.baseServiceId = selectedBaseId();
    car.addonServiceIds = selectedAddons().map((s) => s.id);

    const pickup = form.querySelector('#pickup-time');
    if (pickup) car.pickupTime = pickup.value;
  }

  function loadActiveCarIntoForm() {
    const car = cars[activeCarIndex];
    if (!car) return;

    const plateInput = form.querySelector('input[name="plate"]');
    if (plateInput) plateInput.value = car.plate || '';

    const modelInput = form.querySelector('input[name="model"]');
    if (modelInput) modelInput.value = car.model || '';

    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput) nameInput.value = car.name || '';

    const phoneInput = form.querySelector('input[name="phone"]');
    if (phoneInput) phoneInput.value = car.phone || '';

    const paymentSelect = form.querySelector('select[name="paymentMethod"]');
    if (paymentSelect && car.paymentMethod) paymentSelect.value = car.paymentMethod;

    const notesText = form.querySelector('textarea[name="notes"]');
    if (notesText) notesText.value = car.notes || '';

    const typeRadio = form.querySelector(`input[name="vehicleType"][value="${car.vehicleType}"]`);
    if (typeRadio) {
      typeRadio.checked = true;
    }

    const pickup = form.querySelector('#pickup-time');
    if (pickup && car.pickupTime) pickup.value = car.pickupTime;

    refreshVehicleRules();

    if (car.baseServiceId) {
      const baseRadio = form.querySelector(`input[name="baseServiceId"][value="${car.baseServiceId}"]`);
      if (baseRadio && !baseRadio.disabled) baseRadio.checked = true;
    }

    form.querySelectorAll('input[name="addonServiceIds"]').forEach((input) => {
      input.checked = Boolean(car.addonServiceIds && car.addonServiceIds.includes(Number(input.value)));
    });

    refreshAddonRules();
  }

  function switchActiveCar(newIndex) {
    if (newIndex === activeCarIndex) return;
    saveActiveCarFromForm();
    activeCarIndex = newIndex;
    renderCarCards();
    loadActiveCarIntoForm();
  }

  function addNewCar() {
    saveActiveCarFromForm();
    const newId = cars.length > 0 ? Math.max(...cars.map((c) => c.id)) + 1 : 1;
    cars.push({
      id: newId,
      plate: '',
      model: '',
      name: '',
      phone: '',
      paymentMethod: 'yape',
      notes: '',
      vehicleType: 'car',
      dropoffHour: defaultDropoffHour,
      dropoffMinute: defaultDropoffMinute,
      pickupTime: '',
      baseServiceId: null,
      addonServiceIds: [],
    });
    activeCarIndex = cars.length - 1;
    renderCarCards();
    loadActiveCarIntoForm();
    slideToStep(1);
  }

  function removeCar(index) {
    if (cars.length <= 1) return;
    cars.splice(index, 1);
    if (activeCarIndex >= cars.length) {
      activeCarIndex = cars.length - 1;
    }
    renderCarCards();
    loadActiveCarIntoForm();
  }

  // =========================================================================
  // DESLIZADOR HORIZONTAL DE PASOS 1, 2, 3, 4, 5
  // =========================================================================
  let currentStep = 1;
  const TOTAL_STEPS = 5;

  function slideToStep(stepNumber) {
    if (stepNumber < 1) stepNumber = 1;
    if (stepNumber > TOTAL_STEPS) stepNumber = TOTAL_STEPS;
    currentStep = stepNumber;

    saveActiveCarFromForm();
    updateGlobalTotals();

    const track = document.querySelector('#slider-track');
    if (track) {
      const offsetPercent = (stepNumber - 1) * 20;
      track.style.transform = `translateX(-${offsetPercent}%)`;
    }

    const progressFill = document.querySelector('#stepper-progress-fill');
    if (progressFill) {
      progressFill.style.width = `${(stepNumber / TOTAL_STEPS) * 100}%`;
    }

    document.querySelectorAll('#step-tabs-nav .step-btn').forEach((btn) => {
      const step = parseInt(btn.getAttribute('data-step'), 10);
      btn.classList.toggle('active', step === currentStep);
      btn.classList.toggle('completed', step < currentStep);
    });

    const btnPrev = document.querySelector('#btn-slide-prev');
    const btnNext = document.querySelector('#btn-slide-next');

    if (btnPrev) btnPrev.disabled = currentStep === 1;
    if (btnNext) {
      if (currentStep === TOTAL_STEPS) {
        if (activeCarIndex < cars.length - 1) {
          btnNext.innerHTML = `➜ Siguiente Carro (${activeCarIndex + 2}/${cars.length})`;
        } else {
          btnNext.innerHTML = `✓ Listo para confirmar`;
        }
      } else {
        btnNext.innerHTML = `Siguiente (${currentStep + 1}/5) →`;
      }
    }
  }

  // Eventos de botones de pasos
  document.querySelectorAll('#step-tabs-nav .step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = parseInt(btn.getAttribute('data-step'), 10);
      slideToStep(step);
    });
  });

  document.querySelector('#btn-slide-prev')?.addEventListener('click', () => {
    if (currentStep > 1) slideToStep(currentStep - 1);
  });

  document.querySelector('#btn-slide-next')?.addEventListener('click', () => {
    if (currentStep < TOTAL_STEPS) {
      slideToStep(currentStep + 1);
    } else {
      if (activeCarIndex < cars.length - 1) {
        switchActiveCar(activeCarIndex + 1);
        slideToStep(1);
      } else {
        const submitBtn = document.querySelector('#btn-submit-booking');
        if (submitBtn) {
          submitBtn.scrollIntoView({ behavior: 'smooth' });
          submitBtn.focus();
        }
      }
    }
  });

  // Gestos táctiles y ratón en el viewport
  const sliderViewport = document.querySelector('#slider-viewport');
  if (sliderViewport) {
    let touchStartX = 0;
    let touchEndX = 0;

    sliderViewport.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    sliderViewport.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      const diff = touchEndX - touchStartX;
      if (Math.abs(diff) > 45) {
        if (diff > 0 && currentStep > 1) slideToStep(currentStep - 1);
        if (diff < 0 && currentStep < TOTAL_STEPS) slideToStep(currentStep + 1);
      }
    }, { passive: true });

    let isMouseDown = false;
    let mouseStartX = 0;
    sliderViewport.addEventListener('mousedown', (e) => {
      // Ignorar clicks en inputs
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target?.tagName)) return;
      isMouseDown = true;
      mouseStartX = e.clientX;
    });

    window.addEventListener('mouseup', (e) => {
      if (!isMouseDown) return;
      isMouseDown = false;
      const diff = e.clientX - mouseStartX;
      if (Math.abs(diff) > 50) {
        if (diff > 0 && currentStep > 1) slideToStep(currentStep - 1);
        if (diff < 0 && currentStep < TOTAL_STEPS) slideToStep(currentStep + 1);
      }
    });
  }

  // =========================================================================
  // LISTENERS DE FORMULARIO EXISTENTES (OCR, SUNARP, CAMBIO)
  // =========================================================================
  form.addEventListener('change', (event) => {
    const name = event.target?.name;
    if (name === 'vehicleType') refreshVehicleRules();
    if (name === 'baseServiceId') refreshAddonRules();
    if (name === 'addonServiceIds') refreshPrices();
    if (name === 'pickupTime') refreshPhoneRule();
    if (name === 'dropoffHour' || name === 'dropoffMinute') refreshPickupOptions();
    saveActiveCarFromForm();
    updateGlobalTotals();
  });

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
    saveActiveCarFromForm();
    renderCarCards();
  }

  let lastLookupPlate = '';
  async function performPlateLookup(force = false) {
    if (!plateInput) return;
    const plate = plateInput.value.trim().toUpperCase();
    if (plate.length < 4) {
      if (force) {
        showFeedback('Ingresa una placa de al menos 4 caracteres (ej. ABC-123).', 'warning', 4000);
      }
      return;
    }
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
        let errMessage = 'No se pudo consultar la placa';
        try {
          const errData = await res.json();
          if (errData && errData.error) errMessage = errData.error;
        } catch {}
        showFeedback(errMessage, 'warning', 4000);
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
        let errMessage = 'Error en el servicio de escaneo OCR';
        try {
          const errData = await res.json();
          if (errData && errData.notas) errMessage = errData.notas;
        } catch {}
        showFeedback(`⚠️ ${errMessage}`, 'warning', 7000);
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
        showFeedback(`⚠️ ${errorMsg}`, 'warning', 7000);
      }
    } catch {
      showFeedback('No se pudo procesar la imagen para OCR. Verifica tu conexión.', 'warning', 5000);
    }
  }

  if (cameraInput) {
    cameraInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        handleOcrUpload(file);
      }
      cameraInput.value = '';
    });
  }

  if (scanBtn) {
    if (scanBtn.tagName === 'BUTTON') {
      scanBtn.addEventListener('click', (e) => {
        e.preventDefault();
        cameraInput?.click();
      });
    } else {
      scanBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cameraInput?.click();
        }
      });
    }
  }

  if (lookupBtn) {
    lookupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
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
      cars[activeCarIndex].plate = plateInput.value;
      renderCarCardsBadges();
      if (plateInput.value.trim().length >= 6) {
        clearTimeout(plateInput._timer);
        plateInput._timer = setTimeout(() => performPlateLookup(false), 900);
      }
    });
    plateInput.addEventListener('blur', () => performPlateLookup(false));
  }

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
        saveActiveCarFromForm();
      }
    });
  });

  // Envío del formulario: Serializar todos los vehículos configurados
  form.addEventListener('submit', () => {
    saveActiveCarFromForm();
    if (plateInput) plateInput.value = plateInput.value.toUpperCase().trim();
    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput && nameInput.value.trim()) nameInput.value = capitalize(nameInput.value);
    const modelInput = form.querySelector('input[name="model"]');
    if (modelInput && modelInput.value.trim()) modelInput.value = capitalize(modelInput.value);

    // Si hay vehículos con placa registrada, guardarlos en el payload
    const vehiclesWithData = cars.filter((c) => c.plate && c.plate.trim());
    const payloadInput = form.querySelector('#vehicles-payload');
    if (payloadInput) {
      payloadInput.value = JSON.stringify(vehiclesWithData.length > 0 ? vehiclesWithData : cars);
    }
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
    saveActiveCarFromForm();
  }));

  // Inicialización
  renderCarCards();
  loadActiveCarIntoForm();
  slideToStep(1);
})();

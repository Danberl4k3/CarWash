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

  // Almacena el paso actual de cada tarjeta de carro
  const cardSteps = {};

  function getCardElement(cardIdx) {
    return document.querySelector(`.parallel-car-card[data-car-card-index="${cardIdx}"]`);
  }

  function getCardVehicleType(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return 'car';
    const checked = card.querySelector('[data-pcar-field="vehicleType"]:checked');
    return checked ? checked.value : 'car';
  }

  function getCardBaseService(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return null;
    const checked = card.querySelector('[data-pcar-field="baseServiceId"]:checked');
    if (!checked) return null;
    return catalog.find((s) => s.id === Number(checked.value)) || null;
  }

  function getCardAddonServices(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return [];
    return [...card.querySelectorAll('[data-pcar-field="addonServiceIds"]:checked')]
      .map((input) => catalog.find((s) => s.id === Number(input.value)))
      .filter(Boolean);
  }

  function servicePrice(service, vehType) {
    return Number(service?.prices?.[vehType] || 0);
  }

  // --- CÁLCULO DE COSTO Y TOTALES ---
  function calculateCardCost(cardIdx) {
    const vehType = getCardVehicleType(cardIdx);
    const base = getCardBaseService(cardIdx);
    const addons = getCardAddonServices(cardIdx);

    let cost = base ? servicePrice(base, vehType) : 0;
    addons.forEach((addon) => {
      cost += servicePrice(addon, vehType);
    });
    return cost;
  }

  function refreshCardPrices(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;

    const vehType = getCardVehicleType(cardIdx);

    // Actualizar precios de servicios base en la tarjeta
    card.querySelectorAll('[data-service-price], [data-service-price-card]').forEach((el) => {
      const serviceId = Number(el.dataset.servicePrice || el.dataset.serviceId);
      const service = catalog.find((s) => s.id === serviceId);
      const cents = servicePrice(service, vehType);
      el.textContent = cents ? money.format(cents / 100) : 'Por definir';
    });

    const cost = calculateCardCost(cardIdx);
    const costBadge = card.querySelector(`#pcar-cost-${cardIdx}`) || card.querySelector('.pcar-cost-badge');
    if (costBadge) costBadge.textContent = money.format(cost / 100);

    const summaryCost = card.querySelector(`#pcar-summary-cost-${cardIdx}`) || card.querySelector('.car-active-summary strong');
    if (summaryCost) summaryCost.textContent = money.format(cost / 100);

    refreshCardAddonRules(cardIdx);
    refreshCardStepPills(cardIdx);
    updateGrandTotal();
  }

  function refreshCardAddonRules(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;

    const base = getCardBaseService(cardIdx);
    card.querySelectorAll('[data-incompatible-interior="1"], [data-addon-slug="wax"]').forEach((label) => {
      const input = label.querySelector('input');
      if (!input) return;
      const disabled = base?.slug === 'interior';
      input.disabled = disabled;
      if (disabled) input.checked = false;
      label.classList.toggle('is-disabled', disabled);
      label.title = disabled ? 'No disponible con lavado interior' : '';
    });
  }

  function refreshCardVehicleRules(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;

    const motorcycle = getCardVehicleType(cardIdx) === 'motorcycle';
    const baseInputs = [...card.querySelectorAll('[data-pcar-field="baseServiceId"]')];

    baseInputs.forEach((input) => {
      const isMotorcycleService = input.dataset.slug === 'motorcycle-wash';
      const option = input.closest('label');
      const hidden = motorcycle ? !isMotorcycleService : isMotorcycleService;
      if (option) {
        option.hidden = hidden;
        option.style.display = hidden ? 'none' : '';
      }
      input.disabled = hidden;
    });

    // Ocultar adicionales para moto
    const addonGrid = card.querySelector('.addon-grid');
    if (addonGrid) {
      addonGrid.closest('fieldset')?.classList.toggle('moto-disabled', motorcycle);
    }

    const selected = baseInputs.find((input) => !input.disabled && input.checked && !input.closest('label')?.hidden);
    if (!selected) {
      const next = baseInputs.find((input) => !input.disabled && !input.closest('label')?.hidden);
      if (next) next.checked = true;
    }

    refreshCardPrices(cardIdx);
  }

  function updateGrandTotal() {
    const cards = document.querySelectorAll('.parallel-car-card');
    let grandTotal = 0;
    cards.forEach((card) => {
      const idx = card.getAttribute('data-car-card-index');
      grandTotal += calculateCardCost(idx);
    });

    const totalEl = document.querySelector('#booking-total');
    if (totalEl) totalEl.textContent = money.format(grandTotal / 100);

    const countLabel = document.querySelector('#booking-cars-total-count');
    if (countLabel) countLabel.textContent = `${cards.length} ${cards.length === 1 ? 'carro' : 'carros'} en paralelo`;

    const topCountLabel = document.querySelector('#parallel-cars-count-label');
    if (topCountLabel) topCountLabel.textContent = `🚗 ${cards.length} Vehículos en pantalla (vista simultánea)`;

    // Mostrar/ocultar botones de eliminar si hay más de 1 carro
    const deleteButtons = document.querySelectorAll('.btn-delete-car');
    deleteButtons.forEach((btn) => {
      btn.style.display = cards.length > 1 ? 'grid' : 'none';
    });
  }

  // --- ACORDEÓN VISUAL INTERACTIVO (1 AL 5) POR TARJETA ---
  function slideCardToStep(cardIdx, stepNumber) {
    const card = getCardElement(cardIdx);
    if (!card) return;
    const step = card.querySelector(`.pcar-accordion-step[data-step="${stepNumber}"]`);
    if (step) {
      step.classList.add('is-open');
      step.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function refreshCardStepPills(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;

    // 1. Pill Paso 1: Placa y modelo
    const plateInp = card.querySelector('[data-pcar-field="plate"]');
    const modelInp = card.querySelector('[data-pcar-field="model"]');
    const plateVal = plateInp ? plateInp.value.trim().toUpperCase() : '';
    const modelVal = modelInp ? modelInp.value.trim() : '';
    const pill1 = card.querySelector(`#pcar-pill-1-${cardIdx}`);
    if (pill1) {
      if (plateVal) {
        pill1.textContent = modelVal ? `${plateVal} · ${modelVal}` : plateVal;
      } else {
        pill1.textContent = 'Sin placa';
      }
    }

    // 2. Pill Paso 2: Tipo de vehículo
    const vType = getCardVehicleType(cardIdx);
    const vLabels = {
      motorcycle: 'Moto 🏍️',
      car: 'Auto 🚗',
      small_suv: 'SUV peq. 🚙',
      large_suv: 'SUV gde. 🚐',
    };
    const pill2 = card.querySelector(`#pcar-pill-2-${cardIdx}`);
    if (pill2) pill2.textContent = vLabels[vType] || vType;

    // 3. Pill Paso 3: Horario
    const pickupInp = card.querySelector('[data-pcar-field="pickupTime"]');
    const pill3 = card.querySelector(`#pcar-pill-3-${cardIdx}`);
    if (pill3) {
      pill3.textContent = pickupInp && pickupInp.value ? `⏰ ${pickupInp.value}` : 'Ingreso directo';
    }

    // 4. Pill Paso 4: Servicio de lavado
    const base = getCardBaseService(cardIdx);
    const pill4 = card.querySelector(`#pcar-pill-4-${cardIdx}`);
    if (pill4) {
      if (base) {
        const basePrice = servicePrice(base, vType);
        pill4.textContent = `${base.name} (${money.format(basePrice / 100)})`;
      } else {
        pill4.textContent = 'Elige lavado';
      }
    }

    // 5. Pill Paso 5: Extras
    const addons = getCardAddonServices(cardIdx);
    const pill5 = card.querySelector(`#pcar-pill-5-${cardIdx}`);
    if (pill5) {
      if (addons.length > 0) {
        const addonsCost = addons.reduce((sum, a) => sum + servicePrice(a, vType), 0);
        pill5.textContent = `${addons.length} ${addons.length === 1 ? 'extra' : 'extras'} (+${money.format(addonsCost / 100)})`;
      } else {
        pill5.textContent = 'Sin extras';
      }
    }
  }

  function initCardInteractions(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;

    // 1. Clic en las cabeceras del acordeón para colapsar/expandir
    card.querySelectorAll('.pcar-step-trigger').forEach((trigger) => {
      trigger.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        const step = trigger.closest('.pcar-accordion-step');
        if (step) {
          step.classList.toggle('is-open');
        }
      });
    });

    // 2. Actualización en tiempo real de la placa y modelo
    const plateInput = card.querySelector('[data-pcar-field="plate"]');
    const modelInput = card.querySelector('[data-pcar-field="model"]');
    const plateDisplay = card.querySelector(`#pcar-plate-${cardIdx}`) || card.querySelector('.pcar-plate-display');
    if (plateInput) {
      plateInput.addEventListener('input', () => {
        plateInput.value = plateInput.value.toUpperCase();
        if (plateDisplay) plateDisplay.textContent = plateInput.value.trim() || 'Sin placa';
        refreshCardStepPills(cardIdx);
      });
    }
    if (modelInput) {
      modelInput.addEventListener('input', () => {
        refreshCardStepPills(cardIdx);
      });
    }

    // 3. Cambio de tipo de vehículo
    card.querySelectorAll('[data-pcar-field="vehicleType"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        refreshCardVehicleRules(cardIdx);
        refreshCardStepPills(cardIdx);
      });
    });

    // 4. Cambio de servicios y adicionales
    card.querySelectorAll('[data-pcar-field="baseServiceId"], [data-pcar-field="addonServiceIds"]').forEach((input) => {
      input.addEventListener('change', () => {
        refreshCardPrices(cardIdx);
        refreshCardStepPills(cardIdx);
      });
    });

    // 5. Botones de atajo de horario de recojo
    card.querySelectorAll('[data-pickup-offset], [data-pickup-offset-card]').forEach((button) => {
      button.addEventListener('click', () => {
        const offset = Number(button.dataset.pickupOffset || button.dataset.offset || 60);
        const dropoffHour = Number(document.querySelector('#dropoff-hour')?.value || 8);
        const dropoffMinute = Number(document.querySelector('#dropoff-minute')?.value || 0);
        const base = dropoffHour * 60 + dropoffMinute;
        const target = (base + offset) % 1440;
        const pickupInput = card.querySelector('[data-pcar-field="pickupTime"]');
        if (pickupInput) {
          const h = Math.floor(target / 60);
          const m = target % 60;
          pickupInput.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          pickupInput.dispatchEvent(new Event('change', { bubbles: true }));
          refreshCardStepPills(cardIdx);
        }
      });
    });

    const pickupInput = card.querySelector('[data-pcar-field="pickupTime"]');
    if (pickupInput) {
      pickupInput.addEventListener('change', () => {
        refreshCardStepPills(cardIdx);
      });
    }

    // 6. Botón Eliminar esta tarjeta
    card.querySelector(`[data-remove-card="${cardIdx}"]`)?.addEventListener('click', () => {
      removeCard(cardIdx);
    });

    // 7. Botón Copiar datos de Carro 1 (si es Carro 2 o 3)
    card.querySelector(`.btn-copy-from-first[data-copy-to="${cardIdx}"]`)?.addEventListener('click', () => {
      copyDataFromCar1(cardIdx);
    });

    // 8. Consulta SUNARP independiente para este carro
    const lookupBtn = card.querySelector(`[data-lookup-btn-idx="${cardIdx}"]`) || (cardIdx === 0 ? document.querySelector('#btn-lookup-plate') : null);
    if (lookupBtn) {
      lookupBtn.addEventListener('click', () => {
        performLookupForCard(cardIdx);
      });
    }

    refreshCardVehicleRules(cardIdx);
    refreshCardStepPills(cardIdx);
  }

  // --- COPIAR DATOS DE CLIENTE DESDE CARRO 1 ---
  function copyDataFromCar1(targetIdx) {
    const card0 = getCardElement(0);
    const targetCard = getCardElement(targetIdx);
    if (!card0 || !targetCard) return;

    const name = card0.querySelector('[data-pcar-field="name"]')?.value || '';
    const phone = card0.querySelector('[data-pcar-field="phone"]')?.value || '';
    const payment = card0.querySelector('[data-pcar-field="paymentMethod"]')?.value || 'yape';

    const targetName = targetCard.querySelector('[data-pcar-field="name"]');
    const targetPhone = targetCard.querySelector('[data-pcar-field="phone"]');
    const targetPayment = targetCard.querySelector('[data-pcar-field="paymentMethod"]');

    if (targetName) targetName.value = name;
    if (targetPhone) targetPhone.value = phone;
    if (targetPayment) targetPayment.value = payment;

    const copyBtn = targetCard.querySelector(`.btn-copy-from-first[data-copy-to="${targetIdx}"]`);
    if (copyBtn) {
      const originalText = copyBtn.innerHTML;
      copyBtn.innerHTML = '✓ ¡Datos de Carro 1 copiados!';
      copyBtn.style.background = '#ecfdf5';
      copyBtn.style.color = '#10b981';
      setTimeout(() => {
        copyBtn.innerHTML = originalText;
        copyBtn.style.background = '';
        copyBtn.style.color = '';
      }, 2500);
    }
  }

  // --- CONSULTA SUNARP / LOCAL PARA TARJETA ESPECÍFICA ---
  async function performLookupForCard(cardIdx) {
    const card = getCardElement(cardIdx);
    if (!card) return;
    const plateInput = card.querySelector('[data-pcar-field="plate"]');
    const plate = plateInput?.value.trim().toUpperCase() || '';
    const feedback = card.querySelector(`#plate-feedback-${cardIdx}`) || card.querySelector('#plate-feedback');

    if (plate.length < 4) {
      if (feedback) {
        feedback.className = 'plate-feedback plate-feedback-warning';
        feedback.innerHTML = 'Ingresa una placa válida de al menos 4 caracteres.';
        feedback.style.display = 'block';
      }
      return;
    }

    if (feedback) {
      feedback.className = 'plate-feedback plate-feedback-loading';
      feedback.innerHTML = '<span class="plate-spinner"></span> Consultando placa en SUNARP...';
      feedback.style.display = 'block';
    }

    try {
      const res = await fetch('/api/placa/consultar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placa: plate }),
      });
      const data = await res.json();
      if (data && data.found) {
        const modelInput = card.querySelector('[data-pcar-field="model"]');
        const nameInput = card.querySelector('[data-pcar-field="name"]');
        if (modelInput && (data.fullModel || data.modelo)) modelInput.value = data.fullModel || data.modelo;
        if (nameInput && !nameInput.value && data.name) nameInput.value = data.name;

        if (data.vehicleType) {
          const radio = card.querySelector(`[data-pcar-field="vehicleType"][value="${data.vehicleType}"]`);
          if (radio) {
            radio.checked = true;
            refreshCardVehicleRules(cardIdx);
          }
        }
        if (feedback) {
          const src = data.source === 'local' ? 'Cliente frecuente' : 'SUNARP oficial';
          feedback.className = 'plate-feedback plate-feedback-success';
          feedback.innerHTML = `✓ <strong>${src}:</strong> ${data.fullModel || data.modelo || ''}`;
        }
      } else if (feedback) {
        feedback.className = 'plate-feedback plate-feedback-info';
        feedback.innerHTML = `ℹ️ Placa <strong>${plate}</strong> no encontrada. Continúa el llenado manual.`;
      }
    } catch {
      if (feedback) {
        feedback.className = 'plate-feedback plate-feedback-warning';
        feedback.innerHTML = 'Error al consultar placa.';
      }
    }
  }

  // --- AGREGAR Y ELIMINAR TARJETAS EN PARALELO ---
  function addNewParallelCard() {
    const container = document.querySelector('#parallel-cars-container');
    if (!container) return;

    const currentCards = container.querySelectorAll('.parallel-car-card');
    const newIdx = currentCards.length;
    const carNumber = newIdx + 1;

    // Crear la nueva tarjeta clonando la estructura de acordeón
    const cardHtml = `
      <div class="parallel-car-card" data-car-card-index="${newIdx}" id="pcar-card-${newIdx}">
        <div class="pcar-header">
          <div class="pcar-title-wrap">
            <span class="car-number-badge">Carro ${carNumber}</span>
            <strong class="pcar-plate-display" id="pcar-plate-${newIdx}">Sin placa</strong>
          </div>
          <div class="pcar-actions">
            <span class="pcar-cost-badge" id="pcar-cost-${newIdx}">S/ 0.00</span>
            <button type="button" class="btn-delete-car" title="Eliminar vehículo" data-remove-card="${newIdx}">✕</button>
          </div>
        </div>

        <button type="button" class="btn-copy-from-first" data-copy-to="${newIdx}">
          📋 Copiar datos de cliente de Carro 1
        </button>

        <div class="pcar-accordion" data-car-accordion="${newIdx}">

          <!-- PASO 1 -->
          <fieldset class="pcar-accordion-step is-open" data-step="1" data-car-idx="${newIdx}">
            <legend class="visually-hidden"><span>1</span> Tus datos</legend>
            <div class="pcar-step-trigger" data-step-toggle="1" data-car-idx="${newIdx}">
              <div class="pcar-step-title">
                <span class="step-num">1</span>
                <strong>Tus datos</strong>
              </div>
              <div class="pcar-step-right">
                <span class="pcar-step-pill" id="pcar-pill-1-${newIdx}">Sin placa</span>
                <span class="pcar-accordion-arrow">▾</span>
              </div>
            </div>
            <div class="pcar-step-body">
              <div class="field-wrapper plate-wrapper">
                <label for="plate-input-${newIdx}">Placa <b>*</b></label>
                <div class="plate-input-group">
                  <input id="plate-input-${newIdx}" maxlength="12" placeholder="ABC-999" autocomplete="off" data-pcar-field="plate" data-car-idx="${newIdx}">
                  <button type="button" class="plate-action-btn plate-lookup-btn" data-lookup-btn-idx="${newIdx}" title="Consultar placa en SUNARP">
                    🔍 <span class="btn-text">Consultar</span>
                  </button>
                </div>
                <div id="plate-feedback-${newIdx}" class="plate-feedback" style="display: none;"></div>
              </div>
              <div class="pcar-two-col">
                <label>Marca / Modelo <input list="car-brands" maxlength="100" placeholder="Ej. Kia Sportage" autocomplete="off" data-pcar-field="model" data-car-idx="${newIdx}"></label>
                <label>Nombre <input maxlength="200" placeholder="Nombre del cliente" data-pcar-field="name" data-car-idx="${newIdx}"></label>
              </div>
              <div class="pcar-two-col">
                <label>Teléfono <input type="tel" maxlength="20" placeholder="999 999 999" data-pcar-field="phone" data-car-idx="${newIdx}"></label>
                <label>Método de pago
                  <select data-pcar-field="paymentMethod" data-car-idx="${newIdx}">
                    <option value="yape">Yape</option>
                    <option value="plin">Plin</option>
                    <option value="cash">Efectivo</option>
                  </select>
                </label>
              </div>
              <label>Indicaciones <textarea rows="1" maxlength="1000" placeholder="Observaciones de este vehículo" data-pcar-field="notes" data-car-idx="${newIdx}"></textarea></label>
            </div>
          </fieldset>

          <!-- PASO 2 -->
          <fieldset class="pcar-accordion-step is-open" data-step="2" data-car-idx="${newIdx}">
            <legend class="visually-hidden"><span>2</span> ¿Qué vehículo traes?</legend>
            <div class="pcar-step-trigger" data-step-toggle="2" data-car-idx="${newIdx}">
              <div class="pcar-step-title">
                <span class="step-num">2</span>
                <strong>¿Qué vehículo traes?</strong>
              </div>
              <div class="pcar-step-right">
                <span class="pcar-step-pill" id="pcar-pill-2-${newIdx}">Auto</span>
                <span class="pcar-accordion-arrow">▾</span>
              </div>
            </div>
            <div class="pcar-step-body">
              <div class="choice-grid vehicle-grid pcar-vehicle-chips">
                <label class="choice-card pcar-veh-chip"><input type="radio" name="vehicleType_${newIdx}" value="motorcycle" data-pcar-field="vehicleType" data-car-idx="${newIdx}"><span class="vehicle-icon vehicle-motorcycle"></span><strong>Moto</strong></label>
                <label class="choice-card pcar-veh-chip"><input type="radio" name="vehicleType_${newIdx}" value="car" checked data-pcar-field="vehicleType" data-car-idx="${newIdx}"><span class="vehicle-icon vehicle-car"></span><strong>Auto</strong></label>
                <label class="choice-card pcar-veh-chip"><input type="radio" name="vehicleType_${newIdx}" value="small_suv" data-pcar-field="vehicleType" data-car-idx="${newIdx}"><span class="vehicle-icon vehicle-small_suv"></span><strong>SUV pequeña</strong></label>
                <label class="choice-card pcar-veh-chip"><input type="radio" name="vehicleType_${newIdx}" value="large_suv" data-pcar-field="vehicleType" data-car-idx="${newIdx}"><span class="vehicle-icon vehicle-large_suv"></span><strong>SUV grande</strong></label>
              </div>
            </div>
          </fieldset>

          <!-- PASO 3 -->
          <fieldset class="pcar-accordion-step is-open" data-step="3" data-car-idx="${newIdx}">
            <legend class="visually-hidden"><span>3</span> Horario</legend>
            <div class="pcar-step-trigger" data-step-toggle="3" data-car-idx="${newIdx}">
              <div class="pcar-step-title">
                <span class="step-num">3</span>
                <strong>Horario</strong>
              </div>
              <div class="pcar-step-right">
                <span class="pcar-step-pill" id="pcar-pill-3-${newIdx}">Ingreso directo</span>
                <span class="pcar-accordion-arrow">▾</span>
              </div>
            </div>
            <div class="pcar-step-body">
              <div class="field-grid two-columns pcar-time-grid">
                <label>Hora de ingreso
                  <input value="Hora de ingreso" readonly>
                </label>
                <label>Hora estimada de recojo
                  <input type="time" data-pcar-field="pickupTime" data-car-idx="${newIdx}">
                  <div class="time-buttons pcar-time-quick-chips">
                    <button type="button" data-pickup-offset-card="${newIdx}" data-offset="30">+ 30m</button>
                    <button type="button" data-pickup-offset-card="${newIdx}" data-offset="60">+ 1h</button>
                    <button type="button" data-pickup-offset-card="${newIdx}" data-offset="90">+ 1h30</button>
                    <button type="button" data-pickup-offset-card="${newIdx}" data-offset="120">+ 2h</button>
                  </div>
                </label>
              </div>
            </div>
          </fieldset>

          <!-- PASO 4 -->
          <fieldset class="pcar-accordion-step is-open" data-step="4" data-car-idx="${newIdx}">
            <legend class="visually-hidden"><span>4</span> Elige el lavado</legend>
            <div class="pcar-step-trigger" data-step-toggle="4" data-car-idx="${newIdx}">
              <div class="pcar-step-title">
                <span class="step-num">4</span>
                <strong>Elige el lavado</strong>
              </div>
              <div class="pcar-step-right">
                <span class="pcar-step-pill" id="pcar-pill-4-${newIdx}">Lavado completo</span>
                <span class="pcar-accordion-arrow">▾</span>
              </div>
            </div>
            <div class="pcar-step-body">
              <div class="service-list pcar-service-cards">
                ${catalog.filter((s) => s.category === 'base').map((service, i) => `
                  <label class="service-option pcar-service-card">
                    <input type="radio" name="baseServiceId_${newIdx}" value="${service.id}" data-slug="${service.slug}" ${i === 1 ? 'checked' : ''} data-pcar-field="baseServiceId" data-car-idx="${newIdx}">
                    <span><strong>${service.name}</strong><small>Principal</small></span>
                    <b class="service-price" data-service-price-card="${newIdx}" data-service-id="${service.id}">—</b>
                  </label>
                `).join('')}
              </div>
            </div>
          </fieldset>

          <!-- PASO 5 -->
          <fieldset class="pcar-accordion-step is-open" data-step="5" data-car-idx="${newIdx}">
            <legend class="visually-hidden"><span>5</span> Agrega un cuidado extra</legend>
            <div class="pcar-step-trigger" data-step-toggle="5" data-car-idx="${newIdx}">
              <div class="pcar-step-title">
                <span class="step-num">5</span>
                <strong>Agrega un cuidado extra</strong>
              </div>
              <div class="pcar-step-right">
                <span class="pcar-step-pill" id="pcar-pill-5-${newIdx}">Sin extras</span>
                <span class="pcar-accordion-arrow">▾</span>
              </div>
            </div>
            <div class="pcar-step-body">
              <div class="addon-grid pcar-addon-chips">
                ${catalog.filter((s) => s.category === 'addon').map((service) => `
                  <label class="addon-option pcar-addon-chip" data-addon-slug="${service.slug}">
                    <input type="checkbox" name="addonServiceIds_${newIdx}" value="${service.id}" data-pcar-field="addonServiceIds" data-car-idx="${newIdx}">
                    <span class="check-mark">✓</span>
                    <span><strong>${service.name}</strong><small class="service-price" data-service-price-card="${newIdx}" data-service-id="${service.id}">—</small></span>
                  </label>
                `).join('')}
              </div>
              <div class="car-active-summary">
                <span>Subtotal Carro ${carNumber}:</span>
                <strong id="pcar-summary-cost-${newIdx}">S/ 0.00</strong>
              </div>
            </div>
          </fieldset>

        </div>
      </div>
    `;

    container.insertAdjacentHTML('beforeend', cardHtml);
    initCardInteractions(newIdx);
    updateGrandTotal();

    // Actualizar texto del botón superior
    const addBtn = document.querySelector('#btn-add-car-parallel');
    if (addBtn) addBtn.textContent = `+ Añadir otro vehículo (Carro ${newIdx + 2})`;
  }

  function removeCard(cardIdx) {
    const cards = document.querySelectorAll('.parallel-car-card');
    if (cards.length <= 1) return;

    const card = getCardElement(cardIdx);
    if (card) card.remove();

    // Reordenar índices restantes
    const remaining = document.querySelectorAll('.parallel-car-card');
    remaining.forEach((c, idx) => {
      c.setAttribute('data-car-card-index', idx);
      c.id = `pcar-card-${idx}`;
      const badge = c.querySelector('.car-number-badge');
      if (badge) badge.textContent = `Carro ${idx + 1}`;
      const delBtn = c.querySelector('.btn-delete-car');
      if (delBtn) delBtn.setAttribute('data-remove-card', idx);
    });

    updateGrandTotal();
    const addBtn = document.querySelector('#btn-add-car-parallel');
    if (addBtn) addBtn.textContent = `+ Añadir otro vehículo (Carro ${remaining.length + 1})`;
  }

  // --- ENVÍO CONSOLIDADO DEL FORMULARIO ---
  form.addEventListener('submit', (e) => {
    const cards = document.querySelectorAll('.parallel-car-card');
    const vehicles = [];

    cards.forEach((card, idx) => {
      const plate = card.querySelector('[data-pcar-field="plate"]')?.value.trim().toUpperCase() || '';
      const model = card.querySelector('[data-pcar-field="model"]')?.value.trim() || '';
      const name = card.querySelector('[data-pcar-field="name"]')?.value.trim() || '';
      const phone = card.querySelector('[data-pcar-field="phone"]')?.value.trim() || '';
      const paymentMethod = card.querySelector('[data-pcar-field="paymentMethod"]')?.value || 'yape';
      const notes = card.querySelector('[data-pcar-field="notes"]')?.value.trim() || '';
      const vehicleType = getCardVehicleType(idx);
      const baseService = getCardBaseService(idx);
      const baseServiceId = baseService ? baseService.id : null;
      const addonServiceIds = getCardAddonServices(idx).map((s) => s.id);
      const pickupTime = card.querySelector('[data-pcar-field="pickupTime"]')?.value || '';

      vehicles.push({
        plate,
        model,
        name,
        phone,
        paymentMethod,
        notes,
        vehicleType,
        baseServiceId,
        addonServiceIds,
        pickupTime,
      });
    });

    // Filtrar vehículos que tengan placa ingresada
    const filledVehicles = vehicles.filter((v) => Boolean(v.plate && v.plate.trim()));
    
    // Si un vehículo tiene modelo/nombre pero olvidó la placa, alertar
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.plate && (v.model || v.name || v.phone)) {
        e.preventDefault();
        alert(`Por favor ingresa la placa para el Carro ${i + 1}`);
        const plateInp = cards[i]?.querySelector('[data-pcar-field="plate"]');
        if (plateInp) {
          slideCardToStep(i, 1);
          plateInp.focus();
        }
        return;
      }
    }

    const payloadInput = document.querySelector('#vehicles-payload');
    if (payloadInput) {
      const toSend = filledVehicles.length > 0 ? filledVehicles : (vehicles.length > 0 ? [vehicles[0]] : []);
      payloadInput.value = JSON.stringify(toSend);
    }
  });

  // Botón superior "+ Añadir otro vehículo"
  document.querySelector('#btn-add-car-parallel')?.addEventListener('click', addNewParallelCard);

  // Delegación de clic para eliminar tarjeta de vehículo
  document.querySelector('#parallel-cars-container')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-delete-car');
    if (delBtn) {
      const idx = Number(delBtn.getAttribute('data-remove-card'));
      removeCard(idx);
    }
  });

  // Inicializar Carro 1 (índice 0) y Carro 2 (índice 1) presentes por defecto en HTML
  initCardInteractions(0);
  initCardInteractions(1);
  updateGrandTotal();
})();

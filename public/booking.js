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
    const motorcycle = selectedVehicle() === 'motorcycle';
    if (motorcycle) {
      form.querySelectorAll('[name="addonServiceIds"]').forEach((input) => {
        input.checked = false;
        input.disabled = true;
      });
      refreshPrices();
      return;
    }
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
        if (input.tagName !== 'OPTION') option.style.display = hidden ? 'none' : '';
      }
      input.disabled = hidden;
      if (motorcycle && isMotorcycleService) {
        if (input.tagName === 'OPTION') input.selected = true;
        else input.checked = true;
      } else if (!motorcycle && isMotorcycleService) {
        if (input.tagName === 'OPTION' && input.selected) input.selected = false;
        if (input.tagName !== 'OPTION') input.checked = false;
      }
    });
    if (!motorcycle) {
      const selected = baseChoices.find((input) => !input.disabled && (input.tagName === 'OPTION' ? input.selected : input.checked));
      if (!selected) {
        const next = baseChoices.find((input) => !input.disabled && !input.hidden);
        if (next) {
          if (next.tagName === 'OPTION') next.selected = true;
          else next.checked = true;
        }
      }
    }
    form.querySelectorAll('[name="addonServiceIds"]').forEach((input) => {
      const label = input.closest('label.addon-option');
      input.checked = motorcycle ? false : input.checked;
      input.disabled = motorcycle;
      if (label) {
        label.style.display = motorcycle ? 'none' : '';
        label.classList.toggle('is-disabled', motorcycle);
      }
    });
    if (motorcycle) {
      const totalElement = document.querySelector('#booking-total');
      if (totalElement) totalElement.textContent = 'S/ 15.00';
    }
    refreshAddonRules();
  }

  function refreshPickupOptions() {
    const dropoff = Number(form.querySelector('#dropoff-hour')?.value || 0) * 60 + Number(form.querySelector('#dropoff-minute')?.value || 0);
    const pickup = form.querySelector('#pickup-time');
    if (!pickup) return;
    const previous = pickup.value;
    pickup.innerHTML = '';
    for (let total = dropoff + 60; total <= 18 * 60; total += 10) {
      const hour = Math.floor(total / 60); const minute = total % 60;
      const option = document.createElement('option'); option.value = `${hour}:${String(minute).padStart(2, '0')}`;
      option.textContent = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'p. m.' : 'a. m.'}`;
      pickup.appendChild(option);
    }
    if ([...pickup.options].some((o) => o.value === previous)) pickup.value = previous;
    refreshPhoneRule();
  }

  function refreshPhoneRule() {
    const [pickupHour, pickupMinute] = String(form.querySelector('#pickup-time')?.value || '0:0').split(':').map(Number);
    const currentHour = Number(form.dataset.nowHour || new Date().getHours());
    const required = currentHour >= 14 || (pickupHour * 60 + pickupMinute) >= 16 * 60;
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
  });

  form.addEventListener('submit', (event) => {
    if (!form.querySelector('#pickup-time')) return;
    const dropoff = Number(form.querySelector('#dropoff-hour')?.value || 0) * 60 + Number(form.querySelector('#dropoff-minute')?.value || 0);
    const [pickupHour, pickupMinute] = String(form.querySelector('#pickup-time')?.value || '0:0').split(':').map(Number);
    const pickup = pickupHour * 60 + pickupMinute;
    if (pickup <= dropoff) {
      event.preventDefault();
      form.querySelector('#pickup-time')?.setCustomValidity('El recojo debe ser posterior al ingreso.');
      form.querySelector('#pickup-time')?.reportValidity();
    }
  });
  form.querySelector('#pickup-time')?.addEventListener('input', (event) => event.target.setCustomValidity(''));
  form.querySelectorAll('[data-pickup-offset]').forEach((button) => button.addEventListener('click', () => {
    const base = Number(form.querySelector('#dropoff-hour').value) * 60 + Number(form.querySelector('#dropoff-minute').value);
    const target = base + Number(button.dataset.pickupOffset);
    const select = form.querySelector('#pickup-time');
    if ([...select.options].some((option) => Number(option.value.split(':')[0]) * 60 + Number(option.value.split(':')[1]) === target)) select.value = `${Math.floor(target / 60)}:${String(target % 60).padStart(2, '0')}`;
    refreshPhoneRule();
  }));

  let lastLookedUpPlate = '';
  let lookupInProgress = false;
  const plateInput = form.querySelector('[name="plate"]');
  const lookupButton = form.querySelector('[data-lookup-plate]');
  const plateStatus = form.querySelector('[data-plate-status]');
  const normalizePlate = (value) => String(value || '').replace(/[\s-]/g, '').toUpperCase();
  const validLookupPlate = (value) => /^[A-Z0-9]{6,8}$/.test(value);

  async function lookupPlate() {
    if (!plateInput || lookupInProgress) return;
    const plate = normalizePlate(plateInput.value);
    if (!validLookupPlate(plate)) {
      if (plateStatus) plateStatus.textContent = 'Ingresa una placa válida para consultar.';
      return;
    }
    if (plate === lastLookedUpPlate) return;
    lookupInProgress = true;
    if (lookupButton) lookupButton.disabled = true;
    if (plateStatus) plateStatus.textContent = 'Consultando vehículo...';
    try {
      const response = await fetch(`/api/vehiculos/${encodeURIComponent(plate)}`);
      const result = await response.json();
      if (!response.ok || !result.success) {
        if (plateStatus) plateStatus.textContent = result.message || 'No se pudo consultar la información, ingrese los datos manualmente';
        return;
      }
      const fields = { vehicleMake: result.data.marca, vehicleModel: result.data.modelo, vehicleColor: result.data.color, vehicleYear: result.data.anio, vehicleOwner: result.data.propietario };
      for (const [name, value] of Object.entries(fields)) {
        const field = form.querySelector(`[name="${name}"]`);
        if (field && value !== null && value !== undefined && value !== '') field.value = value;
      }
      lastLookedUpPlate = plate;
      if (plateStatus) plateStatus.textContent = result.source === 'local'
        ? 'Datos guardados localmente. Puedes editarlos antes de guardar.'
        : 'Información del vehículo encontrada. Puedes editarla antes de guardar.';
    } catch {
      if (plateStatus) plateStatus.textContent = 'No se pudo consultar la información, ingrese los datos manualmente';
    } finally {
      lookupInProgress = false;
      if (lookupButton) lookupButton.disabled = false;
    }
  }

  lookupButton?.addEventListener('click', lookupPlate);
  plateInput?.addEventListener('blur', () => { void lookupPlate(); });
  plateInput?.addEventListener('input', () => {
    if (normalizePlate(plateInput.value) !== lastLookedUpPlate && plateStatus) plateStatus.textContent = '';
  });

  refreshAddonRules();
  refreshVehicleRules();
  refreshPickupOptions();
  form.querySelector('#pickup-time')?.dispatchEvent(new Event('change'));
  refreshPhoneRule();
})();

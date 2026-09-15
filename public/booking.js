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
    const dropoff = Number(form.querySelector('#dropoff-hour')?.value || 0) * 60 + Number(form.querySelector('#dropoff-minute')?.value || 0);
    const pickup = form.querySelector('#pickup-time');
    if (!pickup) return;
    const previous = pickup.value;
    const start = Math.ceil((dropoff + 20) / 10) * 10;
    for (let total = Math.max(start, dropoff + 10); total <= 18 * 60; total += 10) {
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
  });

  // Uppercase for license plate
  const plateInput = form.querySelector('input[name="plate"]');
  if (plateInput) {
    plateInput.addEventListener('input', () => {
      const start = plateInput.selectionStart;
      const end = plateInput.selectionEnd;
      plateInput.value = plateInput.value.toUpperCase();
      if (start !== null && end !== null) {
        plateInput.setSelectionRange(start, end);
      }
    });
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

  refreshAddonRules();
  refreshVehicleRules();
  refreshPickupOptions();
  form.querySelector('#pickup-time')?.dispatchEvent(new Event('change'));
  refreshPhoneRule();
})();

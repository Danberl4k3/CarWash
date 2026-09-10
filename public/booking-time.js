(() => {
  const form = document.querySelector('#booking-form');
  if (!form) return;

  const mode = form.dataset.bookingMode || (form.querySelector('#pickup-time') ? 'public' : 'admin-new');
  const toMinutes = (hour, minute) => Number(hour || 0) * 60 + Number(minute || 0);
  const selected = (selector) => form.querySelector(selector);
  const timeLabel = (total) => {
    const hour24 = Math.floor(total / 60);
    const minute = String(total % 60).padStart(2, '0');
    return `${hour24 % 12 || 12}:${minute} ${hour24 >= 12 ? 'p. m.' : 'a. m.'}`;
  };
  const serverNow = Number(form.dataset.serverNow || Date.now());
  const limaNow = () => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(serverNow));
    return { hour: Number(parts.find((part) => part.type === 'hour')?.value || 0), minute: Number(parts.find((part) => part.type === 'minute')?.value || 0) };
  };
  const setStatus = (message, error = false) => {
    const status = form.querySelector('[data-time-status]');
    if (status) { status.textContent = message; status.classList.toggle('is-error', error); }
  };
  const setPhoneRule = (pickup) => {
    const now = limaNow();
    const required = now.hour >= 14 || pickup >= 16 * 60;
    const phone = selected('#phone');
    if (phone) phone.required = required;
    const optional = selected('#phone-optional');
    if (optional) optional.textContent = required ? 'Obligatorio' : 'Opcional';
    const rule = selected('#phone-rule');
    if (rule) rule.hidden = !required;
    selected('#phone-field')?.classList.toggle('required-field', required);
  };

  function refreshPublic() {
    const dropoff = toMinutes(selected('#dropoff-hour')?.value, selected('#dropoff-minute')?.value);
    const pickup = selected('#pickup-time');
    if (!pickup) return;
    const previous = pickup.value;
    pickup.replaceChildren(new Option('Selecciona una hora', ''));
    for (let total = dropoff + 60; total <= 18 * 60; total += 10) pickup.add(new Option(timeLabel(total), `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`));
    if ([...pickup.options].some((option) => option.value === previous)) pickup.value = previous;
    setPhoneRule(toMinutes(...String(pickup.value || '0:0').split(':')));
    const display = selected('#dropoff-display');
    if (display) display.value = `${String(Math.floor(dropoff / 60)).padStart(2, '0')}:${String(dropoff % 60).padStart(2, '0')} (automática)`;
  }

  function refreshAdmin() {
    const dropoff = toMinutes(selected('#dropoff-hour')?.value, selected('#dropoff-minute')?.value);
    const pickup = toMinutes(selected('#pickup-hour')?.value, selected('#pickup-minute')?.value);
    if (pickup && dropoff && pickup < dropoff + 60) setStatus('El recojo debe ser al menos 1 hora después del ingreso.', true);
    else setStatus('Horario válido: ingreso y recojo en bloques de 10 minutos.');
    setPhoneRule(pickup);
  }

  const refresh = mode === 'public' ? refreshPublic : refreshAdmin;
  form.addEventListener('change', (event) => {
    if (['dropoffHour', 'dropoffMinute', 'pickupHour', 'pickupMinute', 'pickupTime'].includes(event.target?.name)) refresh();
  });
  form.addEventListener('submit', (event) => {
    const dropoff = toMinutes(selected('#dropoff-hour')?.value, selected('#dropoff-minute')?.value);
    const pickup = mode === 'public'
      ? toMinutes(...String(selected('#pickup-time')?.value || '0:0').split(':'))
      : toMinutes(selected('#pickup-hour')?.value, selected('#pickup-minute')?.value);
    if (!pickup || pickup < dropoff + 60 || pickup > 18 * 60 || (pickup % 10) !== 0) {
      event.preventDefault();
      setStatus('Corrige el horario: el recojo debe ser 1 hora después del ingreso y no superar las 6 p. m.', true);
      (selected('#pickup-time') || selected('#pickup-hour'))?.reportValidity();
    }
  });
  refresh();
})();

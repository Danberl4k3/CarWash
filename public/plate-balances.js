(() => {
  const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });

  function showBalances(container, data) {
    container.replaceChildren();
    const balances = Array.isArray(data.balances) ? data.balances : [];
    if (!balances.length) {
      container.hidden = true;
      return;
    }

    const title = document.createElement('div');
    title.className = 'plate-balance-title';
    const label = document.createElement('strong');
    label.textContent = `Saldo pendiente · ${data.plate}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'plate-balance-close';
    close.setAttribute('aria-label', 'Cerrar aviso de saldo');
    close.textContent = '×';
    close.addEventListener('click', () => { container.hidden = true; });
    title.append(label, close);

    const total = document.createElement('b');
    total.className = 'plate-balance-total';
    total.textContent = money.format(data.totalPendingCents / 100);

    const list = document.createElement('ul');
    list.className = 'plate-balance-list';
    for (const balance of balances.slice(0, 5)) {
      const item = document.createElement('li');
      const date = document.createElement('span');
      const [year, month, day] = String(balance.date).split('-');
      date.textContent = `Del ${day}/${month}/${year}`;
      const amount = document.createElement('strong');
      amount.textContent = money.format(balance.pendingCents / 100);
      item.append(date, amount);
      list.append(item);
    }

    container.append(title, total, list);
    if (balances.length > 5) {
      const more = document.createElement('small');
      more.textContent = `Y ${balances.length - 5} reserva(s) más incluidas en el total.`;
      container.append(more);
    }
    container.hidden = false;
  }

  document.querySelectorAll('[data-plate-balance-input]').forEach((input) => {
    const wrapper = input.closest('.plate-wrapper, .board-search-wrap');
    const container = wrapper?.querySelector('[data-plate-balance-result]');
    if (!container) return;

    let timer;
    let controller;
    let lookupId = 0;
    async function lookup() {
      const plate = input.value.trim().toUpperCase();
      if (!/^[A-Z0-9-]{6,12}$/.test(plate)) {
        container.hidden = true;
        return;
      }
      const currentLookup = ++lookupId;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/admin/api/placa-saldos?plate=${encodeURIComponent(plate)}`, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (currentLookup === lookupId && input.value.trim().toUpperCase() === plate) {
          showBalances(container, data);
        }
      } catch (error) {
        if (error.name !== 'AbortError') container.hidden = true;
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      controller?.abort();
      lookupId++;
      container.hidden = true;
      timer = setTimeout(lookup, 450);
    });
  });
})();

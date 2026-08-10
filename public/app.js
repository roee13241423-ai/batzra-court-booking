document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-toggle-password]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-toggle-password'));
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '👁️' : '🙈';
      btn.setAttribute('aria-label', showing ? 'הצג סיסמה' : 'הסתר סיסמה');
    });
  });

  const clockEl = document.getElementById('live-clock');
  if (clockEl) {
    const pad = n => String(n).padStart(2, '0');
    const tick = () => {
      const now = new Date();
      clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }
});

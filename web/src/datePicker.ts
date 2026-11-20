/**
 * Date and month pick-ers that always fit the screen.
 * The browser draws the calendar of <input type="date"> and <input type="month"> outside the page, at a size
 * we cannot control, and on phones and tablets it can be bigger than the screen. This draws a compact calendar
 * inside the page instead, kept within the viewport. The real input stays in place: we set its value and fire
 * normal "input" and "change" events, so forms (FormData, React onChange) and min/max/required work unchanged.
 * Installed once from main.tsx; call sites need no change.
 */
type Kind = 'date' | 'month';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

let pop: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let kind: Kind = 'date';
let view: 'days' | 'months' = 'days';
let vy = 0; // year being shown
let vm = 1; // month being shown (1-12)
let cy = 0, cm = 1, cd = 1; // keyboard cursor

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Today in India (work dates are IST). */
function todayParts(): [number, number, number] {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m, d] = s.split('-').map(Number);
  return [y, m, d];
}

const usable = (el: EventTarget | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && (el.type === 'date' || el.type === 'month') && !el.disabled && !el.readOnly;

function close(refocus = false) {
  if (!pop) return;
  pop.remove();
  pop = null;
  const el = input;
  input = null;
  if (refocus) el?.focus({ preventScroll: true });
}

function setValue(v: string) {
  const el = input;
  if (!el) return;
  const changed = el.value !== v;
  // React tracks the value itself: use the native setter so its onChange fires
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, v);
  close(true);
  if (changed) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

const inRange = (value: string, len: number) => {
  const min = input?.min.slice(0, len) ?? '';
  const max = input?.max.slice(0, len) ?? '';
  const v = value.slice(0, len);
  return !(min && v < min) && !(max && v > max);
};

function render() {
  if (!pop || !input) return;
  const [ty, tm, td] = todayParts();
  const chosen = input.value;
  const head = view === 'days' ? `${MONTHS[vm - 1]} ${vy}` : String(vy);
  let body = '';
  if (view === 'days') {
    const first = new Date(vy, vm - 1, 1).getDay();
    const count = new Date(vy, vm, 0).getDate();
    body += `<div class="dp-grid">${DAYS.map((d) => `<span class="dp-wd">${d}</span>`).join('')}`;
    for (let i = 0; i < first; i++) body += '<span></span>';
    for (let d = 1; d <= count; d++) {
      const s = ymd(vy, vm, d);
      const cls = ['dp-day'];
      if (s === chosen) cls.push('sel');
      if (vy === ty && vm === tm && d === td) cls.push('today');
      if (vy === cy && vm === cm && d === cd) cls.push('cur');
      body += `<button type="button" class="${cls.join(' ')}" data-act="day" data-v="${s}"${inRange(s, 10) ? '' : ' disabled'}>${d}</button>`;
    }
    body += '</div>';
  } else {
    body += '<div class="dp-months">';
    for (let m = 1; m <= 12; m++) {
      const s = `${vy}-${pad(m)}`;
      const cls = ['dp-mon'];
      if (s === chosen.slice(0, 7)) cls.push('sel');
      if (vy === ty && m === tm) cls.push('today');
      if (kind === 'month' && vy === cy && m === cm) cls.push('cur');
      body += `<button type="button" class="${cls.join(' ')}" data-act="month" data-v="${m}"${inRange(s, 7) ? '' : ' disabled'}>${MONTHS[m - 1].slice(0, 3)}</button>`;
    }
    body += '</div>';
  }
  const foot = kind === 'date' || !input.required
    ? `<div class="dp-foot">${input.required ? '<span></span>' : '<button type="button" class="dp-link" data-act="clear">Clear</button>'}<button type="button" class="dp-link" data-act="today">${kind === 'date' ? 'Today' : 'This month'}</button></div>`
    : '';
  pop.innerHTML = `<div class="dp-head"><button type="button" class="dp-nav" data-act="prev" aria-label="Previous">‹</button>`
    + `<button type="button" class="dp-title" data-act="title"${kind === 'month' ? ' disabled' : ''}>${head}${kind === 'date' ? ' ▾' : ''}</button>`
    + `<button type="button" class="dp-nav" data-act="next" aria-label="Next">›</button></div>${body}${foot}`;
}

function place() {
  if (!pop || !input) return;
  const gap = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = input.getBoundingClientRect();
  const width = Math.min(300, vw - gap * 2);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(gap, Math.min(r.left, vw - width - gap))}px`;
  pop.style.maxHeight = `${vh - gap * 2}px`;
  const h = pop.offsetHeight;
  const below = vh - r.bottom - gap - 4;
  const above = r.top - gap - 4;
  const top = h <= below ? r.bottom + 4 : h <= above ? r.top - h - 4 : Math.max(gap, Math.min(r.bottom + 4, vh - h - gap));
  pop.style.top = `${top}px`;
}

function open(el: HTMLInputElement) {
  close();
  input = el;
  kind = el.type === 'month' ? 'month' : 'date';
  const [ty, tm, td] = todayParts();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(el.value);
  vy = m ? Number(m[1]) : ty;
  vm = m ? Number(m[2]) : tm;
  cy = vy; cm = vm; cd = m && m[3] ? Number(m[3]) : (m ? 1 : td);
  view = kind === 'month' ? 'months' : 'days';
  const p = document.createElement('div');
  p.className = 'dp';
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', kind === 'month' ? 'Choose a month' : 'Choose a date');
  p.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the field
  p.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const v = b.dataset.v ?? '';
    switch (b.dataset.act) {
      case 'day': setValue(v); return;
      case 'month':
        if (kind === 'month') setValue(`${vy}-${pad(Number(v))}`);
        else { vm = Number(v); view = 'days'; render(); place(); }
        return;
      case 'prev': case 'next': {
        const dir = b.dataset.act === 'prev' ? -1 : 1;
        if (view === 'months') vy += dir;
        else { const d = new Date(vy, vm - 1 + dir, 1); vy = d.getFullYear(); vm = d.getMonth() + 1; }
        render(); place(); return;
      }
      case 'title': view = view === 'days' ? 'months' : 'days'; render(); place(); return;
      case 'today': {
        const [y, mo, d] = todayParts();
        const s = kind === 'month' ? `${y}-${pad(mo)}` : ymd(y, mo, d);
        if (inRange(s, kind === 'month' ? 7 : 10)) setValue(s);
        return;
      }
      case 'clear': setValue(''); return;
    }
  });
  document.body.appendChild(p);
  pop = p;
  render();
  place();
}

function move(days: number, months: number) {
  const d = new Date(cy + 0, cm - 1 + months, cd + days);
  cy = d.getFullYear(); cm = d.getMonth() + 1; cd = d.getDate();
  vy = cy; vm = cm;
  if (kind === 'date') view = 'days';
  render(); place();
}

export function installDatePicker() {
  const flag = document as unknown as { __datePicker?: boolean };
  if (flag.__datePicker) return;
  flag.__datePicker = true;

  // opening: a click on the field (this also blocks the browser's own calendar)
  document.addEventListener('click', (e) => {
    if (!usable(e.target)) return;
    e.preventDefault();
    if (input === e.target) close(); else open(e.target);
  }, true);

  // clicking anywhere else only closes the calendar (it does not press what is under it)
  document.addEventListener('mousedown', (e) => {
    if (!pop) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (pop.contains(t) || usable(t))) return;
    close();
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 400);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (pop) {
      const small = kind === 'month';
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); small ? move(0, -1) : move(-1, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); small ? move(0, 1) : move(1, 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); small ? move(0, -3) : move(-7, 0); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); small ? move(0, 3) : move(7, 0); }
      else if (e.key === 'PageUp') { e.preventDefault(); move(0, small ? -12 : -1); }
      else if (e.key === 'PageDown') { e.preventDefault(); move(0, small ? 12 : 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const s = small ? `${cy}-${pad(cm)}` : ymd(cy, cm, cd);
        if (inRange(s, small ? 7 : 10)) setValue(s);
      } else if (e.key === 'Tab') close();
      return;
    }
    if (usable(e.target) && (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); open(e.target); }
  }, true);

  window.addEventListener('resize', () => close());
  window.addEventListener('orientationchange', () => close());
  document.addEventListener('scroll', (e) => { if (pop && !(e.target instanceof Node && pop.contains(e.target))) close(); }, true);
}

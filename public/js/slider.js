const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A pill slider over a few named stops (styled by .level-slider). Each stop is a radio button with
 * data-action="slider"; the app maps data-slider to the setting it changes. `key` names what the slider
 * belongs to, so a change glides only while the same card or mode stays on screen.
 * `fill: 'end'` shades from the thumb to the last stop, `'start'` from the first stop to the thumb.
 * A stop is { value, label, tone, key?, note? }: tone picks its color, key its shortcut, note a small count.
 */
export function renderSlider({ name, key, label, stops, value, fill = 'end', className = '' }) {
  const index = Math.max(0, stops.findIndex((stop) => stop.value === value));
  // Grey dots sit on the track; the white copy inside the fill shows only where the fill has reached.
  const dots = `<span class="level-dots">${'<span class="level-dot"></span>'.repeat(stops.length)}</span>`;
  return `<div class="level-slider ${className}" role="radiogroup" aria-label="${esc(label)}" data-slider="${name}" data-key="${esc(key)}" data-value="${esc(stops[index].value)}" data-index="${index}" data-stops="${stops.length}" data-tone="${stops[index].tone}" data-fill="${fill}"><div class="level-track" aria-hidden="true">${dots}<span class="level-fill">${dots}</span><span class="level-thumb"></span></div>${stops.map((stop, i) => `<button type="button" role="radio" class="level-stop" data-action="slider" data-slider="${name}" data-value="${esc(stop.value)}" data-tone="${stop.tone}" aria-checked="${i === index}" tabindex="${i === index ? 0 : -1}"><span>${esc(stop.label)}</span>${stop.note === undefined ? '' : `<span class="level-stop-note">${esc(stop.note)}</span>`}${stop.key ? `<kbd>${esc(stop.key)}</kbd>` : ''}</button>`).join('')}</div>`;
}

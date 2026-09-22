const KEY = 'mini-planet:climate:v1';
const WEATHERS = new Set(['', 'clear', 'cloudy', 'rain', 'snow']);
const SEASONS = new Set(['', 'spring', 'summer', 'autumn', 'winter']);

export function createClimateControls({ weather = '', season = '', onChange }) {
  const button = document.getElementById('climateToggle');
  const panel = document.getElementById('climatePanel');
  const weatherSelect = document.getElementById('climateWeather');
  const seasonSelect = document.getElementById('climateSeason');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* Optional preferences. */ }
  const initial = {
    weather: weather || (WEATHERS.has(saved.weather) ? saved.weather : ''),
    season: season || (SEASONS.has(saved.season) ? saved.season : ''),
  };
  if (!button || !panel || !weatherSelect || !seasonSelect) return initial;
  weatherSelect.value = initial.weather;
  seasonSelect.value = initial.season;

  function close(restoreFocus = false) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) weatherSelect.focus();
  });
  document.getElementById('climateClose')?.addEventListener('click', () => close(true));
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  });
  const change = () => {
    const next = { weather: weatherSelect.value, season: seasonSelect.value };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Session-only when storage is unavailable. */ }
    onChange(next);
  };
  weatherSelect.addEventListener('change', change);
  seasonSelect.addEventListener('change', change);
  return initial;
}

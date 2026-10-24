/* Customize: theme, accent colour, text size and profile picture. Loaded before the page renders so there is no flash;
   the last choice is cached in localStorage and the laptop copy (/api/prefs) wins once it arrives. */
'use strict';
const ACCENTS = {   // accent, accent-2 on dark, accent-2 on light, gradient from, gradient to
  saffron: ['#f08a24', '#f59e42', '#c2530f', '#f5a03a', '#e0602a'],
  rose:    ['#ec4f7a', '#f47a9a', '#c0264f', '#f4718f', '#d93a6a'],
  violet:  ['#8b6cf0', '#a593f5', '#5b3fd1', '#9d84f6', '#6d4fe0'],
  blue:    ['#3b8cf0', '#6aa8f5', '#1f63c2', '#5aa2f7', '#2f6fe0'],
  teal:    ['#1fb5a8', '#4fd0c3', '#0f7f76', '#34c3b4', '#16958c'],
  green:   ['#3fb950', '#6bd47a', '#237a33', '#55c766', '#2b9a40'],
};
const TEXT_SIZES = { s: '13.5px', m: '14.5px', l: '16px' };
const lightQuery = matchMedia('(prefers-color-scheme: light)');
let PREFS = {};
try { PREFS = JSON.parse(localStorage.getItem('munshi-prefs') || '{}'); } catch {}

function applyPrefs(p = PREFS) {
  PREFS = p;
  try { localStorage.setItem('munshi-prefs', JSON.stringify(p)); } catch {}
  const root = document.documentElement, theme = p.theme || 'auto';
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  const light = theme === 'light' || (theme === 'auto' && lightQuery.matches);
  const a = ACCENTS[p.accent] || ACCENTS.saffron;
  root.style.setProperty('--accent', a[0]);
  root.style.setProperty('--accent-2', light ? a[2] : a[1]);
  root.style.setProperty('--grad', `linear-gradient(135deg, ${a[3]} 0%, ${a[4]} 100%)`);
  root.style.setProperty('--glow', a[0] + '4d');
  root.style.setProperty('--fs', TEXT_SIZES[p.text] || TEXT_SIZES.m);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (theme === 'auto') m.content = m.media.includes('dark') ? '#0d0b09' : '#faf7f2';
    else m.content = light ? '#faf7f2' : '#0d0b09';
  }
  const src = p.avatar ? `/api/avatar?v=${encodeURIComponent(p.avatar)}&t=${encodeURIComponent(window.TOKEN)}` : '/icons/avatar.png';
  for (const img of document.querySelectorAll('.av-img')) if (img.getAttribute('src') !== src) img.src = src;
}
lightQuery.addEventListener?.('change', () => applyPrefs());
applyPrefs();
document.addEventListener('DOMContentLoaded', () => applyPrefs());

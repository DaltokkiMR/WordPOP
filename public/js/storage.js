const PREFIX = 'wordpop.v1.';
let failed = false;

export function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; }
  catch { return fallback; }
}

export function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { failed = true; }
}

export function storageUnavailable() { return failed; }

// Turns a Google Maps link into coordinates, for a vehicle's parking location. Admins pick the spot on
// Google Maps and paste its share link; short links (maps.app.goo.gl/...) are followed to the full
// Google Maps URL first. Only Google hosts are ever requested, and only a few redirects deep.

const GOOGLE_HOST_RE = /(^|\.)google\.[a-z.]{2,6}$|^maps\.app\.goo\.gl$|^goo\.gl$|^g\.co$/i;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;

function validCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  if (la === 0 && ln === 0) return null;
  return { lat: Math.round(la * 1e6) / 1e6, lng: Math.round(ln * 1e6) / 1e6 };
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';

// { lat, lng, placeName } from a full Google Maps URL, or null. Prefers the dropped pin
// (!3d<lat>!4d<lng>) over the map's centre (@lat,lng), which can be off to one side.
export function coordsFromMapUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const text = decodeURIComponent(url.href).replace(/\+/g, ' ');
  const placeMatch = /\/maps\/place\/([^/@]+)/.exec(url.pathname);
  const placeName = placeMatch ? decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ').trim() : '';
  const looksLikeCoords = /^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/.test(placeName);

  const candidates = [
    new RegExp(`!3d${NUM}!4d${NUM}`).exec(text),
    ...['q', 'query', 'll', 'center', 'destination', 'daddr'].map((p) => {
      const v = url.searchParams.get(p);
      return v ? new RegExp(`^(?:loc:)?\\s*${NUM},\\s*${NUM}`).exec(v.trim()) : null;
    }),
    new RegExp(`/(?:place|search|dir)/${NUM},\\s*${NUM}`).exec(text),
    new RegExp(`@${NUM},${NUM}`).exec(text),
  ];
  for (const m of candidates) {
    const coords = m && validCoords(m[1], m[2]);
    if (coords) return { ...coords, placeName: looksLikeCoords ? '' : placeName };
  }
  return null;
}

export function isGoogleMapsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') && GOOGLE_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

// Follows a (short) Google Maps link to the URL it ends up at, never leaving Google's hosts.
export async function expandMapUrl(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isGoogleMapsUrl(current)) return null;
    if (coordsFromMapUrl(current)) return current;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) return current;
    current = new URL(location, current).href;
  }
  return current;
}

// { lat, lng, placeName } for any Google Maps link, or null when it has no location in it.
export async function resolveMapLink(rawUrl) {
  const direct = coordsFromMapUrl(rawUrl);
  if (direct) return direct;
  const expanded = await expandMapUrl(rawUrl);
  return expanded ? coordsFromMapUrl(expanded) : null;
}

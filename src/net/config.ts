// NETWORK — where the match server is (V1.5 Session 6).
//
// `VITE_SERVER_URL` when it is set (Session 8 sets it on Vercel to the Railway
// server). Otherwise, in development only, the local server on port 8787 of the
// same machine the page came from — so `npm run dev` + `npm run server` works
// with no setup, from this computer or another one on the same Wi-Fi.
//
// Null in a production build without the variable, and the online button is
// hidden: until Session 8 the live site has no server to talk to.

const configured: string | undefined = import.meta.env.VITE_SERVER_URL;

export const SERVER_URL: string | null =
  configured ||
  (import.meta.env.DEV && typeof location !== 'undefined'
    ? `ws://${location.hostname}:8787`
    : null);

/** The shareable link for `room` — this page, with the room in its query. */
export function roomLink(room: string): string {
  return `${location.origin}${location.pathname}?room=${room}`;
}

/** The room code in this page's link, if it was opened from one. */
export function roomInLink(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('room');
}

/**
 * Application configuration derived from Vite environment variables.
 *
 * In development:  VITE_API_URL defaults to 'http://localhost:3001'
 * In Docker/prod:  VITE_API_URL defaults to '' (same origin, server serves the client)
 *
 * The WebSocket URL is derived from the API URL automatically.
 */

const rawApiUrl = import.meta.env.VITE_API_URL ?? '';

/** Base URL for API calls, e.g. 'http://localhost:3001' or '' (same origin). */
export const API_URL: string = rawApiUrl.replace(/\/+$/, '');

/** Full API base including the /api prefix. */
export const API_BASE: string = `${API_URL}/api`;

/** WebSocket URL for project sync. */
export function getWebSocketUrl(): string {
  if (API_URL) {
    // Explicit API URL — derive ws:// or wss:// from it
    const url = new URL(API_URL);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${url.host}/ws`;
  }
  // Same-origin: use the page's host
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${location.host}/ws`;
}

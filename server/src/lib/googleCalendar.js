/**
 * Google Calendar adapter over native fetch (architecture doc §2 stack).
 * Uses a refresh-token service flow: exchange once per process (cached),
 * then call the Calendar v3 REST API against the configured clinic calendar.
 * Audience is carried in extendedProperties/description so both sides can be
 * distinguished until per-user OAuth sync ships.
 */
export function makeGoogleCal(config) {
  const {
    clientId,
    clientSecret,
    refreshToken,
    calendarId = 'primary',
  } = config.google ?? {};

  let accessToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`google_token_http_${res.status}`);
    const body = await res.json();
    accessToken = body.access_token;
    tokenExpiresAt = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    return accessToken;
  }

  return {
    async createEvent({ appointmentId, audience, summary, start }) {
      const token = await getAccessToken();
      const end = new Date(start.getTime() + 30 * 60_000);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            summary,
            description: `Appointment ${appointmentId} (${audience})`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            extendedProperties: { private: { appointmentId, audience } },
          }),
        },
      );
      if (!res.ok) throw new Error(`calendar_create_http_${res.status}`);
      const body = await res.json();
      return { googleEventId: body.id };
    },

    async deleteEvent({ googleEventId }) {
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        throw new Error(`calendar_delete_http_${res.status}`);
      }
      return {};
    },
  };
}

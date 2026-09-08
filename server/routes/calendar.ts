import { Hono } from "hono";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  listEvents,
  searchEvents,
  updateEvent,
} from "../calendar.ts";
import { finiteOr } from "./params.ts";

export function createCalendarRoutes(): Hono {
  const calendar = new Hono();

  calendar.get("/calendar/events", async (c) => {
    const days = finiteOr(c.req.query("days"), "days");
    if (!days.ok) return c.json({ error: days.error }, 400);
    const timeMin = c.req.query("from") || undefined;
    const timeMax = c.req.query("to") || undefined;
    if (!!timeMin !== !!timeMax)
      return c.json({ error: "from and to must be provided together" }, 400);
    if (timeMin && Number.isNaN(Date.parse(timeMin)))
      return c.json({ error: "from is not a valid date" }, 400);
    if (timeMax && Number.isNaN(Date.parse(timeMax)))
      return c.json({ error: "to is not a valid date" }, 400);
    return c.json(await listEvents({ days: days.value, timeMin, timeMax }));
  });

  calendar.get("/calendar/calendars", async (c) =>
    c.json(await listCalendars()),
  );

  calendar.get("/calendar/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q required" }, 400);
    return c.json(await searchEvents(q));
  });

  calendar.get("/calendar/event", async (c) => {
    const calendarId = c.req.query("calendarId");
    const eventId = c.req.query("eventId");
    if (!calendarId || !eventId)
      return c.json({ error: "calendarId, eventId required" }, 400);
    return c.json(await getEvent(calendarId, eventId));
  });

  calendar.post("/calendar/events", async (c) => {
    const body = await c.req.json();
    return c.json(await createEvent(body));
  });

  calendar.put("/calendar/events/:id", async (c) => {
    const body = await c.req.json();
    await updateEvent(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  calendar.post("/calendar/events/:id/delete", async (c) => {
    const calendarId = c.req.query("calendarId");
    if (!calendarId) return c.json({ error: "calendarId required" }, 400);
    await deleteEvent(calendarId, c.req.param("id"));
    return c.json({ ok: true });
  });

  return calendar;
}

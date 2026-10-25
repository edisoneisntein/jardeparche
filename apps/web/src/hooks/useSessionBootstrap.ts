import { useEffect } from "react";
import { createSession, getSessionMessages, getSessions } from "../api/client";
import type { SessionRecord, StoredMessage } from "../lib/events";
import { resetForNewSession, useJarvisStore } from "../state/jarvisStore";

interface SessionBundle {
  session: SessionRecord;
  messages: StoredMessage[];
}

let inFlight: { userId: string; promise: Promise<SessionBundle> } | null = null;

function pickLatest(sessions: SessionRecord[]): SessionRecord | null {
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => {
    const aTime = new Date(a.updatedAt ?? a.lastSeenAt ?? a.createdAt).getTime();
    const bTime = new Date(b.updatedAt ?? b.lastSeenAt ?? b.createdAt).getTime();
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
  return sorted[0] ?? null;
}

async function bootstrap(userId: string): Promise<SessionBundle> {
  const sessions = await getSessions(userId);
  const session = pickLatest(sessions) ?? (await createSession({ userId, title: "Consola J.A.R.V.I.S." }));
  const messages = await getSessionMessages(session.id);
  return { session, messages };
}

export function loadSessionBundle(userId: string): Promise<SessionBundle> {
  if (inFlight && inFlight.userId === userId) return inFlight.promise;
  const promise = bootstrap(userId).finally(() => {
    if (inFlight && inFlight.promise === promise) inFlight = null;
  });
  inFlight = { userId, promise };
  return promise;
}

export function useSessionBootstrap(userId: string): void {
  const beginSessionLoad = useJarvisStore((state) => state.beginSessionLoad);
  const setSession = useJarvisStore((state) => state.setSession);
  const setSessionError = useJarvisStore((state) => state.setSessionError);
  const setThreadFromHistory = useJarvisStore((state) => state.setThreadFromHistory);
  const recordActivity = useJarvisStore((state) => state.recordActivity);

  useEffect(() => {
    let cancelled = false;
    resetForNewSession();
    beginSessionLoad();

    loadSessionBundle(userId)
      .then((bundle) => {
        if (cancelled) return;
        setSession(bundle.session);
        setThreadFromHistory(bundle.messages);
        recordActivity({
          kind: "session",
          title: "Sesión vinculada",
          detail: `${bundle.session.title} · ${bundle.session.id.slice(0, 8)}`,
          tone: "info",
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "No se pudo establecer la sesión";
        setSession(null);
        setSessionError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, beginSessionLoad, setSession, setSessionError, setThreadFromHistory, recordActivity]);
}

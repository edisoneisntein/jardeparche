import { useCallback, useEffect, useRef } from "react";
import { getCapabilities } from "../api/client";
import { useJarvisStore } from "../state/jarvisStore";

export function useCapabilities(): () => void {
  const setCapabilities = useJarvisStore((state) => state.setCapabilities);
  const setCapabilitiesLoading = useJarvisStore((state) => state.setCapabilitiesLoading);
  const setCapabilitiesError = useJarvisStore((state) => state.setCapabilitiesError);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setCapabilitiesLoading(true);
    try {
      const capabilities = await getCapabilities();
      setCapabilities(capabilities);
      setCapabilitiesError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capacidades no disponibles";
      setCapabilities(null);
      setCapabilitiesError(message);
    } finally {
      busy.current = false;
      setCapabilitiesLoading(false);
    }
  }, [setCapabilities, setCapabilitiesError, setCapabilitiesLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return refresh;
}

// Hooks the project screens share.
import { useEffect, useState } from "react";
import { useServices } from "../services";

/**
 * Navigates once the form that asked has re-rendered clean. Call it after `useDirty`, so
 * the leave guard has already heard the form is clean when the navigation runs.
 */
export function useNavigateWhenClean(): (path: string) => void {
  const services = useServices();
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (target === null) return;
    setTarget(null);
    services.navigate(target);
  }, [services, target]);
  return setTarget;
}

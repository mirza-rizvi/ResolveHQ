import { RotateCcw } from "lucide-react";
import { useRouteError } from "react-router-dom";
import { Button } from "./ui";

export function RouteError() {
  const error = useRouteError();
  const detail = error instanceof Error ? error.message : "";
  return (
    <div className="placeholder-page" role="alert">
      <RotateCcw size={24} />
      <h1>Something went wrong</h1>
      <p>This page could not be rendered. Reloading usually clears it — the rest of your workspace is unaffected.</p>
      {detail && <span>{detail}</span>}
      <Button type="button" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  );
}

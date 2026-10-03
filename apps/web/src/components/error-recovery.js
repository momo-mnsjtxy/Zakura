import { createElement } from "react";

/**
 * Reusable failure state for route bootstraps and recoverable API panels.
 * The action stays a native button so it remains available before client-side
 * component libraries finish hydrating.
 */
export function ErrorRecovery({ title, message, onRetry, retryLabel = "重试" }) {
  return createElement(
    "div",
    { role: "alert", className: "space-y-2 text-center" },
    createElement("p", { className: "font-medium" }, title),
    createElement("p", { className: "text-sm text-muted-foreground" }, message),
    createElement(
      "button",
      {
        type: "button",
        className:
          "mt-2 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground",
        onClick: onRetry,
      },
      retryLabel,
    ),
  );
}

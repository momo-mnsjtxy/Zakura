import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorRecovery } from "../src/components/error-recovery.js";

test("recovery component renders the failure and invokes its repeated action", () => {
  let retries = 0;
  const element = ErrorRecovery({
    title: "Connection failed",
    message: "Runtime unavailable",
    onRetry: () => {
      retries += 1;
    },
  });

  const html = renderToStaticMarkup(element);
  assert.match(html, /role="alert"/);
  assert.match(html, /Connection failed/);
  assert.match(html, /Runtime unavailable/);
  assert.match(html, /重试/);

  const button = element.props.children[2];
  button.props.onClick();
  button.props.onClick();
  assert.equal(retries, 2);
});

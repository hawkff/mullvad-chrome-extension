import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveUiContext } from "./client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const view = createRoot(root);
resolveUiContext().then(
  (context) => view.render(<App context={context} />),
  () =>
    view.render(
      <p role="alert">
        Cannot determine this window's browsing context. Close and reopen this
        page.
      </p>,
    ),
);

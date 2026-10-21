import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <p>Unofficial Mullvad Chrome port — interface not installed.</p>,
);
